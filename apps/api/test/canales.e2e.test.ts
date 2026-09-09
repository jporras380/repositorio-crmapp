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
let suscripciones: string[] = [];
const CRED_IG = {
  igUserId: '17841400000000001',
  accessToken: 'EAAP-token-de-pagina-suficientemente-largo',
  appSecret: 'secreto-de-app-de-instagram-16',
};

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
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD 'crmapp_dev'`);
  await conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD 'crmapp_dev'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_auth`);
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', 'crmapp_dev'),
      authDatabaseUrl: url(DB, 'crmapp_auth', 'crmapp_dev'),
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
      suscribir: async ({ providerAccountId, accessToken }) => {
        suscripciones.push(providerAccountId);
        // Un token sin permiso de gestión no puede suscribir: se conecta igual.
        return !accessToken.startsWith('SINPERMISO');
      },
      verificarCredencialesInstagram: async ({ accessToken }) => {
        if (accessToken.startsWith('MALO')) {
          throw new ErrorDeNegocio('credenciales_rechazadas', 'Meta rechazó el token.', 422);
        }
        return { nombreDeUsuario: '@nipponautoparts' };
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

  it('un webhook de estado de plantilla, que solo trae la WABA, resuelve a la misma cuenta', async () => {
    // Meta no manda phone_number_id en estos eventos: `entry[].id` es la WABA.
    // Sin resolver por provider_account_id quedarían sin inquilino y nunca se
    // reflejaría un rechazo o una pausa.
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: CRED.wabaId,
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'REJECTED',
                message_template_id: 777,
                message_template_name: 'promo',
                message_template_language: 'es',
                reason: 'INVALID_FORMAT',
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
    const { rows } = await admin.query<{ tenant_id: string; channel_account_id: string }>(
      `SELECT tenant_id, channel_account_id FROM inbound_events ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ tenant_id: tenantId, channel_account_id: cuentaId });
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

describe('conectar Instagram (BYO)', () => {
  let cuentaIg: string;

  it('un agente no puede; el propietario sí, y el nombre viene de Meta', async () => {
    await http.post('/v1/canales/instagram').set(auth(tokenAgente)).send(CRED_IG).expect(403);
    const r = await http
      .post('/v1/canales/instagram')
      .set(auth(tokenOwner))
      .send(CRED_IG)
      .expect(201);
    cuentaIg = r.body.id;
    expect(r.body).toMatchObject({
      canal: 'instagram',
      externalId: CRED_IG.igUserId,
      status: 'connected',
      displayName: '@nipponautoparts',
    });
    expect(JSON.stringify(r.body)).not.toContain(CRED_IG.accessToken);
    const lista = await http.get('/v1/canales').set(auth(tokenOwner)).expect(200);
    expect(lista.body.map((c: { canal: string }) => c.canal).sort()).toEqual([
      'instagram',
      'whatsapp',
    ]);
  });

  it('un DM real de Instagram firmado con SU app secret entra y queda con el inquilino', async () => {
    const cuerpo = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: CRED_IG.igUserId,
          time: 1757440000000,
          messaging: [
            {
              sender: { id: '1234567890' },
              recipient: { id: CRED_IG.igUserId },
              timestamp: 1757440000123,
              message: { mid: 'mid.IG1', text: 'Hola, tienen stock?' },
            },
          ],
        },
      ],
    });
    const r = await http
      .post('/webhooks/instagram')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, CRED_IG.appSecret))
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
    expect(rows[0]).toEqual({
      tenant_id: tenantId,
      channel_account_id: cuentaIg,
      signature_ok: true,
    });
  });
});

describe('renovar credenciales', () => {
  /**
   * El token de Meta caduca (el temporal, en 24 h). Renovar tiene que dejar la
   * MISMA cuenta con secretos nuevos: desconectar y reconectar crearía otra y
   * se perderían conversaciones y plantillas.
   */
  let idWa: string;
  // Cuenta propia: otros bloques de este archivo desconectan la suya, y
  // desconectar borra los secretos.
  const PN_RENOV = '999888777666';

  beforeAll(async () => {
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ ...CRED, phoneNumberId: PN_RENOV })
      .expect(201);
    idWa = r.body.id;
  });

  it('un agente no puede renovar', async () => {
    await http
      .patch(`/v1/canales/${idWa}/credenciales`)
      .set(auth(tokenAgente))
      .send({ accessToken: 'EAAG-token-nuevo-suficientemente-largo' })
      .expect(403);
  });

  it('un token que Meta rechaza no toca lo guardado', async () => {
    const antes = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM channel_secrets WHERE channel_account_id = $1 AND kind = 'access_token'`,
      [idWa],
    );
    await http
      .patch(`/v1/canales/${idWa}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: 'MALO-token-suficientemente-largo' })
      .expect(422);
    const despues = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM channel_secrets WHERE channel_account_id = $1 AND kind = 'access_token'`,
      [idWa],
    );
    expect(despues.rows[0]!.ciphertext.equals(antes.rows[0]!.ciphertext)).toBe(true);
  });

  it('un token válido se verifica contra Meta, se guarda cifrado y la cuenta sigue siendo la misma', async () => {
    verificaciones = [];
    const antes = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM channel_secrets WHERE channel_account_id = $1 AND kind = 'access_token'`,
      [idWa],
    );
    const r = await http
      .patch(`/v1/canales/${idWa}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: 'EAAG-token-renovado-de-usuario-del-sistema' })
      .expect(200);

    // Se verificó con el external_id de la cuenta, no con uno que venga del cuerpo.
    expect(verificaciones).toEqual([`${PN_RENOV}:EAAG-tok`]);
    expect(r.body).toMatchObject({ id: idWa, status: 'connected' });
    expect(JSON.stringify(r.body)).not.toContain('EAAG-token-renovado');

    const despues = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM channel_secrets WHERE channel_account_id = $1 AND kind = 'access_token'`,
      [idWa],
    );
    expect(despues.rows[0]!.ciphertext.equals(antes.rows[0]!.ciphertext)).toBe(false);

    // La cuenta es la misma: renovar no crea otra.
    const cuentas = await admin.query(
      `SELECT 1 FROM channel_accounts WHERE tenant_id = $1 AND external_id = $2`,
      [tenantId, PN_RENOV],
    );
    expect(cuentas.rows).toHaveLength(1);
  });

  it('renovar reconecta una cuenta desconectada', async () => {
    await admin.query(`UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`, [idWa]);
    const r = await http
      .patch(`/v1/canales/${idWa}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: 'EAAG-token-otra-vez-valido-y-largo' })
      .expect(200);
    expect(r.body.status).toBe('connected');
  });

  it('una cuenta que no existe da 404', async () => {
    await http
      .patch('/v1/canales/00000000-0000-7000-8000-000000000000/credenciales')
      .set(auth(tokenOwner))
      .send({ accessToken: 'EAAG-token-suficientemente-largo-x' })
      .expect(404);
  });
});

