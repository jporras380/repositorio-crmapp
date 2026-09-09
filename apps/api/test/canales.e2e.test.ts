/**
 * Conexión BYO de WhatsApp de punta a punta, por HTTP real.
 *
 * El recorrido que cierra fase 1: el cliente pega sus credenciales → se
 * verifican contra Meta (aquí, un verificador falso) → se guardan CIFRADAS →
 * un webhook firmado con ese app secret entra por la ingesta REAL de
 * WhatsApp y queda persistido con su inquilino → el resolver devuelve el token
 * al adaptador. Sin Meta, pero con el mismo código que en producción.
 */
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';
import { ErrorDeNegocio } from '../src/auth/auth.service.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_canales';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

const CRED = {
  phoneNumberId: '111222333444555',
  wabaId: '999888777666555',
  accessToken: 'EAAG-token-de-prueba-suficientemente-largo',
  appSecret: 'app-secret-de-prueba-0123456789',
};
const VERIFY_TOKEN = 'mi-verify-token-elegido';

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tokenOwner: string;
let tokenAgente: string;
let tenantId: string;
let verificaciones: string[] = [];

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const firmar = (cuerpo: string, secreto: string) =>
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
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD 'crmapp_test_app'`);
  await conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD 'crmapp_test_auth'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_auth`);
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', 'crmapp_test_app'),
      authDatabaseUrl: url(DB, 'crmapp_auth', 'crmapp_test_auth'),
      jwtSecret: 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres',
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
      webhookVerifyToken: VERIFY_TOKEN,
      // Verificador falso: registra qué se verificó y rechaza un token concreto.
      verificarCredenciales: async ({ phoneNumberId, accessToken }) => {
        verificaciones.push(`${phoneNumberId}:${accessToken.slice(0, 8)}`);
        if (accessToken.startsWith('MALO')) {
          throw new ErrorDeNegocio(
            'credenciales_rechazadas',
            'Meta rechazó las credenciales.',
            422,
          );
        }
        return { numeroMostrado: '+51 929 833 609', nombreVerificado: 'Nippon Autoparts' };
      },
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());

  const alta = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: 'Nippon',
      slug: 'nippon',
      email: 'owner@nippon.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Owner',
    })
    .expect(201);
  tokenOwner = alta.body.token;
  tenantId = alta.body.tenantId;

  const inv = await http
    .post('/v1/invitaciones')
    .set(auth(tokenOwner))
    .send({ email: 'agente@nippon.test', rol: 'agent' })
    .expect(201);
  const acc = await http
    .post('/v1/invitaciones/aceptar')
    .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: 'Agente' })
    .expect(200);
  tokenAgente = acc.body.token;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('conectar WhatsApp (BYO)', () => {
  let cuentaId: string;

  it('un agente no puede conectar canales', async () => {
    const r = await http.post('/v1/canales/whatsapp').set(auth(tokenAgente)).send(CRED).expect(403);
    expect(r.body.codigo).toBe('sin_permiso');
  });

  it('credenciales rechazadas por Meta: 422 y no se guarda nada', async () => {
    await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ ...CRED, accessToken: 'MALO-token-suficientemente-largo' })
      .expect(422);
    const { rows } = await admin.query(`SELECT 1 FROM channel_accounts WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('con credenciales válidas: 201, verificadas antes de guardar, y nombre de Meta', async () => {
    verificaciones = [];
    const r = await http.post('/v1/canales/whatsapp').set(auth(tokenOwner)).send(CRED).expect(201);
    cuentaId = r.body.id;
    expect(verificaciones).toEqual([`${CRED.phoneNumberId}:EAAG-tok`]);
    expect(r.body).toMatchObject({
      canal: 'whatsapp',
      externalId: CRED.phoneNumberId,
      providerAccountId: CRED.wabaId,
      status: 'connected',
      displayName: '+51 929 833 609',
    });
    // La respuesta NUNCA devuelve el token ni el secret.
    expect(JSON.stringify(r.body)).not.toContain(CRED.accessToken);
    expect(JSON.stringify(r.body)).not.toContain(CRED.appSecret);
  });

  it('los secretos están en la base CIFRADOS, no en claro', async () => {
    const { rows } = await admin.query<{ kind: string; ciphertext: Buffer; key_version: number }>(
      `SELECT kind, ciphertext, key_version FROM channel_secrets WHERE channel_account_id = $1 ORDER BY kind`,
      [cuentaId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['access_token', 'app_secret']);
    for (const r of rows) {
      expect(r.ciphertext.toString('utf8')).not.toContain('EAAG');
      expect(r.ciphertext.toString('utf8')).not.toContain('app-secret');
      expect(r.key_version).toBe(1);
    }
  });

  it('el listado muestra la cuenta sin secretos', async () => {
    const r = await http.get('/v1/canales').set(auth(tokenOwner)).expect(200);
    expect(r.body).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/token|secret/i);
  });

  it('el mismo número no se puede conectar dos veces, ni desde otra cuenta', async () => {
    expect(
      (await http.post('/v1/canales/whatsapp').set(auth(tokenOwner)).send(CRED).expect(409)).body
        .codigo,
    ).toBe('numero_ya_conectado');
    const otra = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Otra',
        slug: 'otra',
        email: 'x@otra.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Otro',
      })
      .expect(201);
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(otra.body.token))
      .send(CRED)
      .expect(409);
    // El mensaje no dice en qué cuenta está: sería filtrar datos ajenos.
    expect(r.body.mensaje).not.toMatch(/nippon/i);
  });

  it('un webhook REAL de Meta firmado con el app secret entra y queda con su inquilino', async () => {
    // Recorrido completo: resolverCuenta lee la cuenta con el rol de solo
    // lectura, descifra el app secret, verifica la firma, y la ingesta real de
    // WhatsApp aplana el payload de Meta.
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CRED.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '51929833609',
                  phone_number_id: CRED.phoneNumberId,
                },
                contacts: [{ profile: { name: 'Lucho' }, wa_id: '51999888777' }],
                messages: [
                  {
                    from: '51999888777',
                    id: 'wamid.REAL1',
                    timestamp: '1757440000',
                    type: 'text',
                    text: { body: 'Ga16 si tiene me indica el precio' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const r = await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, CRED.appSecret))
      .send(cuerpo)
      .expect(200);
    expect(r.body).toEqual({ recibido: true, eventos: 1 });

    const { rows } = await admin.query<{
      tenant_id: string;
      channel_account_id: string;
      signature_ok: boolean;
    }>(
      `SELECT tenant_id, channel_account_id, signature_ok FROM inbound_events ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId,
      channel_account_id: cuentaId,
      signature_ok: true,
    });
    const outbox = await admin.query(
      `SELECT 1 FROM outbox WHERE tenant_id = $1 AND event_type = 'webhook.recibido'`,
      [tenantId],
    );
    expect(outbox.rows.length).toBeGreaterThan(0);
  });

  it('firmado con OTRO secret se rechaza: la firma se verifica con el secret de ESA cuenta', async () => {
    const cuerpo = JSON.stringify({
      entry: [
        {
          changes: [{ value: { metadata: { phone_number_id: CRED.phoneNumberId }, messages: [] } }],
        },
      ],
    });
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, 'otro-secret'))
      .send(cuerpo)
      .expect(401);
  });

  it('el reto de alta responde con el verify token configurado', async () => {
    const r = await http
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '4242' })
      .expect(200);
    expect(r.text).toBe('4242');
  });

  it('desconectar borra los secretos y el webhook deja de resolverse', async () => {
    await http.delete(`/v1/canales/${cuentaId}`).set(auth(tokenOwner)).expect(204);
    const { rows } = await admin.query(
      `SELECT 1 FROM channel_secrets WHERE channel_account_id = $1`,
      [cuentaId],
    );
    expect(rows).toHaveLength(0);

    const cuerpo = JSON.stringify({
      entry: [
        {
          changes: [{ value: { metadata: { phone_number_id: CRED.phoneNumberId }, messages: [] } }],
        },
      ],
    });
    await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, CRED.appSecret))
      .send(cuerpo)
      .expect(401);
  });
});
