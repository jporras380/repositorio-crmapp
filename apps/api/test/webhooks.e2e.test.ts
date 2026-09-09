/**
 * Ingesta de webhooks (ARCH §7).
 *
 * Va por HTTP real porque lo que se prueba —que la firma se calcula sobre los
 * bytes crudos, que el 200 llega rápido, que el crudo se persiste incluso
 * cuando la firma falla— solo existe atravesando el servidor de verdad.
 */
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';
import type { CuentaResuelta } from '../src/webhooks/ingesta.service.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_webhooks';
const CLAVE_APP = 'crmapp_test_app';
const CLAVE_AUTH = 'crmapp_test_auth';
const SECRETO = 'secreto-de-la-app-de-meta';
const VERIFY_TOKEN = 'token-de-verificacion-elegido-por-nosotros';

const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tenantId: string;
let channelAccountId: string;

/** Firma como lo haría Meta: HMAC-SHA256 sobre los bytes exactos del cuerpo. */
const firmar = (cuerpo: string, secreto = SECRETO) =>
  'sha256=' + createHmac('sha256', secreto).update(Buffer.from(cuerpo, 'utf8')).digest('hex');

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();

  await migrar(url(DB));

  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${CLAVE_APP}'`);
  await conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD '${CLAVE_AUTH}'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_auth`);

  const { rows: t } = await conf.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
  );
  tenantId = t[0]!.id;
  const { rows: ca } = await conf.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
     VALUES ($1, 'whatsapp', 'pn-999', 'WA Acme') RETURNING id`,
    [tenantId],
  );
  channelAccountId = ca[0]!.id;
  await conf.end();

  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', CLAVE_APP),
      authDatabaseUrl: url(DB, 'crmapp_auth', CLAVE_AUTH),
      jwtSecret: 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres',
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
      modoSandbox: true,
      webhookVerifyToken: VERIFY_TOKEN,
      // En produccion esto leera channel_secrets y descifrara con
      // @crmapp/crypto. Aqui se inyecta para no mezclar dos cosas en un test.
      resolverCuenta: async (_canal, externalAccountId): Promise<CuentaResuelta | null> =>
        externalAccountId === 'pn-999' ? { channelAccountId, tenantId, secreto: SECRETO } : null,
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

beforeEach(async () => {
  await admin.query('TRUNCATE inbound_events, outbox');
});

const cuerpoValido = (texto = 'hola') =>
  JSON.stringify({
    cuenta: 'pn-999',
    eventos: [
      {
        clase: 'mensaje',
        externalMessageId: 'wamid.ABC123',
        externalUserId: 'wa-user-1',
        tipo: 'text',
        texto,
        nombre: 'Ana',
      },
    ],
  });

const contar = async (tabla: string): Promise<number> => {
  const { rows } = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`);
  return rows[0]!.n;
};

describe('reto de alta del webhook', () => {
  it('devuelve el challenge en texto plano', async () => {
    // Meta espera el valor tal cual. Devolverlo como JSON hace que el alta
    // falle sin decir por que.
    const r = await http
      .get('/webhooks/whatsapp')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '12345',
      })
      .expect(200);
    expect(r.text).toBe('12345');
  });

  it('rechaza un verify_token incorrecto', async () => {
    await http
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '12345' })
      .expect(403);
  });

  it('rechaza si el modo no es subscribe', async () => {
    await http
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'x' })
      .expect(403);
  });
});

describe('recepción con firma válida', () => {
  it('responde 200 y persiste el crudo', async () => {
    const cuerpo = cuerpoValido();
    const r = await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(200);

    expect(r.body).toEqual({ recibido: true, eventos: 1 });

    const { rows } = await admin.query<{
      signature_ok: boolean;
      status: string;
      tenant_id: string;
      channel_account_id: string;
      raw: { cuenta: string };
    }>(`SELECT signature_ok, status, tenant_id, channel_account_id, raw FROM inbound_events`);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.signature_ok).toBe(true);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.channel_account_id).toBe(channelAccountId);
    expect(rows[0]!.raw.cuenta).toBe('pn-999');
  });

  it('escribe el evento en el outbox, no en la cola directamente', async () => {
    // Requisito 8.2: encolar aqui dejaria el hueco entre commit y publish que
    // el patron outbox existe para cerrar.
    const cuerpo = cuerpoValido();
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(200);

    const { rows } = await admin.query<{ event_type: string; tenant_id: string }>(
      `SELECT event_type, tenant_id FROM outbox`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('webhook.recibido');
    expect(rows[0]!.tenant_id).toBe(tenantId);
  });

  it('responde en mucho menos de un segundo', async () => {
    // El presupuesto del ARCH §7. Si se supera, Meta reintenta y multiplica la
    // carga justo cuando el sistema ya va mal.
    const cuerpo = cuerpoValido();
    const t0 = Date.now();
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('un reenvío del mismo webhook se acepta otra vez', async () => {
    // Meta reenvia si duda del 200. Aqui NO se deduplica: la deduplicacion es
    // por external_message_id contra message_keys, y ocurre en el worker
    // (ADR-006). Rechazarlo aqui perderia eventos legitimos que comparten
    // entrega.
    const cuerpo = cuerpoValido();
    const firma = firmar(cuerpo);
    for (let i = 0; i < 2; i++) {
      await http
        .post('/webhooks/whatsapp')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', firma)
        .send(cuerpo)
        .expect(200);
    }
    expect(await contar('inbound_events')).toBe(2);
  });
});

describe('firma inválida', () => {
  it('devuelve 401', async () => {
    const cuerpo = cuerpoValido();
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, 'secreto-equivocado'))
      .send(cuerpo)
      .expect(401);
  });

  it('pero deja rastro con signature_ok = false', async () => {
    // Sin ese rastro, un secreto rotado a medias se manifiesta como "los
    // mensajes no llegan" y no hay forma de distinguirlo de un fallo de red.
    const cuerpo = cuerpoValido();
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, 'secreto-equivocado'))
      .send(cuerpo)
      .expect(401);

    const { rows } = await admin.query<{ signature_ok: boolean; status: string }>(
      `SELECT signature_ok, status FROM inbound_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signature_ok).toBe(false);
    expect(rows[0]!.status).toBe('failed');
  });

  it('no publica nada en el outbox', async () => {
    const cuerpo = cuerpoValido();
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, 'malo'))
      .send(cuerpo)
      .expect(401);
    expect(await contar('outbox')).toBe(0);
  });

  it('sin cabecera de firma también es 401', async () => {
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .send(cuerpoValido())
      .expect(401);
  });

  it('una firma con formato raro no rompe nada', async () => {
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'esto-no-es-una-firma')
      .send(cuerpoValido())
      .expect(401);
  });
});