describe('suscripción de la WABA a nuestra app', () => {
  /**
   * El fallo que costó una tarde con tráfico real: configurar la URL del
   * webhook no basta. La WABA tiene su propia lista de apps suscritas y la del
   * número de prueba venía atada a la app interna de Meta. El canal quedaba
   * «conectado» y sordo, sin ningún error.
   */
  it('conectar suscribe la WABA y lo deja registrado', async () => {
    suscripciones = [];
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ ...CRED, phoneNumberId: '111222333444' })
      .expect(201);
    expect(suscripciones).toEqual([CRED.wabaId]);
    expect(r.body.webhookSuscrito).toBe(true);
  });

  it('si el token no puede suscribir, el canal se conecta igual pero avisa', async () => {
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({
        ...CRED,
        phoneNumberId: '555666777888',
        accessToken: 'SINPERMISO-token-suficientemente-largo',
      })
      .expect(201);
    expect(r.body).toMatchObject({ status: 'connected', webhookSuscrito: false });

    // Y renovar con un token que sí puede lo arregla, sin reconectar.
    const arreglado = await http
      .patch(`/v1/canales/${r.body.id}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: 'EAAG-token-con-permiso-de-gestion' })
      .expect(200);
    expect(arreglado.body).toMatchObject({ id: r.body.id, webhookSuscrito: true });
  });
});