describe('la firma se calcula sobre los BYTES CRUDOS', () => {
  it('un cuerpo con Unicode y espacios raros valida igual', async () => {
    // El fallo clasico de este camino: firmar sobre el JSON re-serializado.
    // El orden de las claves y el escapado de Unicode cambian, y la firma deja
    // de coincidir con un error que parece de clave y no lo es.
    const cuerpo = JSON.stringify({
      cuenta: 'pn-999',
      eventos: [
        {
          clase: 'mensaje',
          externalMessageId: 'wamid.UNICODE',
          externalUserId: 'u1',
          tipo: 'text',
          texto: 'Hola 👋 ñandú — "comillas" y \\ barras',
        },
      ],
    });

    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(200);

    const { rows } = await admin.query<{ raw: { eventos: [{ texto: string }] } }>(
      `SELECT raw FROM inbound_events`,
    );
    expect(rows[0]!.raw.eventos[0]!.texto).toContain('👋');
  });

  it('cambiar un solo byte del cuerpo invalida la firma', async () => {
    const cuerpo = cuerpoValido('hola');
    const firmaDeOtroCuerpo = firmar(cuerpoValido('holA'));
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmaDeOtroCuerpo)
      .send(cuerpo)
      .expect(401);
  });
});

describe('cuenta desconocida', () => {
  it('se registra pero no se acepta', async () => {
    // Puede ser una desconexion a medias: sin rastro no se diagnostica.
    const cuerpo = JSON.stringify({ cuenta: 'pn-DESCONOCIDA', eventos: [] });
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(401);

    const { rows } = await admin.query<{ tenant_id: string | null; signature_ok: boolean }>(
      `SELECT tenant_id, signature_ok FROM inbound_events`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBeNull();
    expect(rows[0]!.signature_ok).toBe(false);
  });
});

describe('payload malformado', () => {
  it('un JSON roto lo rechaza el parser antes de llegar a nosotros', async () => {
    // Trade-off asumido: express devuelve 400 y el cuerpo NO queda registrado.
    // Se podria desactivar su parser para capturarlo, pero no compensa: Meta
    // no envia JSON invalido, y si lo hiciera, un 400 provoca reintento — no
    // perdida silenciosa, que es lo unico inaceptable. El servicio de ingesta
    // sigue tolerando un cuerpo no parseable si se le llama directamente.
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar('{roto'))
      .send('{roto')
      .expect(400);
    expect(await contar('inbound_events')).toBe(0);
  });

  it('un evento de tipo desconocido no invalida los demás del lote', async () => {
    // Meta anade tipos nuevos sin avisar.
    const cuerpo = JSON.stringify({
      cuenta: 'pn-999',
      eventos: [
        { clase: 'tipo_del_futuro', algo: 1 },
        { clase: 'mensaje', externalMessageId: 'wamid.OK', externalUserId: 'u', tipo: 'text' },
      ],
    });
    const r = await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo))
      .send(cuerpo)
      .expect(200);
    expect(r.body.eventos).toBe(1);
  });
});

describe('canal desconocido', () => {
  it('no existe adaptador para un canal inventado', async () => {
    await http
      .post('/webhooks/telegram')
      .set('content-type', 'application/json')
      .send(cuerpoValido())
      .expect(401);
  });
});
