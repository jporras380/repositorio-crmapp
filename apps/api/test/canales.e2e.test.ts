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
import { migrar, reintentandoSiChocaElCatalogo } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';
import { ErrorDeNegocio } from '../src/auth/auth.service.js';
import type { CanalesService } from '../src/canales/canales.service.js';
import { TOKEN_CANALES } from '../src/tokens.js';

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

const IG_DE_PAGINA = '17841400000000099';
const TOKEN_DE_PAGINA = 'EAAP-token-de-pagina-devuelto-por-me-accounts';
let paginasSuscritas: string[] = [];
let camposSuscritos: string[] = [];
const PAGINA_FB = '1122334455667788';

// «Conectar con Meta» (ADR-015): la app de la plataforma y un Meta de mentira
// que apunta lo que se le pide.
const META = {
  appId: '900100200300',
  appSecret: 'clave-secreta-de-la-app-de-la-plataforma',
  configWhatsapp: 'CFG-WHATSAPP',
  configPaginas: 'CFG-PAGINAS',
};
const TOKEN_DE_PLATAFORMA = 'PLATAFORMA-token-de-negocio-que-devuelve-meta';
/** Sigue en el WhatsApp Business del celular: coexistencia. */
const NUMERO_EN_LA_APP = '700000000000001';
/** Dado de alta en la ventana de Meta: hay que registrarlo. */
const NUMERO_NUEVO = '700000000000002';
const WABA_DE_PLATAFORMA = '800000000000001';
const PAGINA_DE_PLATAFORMA = '900000000000001';
let intercambios: string[] = [];
let registros: { phoneNumberId: string; pin: string }[] = [];
let sincronizaciones: string[] = [];

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
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD 'crmapp_dev'`),
  );
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD 'crmapp_dev'`),
  );
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
      // Descubridor falso: un token de USUARIO ve una página con Instagram; el
      // resto de tokens no ve ninguna (y se usa el verificador de siempre).
      descubridor: {
        whatsapp: async ({ accessToken, wabaId }) => {
          if (accessToken.startsWith('PLATAFORMA')) {
            return {
              necesitaWaba: false,
              caducaEn: null,
              cuentas: [
                {
                  wabaId: wabaId ?? WABA_DE_PLATAFORMA,
                  nombre: 'Hotel con la app',
                  numeros: [NUMERO_EN_LA_APP, NUMERO_NUEVO].map((phoneNumberId, i) => ({
                    phoneNumberId,
                    numero: `+51 955 000 00${i}`,
                    nombreVerificado: 'Hotel con la app',
                    calidad: 'GREEN',
                  })),
                },
              ],
            };
          }
          if (accessToken.startsWith('MALO')) {
            throw new ErrorDeNegocio('credenciales_rechazadas', 'Meta rechazó el token.', 422);
          }
          if (accessToken.startsWith('SINLISTA') && !wabaId) {
            return { cuentas: [], necesitaWaba: true, caducaEn: null };
          }
          return {
            necesitaWaba: false,
            caducaEn: new Date('2026-09-15T12:00:00Z'),
            cuentas: [
              {
                wabaId: wabaId ?? CRED.wabaId,
                nombre: 'Paraíso Barranca',
                numeros: [
                  {
                    phoneNumberId: CRED.phoneNumberId,
                    numero: '+51 929 833 609',
                    nombreVerificado: 'El Paraíso',
                    calidad: 'GREEN',
                  },
                  {
                    phoneNumberId: '222333444555666',
                    numero: '+51 900 000 000',
                    nombreVerificado: 'El Paraíso',
                    calidad: null,
                  },
                ],
              },
            ],
          };
        },
        instagram: async ({ accessToken }) =>
          accessToken.startsWith('USUARIO')
            ? [
                {
                  igUserId: IG_DE_PAGINA,
                  usuario: '@paraisobarranca',
                  paginaId: 'PAGINA-1',
                  pagina: 'Paraíso Barranca',
                  tokenDePagina: TOKEN_DE_PAGINA,
                },
              ]
            : [],
        paginas: async ({ accessToken }) =>
          accessToken.startsWith('PLATAFORMA')
            ? [
                {
                  paginaId: PAGINA_DE_PLATAFORMA,
                  pagina: 'Hotel con la app',
                  tokenDePagina: TOKEN_DE_PAGINA,
                  igUserId: '17841400000000777',
                  usuario: '@hotelconlaapp',
                },
              ]
            : accessToken.startsWith('USUARIO')
              ? [
                  {
                    paginaId: PAGINA_FB,
                    pagina: 'Apart Hotel El Paraíso',
                    tokenDePagina: TOKEN_DE_PAGINA,
                    igUserId: null,
                    usuario: null,
                  },
                ]
              : [],
        suscribirPagina: async ({ paginaId, campos }) => {
          paginasSuscritas.push(paginaId);
          camposSuscritos.push([...campos].sort().join(','));
          return true;
        },
      },
      meta: META,
      plataformaMeta: {
        intercambiarCodigo: async (code) => {
          intercambios.push(code);
          if (code.startsWith('CADUCADO')) {
            throw new ErrorDeNegocio(
              'codigo_de_meta_rechazado',
              'Meta no aceptó la conexión.',
              422,
            );
          }
          return TOKEN_DE_PLATAFORMA;
        },
        estaEnLaApp: async ({ phoneNumberId }) => phoneNumberId === NUMERO_EN_LA_APP,
        registrarNumero: async ({ phoneNumberId, pin }) => {
          registros.push({ phoneNumberId, pin });
          return true;
        },
        pedirSincronizacion: async ({ phoneNumberId, tipo }) => {
          sincronizaciones.push(`${phoneNumberId}:${tipo}`);
          return true;
        },
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
  // Estos tests prueban CÓMO se conecta, y conectan WhatsApp, Instagram y
  // Facebook en la misma cuenta: con Starter (un canal) el segundo daría 402.
  // El tope tiene su propio bloque al final.
  await admin.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'scale')
      WHERE tenant_id = $1`,
    [tenantId],
  );

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

describe('conectar eligiendo, sin copiar ids (P-26, opción A)', () => {
  it('un agente no puede descubrir cuentas', async () => {
    await http
      .post('/v1/canales/whatsapp/descubrir')
      .set(auth(tokenAgente))
      .send({ accessToken: CRED.accessToken })
      .expect(403);
  });

  it('con solo el token lista los números, marca los ya conectados y no devuelve el token', async () => {
    // CRED.phoneNumberId se conectó y se desconectó arriba; se reconecta para
    // que cuente como conectado aquí.
    await http
      .patch(`/v1/canales/${(await cuentaPorNumero(CRED.phoneNumberId))!}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: CRED.accessToken, appSecret: CRED.appSecret })
      .expect(200);

    const r = await http
      .post('/v1/canales/whatsapp/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: CRED.accessToken })
      .expect(200);
    expect(r.body.necesitaWaba).toBe(false);
    expect(r.body.caducaEn).toBe('2026-09-15T12:00:00.000Z');
    expect(
      r.body.cuentas[0].numeros.map((n: { phoneNumberId: string; yaConectado: boolean }) => [
        n.phoneNumberId,
        n.yaConectado,
      ]),
    ).toEqual([
      [CRED.phoneNumberId, true],
      ['222333444555666', false],
    ]);
    expect(JSON.stringify(r.body)).not.toContain(CRED.accessToken);
  });

  it('si Meta no deja listar, lo dice; con el id de WABA sí lista', async () => {
    const sin = await http
      .post('/v1/canales/whatsapp/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'SINLISTA-token-suficientemente-largo' })
      .expect(200);
    expect(sin.body).toEqual({ cuentas: [], necesitaWaba: true, caducaEn: null });

    const con = await http
      .post('/v1/canales/whatsapp/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'SINLISTA-token-suficientemente-largo', wabaId: '123456789' })
      .expect(200);
    expect(con.body.cuentas[0].wabaId).toBe('123456789');
  });

  it('un token rechazado es 422', async () => {
    await http
      .post('/v1/canales/whatsapp/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'MALO-token-suficientemente-largo' })
      .expect(422);
  });

  it('Instagram: lista las cuentas SIN el token de página', async () => {
    const r = await http
      .post('/v1/canales/instagram/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'USUARIO-token-suficientemente-largo' })
      .expect(200);
    expect(r.body).toEqual([
      {
        igUserId: IG_DE_PAGINA,
        usuario: '@paraisobarranca',
        paginaId: 'PAGINA-1',
        pagina: 'Paraíso Barranca',
        yaConectado: false,
      },
    ]);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_DE_PAGINA);
  });

  it('Instagram con token de usuario: guarda el de PÁGINA y suscribe la página', async () => {
    paginasSuscritas = [];
    const r = await http
      .post('/v1/canales/instagram')
      .set(auth(tokenOwner))
      .send({
        igUserId: IG_DE_PAGINA,
        accessToken: 'USUARIO-token-suficientemente-largo',
        appSecret: CRED_IG.appSecret,
      })
      .expect(201);
    expect(r.body).toMatchObject({
      canal: 'instagram',
      providerAccountId: 'PAGINA-1',
      displayName: '@paraisobarranca',
      webhookSuscrito: true,
    });
    expect(paginasSuscritas).toEqual(['PAGINA-1']);

    // Lo que usará el adaptador para enviar es el token de página.
    const canales = app.get<CanalesService>(TOKEN_CANALES);
    const cred = await canales.resolverCredencialesInstagram(r.body.id);
    expect(cred).toEqual({ igUserId: IG_DE_PAGINA, accessToken: TOKEN_DE_PAGINA });
  });
});

async function cuentaPorNumero(externalId: string): Promise<string | undefined> {
  const { rows } = await admin.query<{ id: string }>(
    `SELECT id FROM channel_accounts WHERE tenant_id = $1 AND external_id = $2`,
    [tenantId, externalId],
  );
  return rows[0]?.id;
}

describe('conectar Facebook (Messenger y comentarios de página)', () => {
  it('un agente no puede; el token de usuario lista las páginas SIN su token', async () => {
    await http
      .post('/v1/canales/facebook/descubrir')
      .set(auth(tokenAgente))
      .send({ accessToken: 'USUARIO-token-suficientemente-largo' })
      .expect(403);
    const r = await http
      .post('/v1/canales/facebook/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'USUARIO-token-suficientemente-largo' })
      .expect(200);
    expect(r.body).toEqual([
      { paginaId: PAGINA_FB, pagina: 'Apart Hotel El Paraíso', yaConectado: false },
    ]);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN_DE_PAGINA);
  });

  it('conectar guarda el token de PÁGINA y suscribe messages y feed', async () => {
    paginasSuscritas = [];
    camposSuscritos = [];
    const r = await http
      .post('/v1/canales/facebook')
      .set(auth(tokenOwner))
      .send({
        paginaId: PAGINA_FB,
        accessToken: 'USUARIO-token-suficientemente-largo',
        appSecret: CRED_IG.appSecret,
      })
      .expect(201);
    expect(r.body).toMatchObject({
      canal: 'facebook',
      externalId: PAGINA_FB,
      displayName: 'Apart Hotel El Paraíso',
      webhookSuscrito: true,
    });
    expect(paginasSuscritas).toEqual([PAGINA_FB]);
    expect(camposSuscritos).toEqual(['feed,messages']);

    const canales = app.get<CanalesService>(TOKEN_CANALES);
    expect(await canales.resolverCredencialesFacebook(r.body.id)).toEqual({
      pageId: PAGINA_FB,
      accessToken: TOKEN_DE_PAGINA,
    });

    const lista = await http
      .post('/v1/canales/facebook/descubrir')
      .set(auth(tokenOwner))
      .send({ accessToken: 'USUARIO-token-suficientemente-largo' })
      .expect(200);
    expect(lista.body[0].yaConectado).toBe(true);
  });

  it('si Instagram ya cuelga de esa página, la suscripción conserva sus comentarios', async () => {
    // Meta reemplaza la lista de campos: suscribir solo messages,feed dejaría
    // de mandar los comentarios de Instagram de la misma página.
    await admin.query(
      `UPDATE channel_accounts SET provider_account_id = $1, status = 'connected'
        WHERE tenant_id = $2 AND channel = 'instagram'`,
      [PAGINA_FB, tenantId],
    );
    camposSuscritos = [];
    const fb = await admin.query<{ id: string }>(
      `SELECT id FROM channel_accounts WHERE channel = 'facebook' AND external_id = $1`,
      [PAGINA_FB],
    );
    await http
      .patch(`/v1/canales/${fb.rows[0]!.id}/credenciales`)
      .set(auth(tokenOwner))
      .send({ accessToken: 'USUARIO-token-renovado-suficientemente-largo' })
      .expect(200);
    expect(camposSuscritos).toEqual(['comments,feed,messages']);
  });

  it('un token que no ve la página: 422 y no se guarda nada', async () => {
    await http
      .post('/v1/canales/facebook')
      .set(auth(tokenOwner))
      .send({
        paginaId: '9999999999',
        accessToken: 'OTRO-token-suficientemente-largo',
        appSecret: CRED_IG.appSecret,
      })
      .expect(422);
    const { rows } = await admin.query(
      `SELECT 1 FROM channel_accounts WHERE channel = 'facebook' AND external_id = '9999999999'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('un mensaje de Messenger firmado con SU app secret entra con el inquilino', async () => {
    const cuerpo = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGINA_FB,
          time: 1757440000000,
          messaging: [
            {
              sender: { id: 'PSID-rosa' },
              recipient: { id: PAGINA_FB },
              timestamp: 1757440000123,
              message: { mid: 'm_FB1', text: 'Hola, tienen habitación?' },
            },
          ],
        },
      ],
    });
    const r = await http
      .post('/webhooks/facebook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, CRED_IG.appSecret))
      .send(cuerpo)
      .expect(200);
    expect(r.body).toEqual({ recibido: true, eventos: 1 });
    const { rows } = await admin.query<{ tenant_id: string; channel: string }>(
      `SELECT tenant_id, channel FROM inbound_events ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ tenant_id: tenantId, channel: 'facebook' });
  });
});

/**
 * El tope de canales del plan (`canales`).
 *
 * Bloquear una conexión NUEVA no corta nada de lo que ya llega, que es lo que
 * ADR-011 prohíbe: los canales conectados siguen recibiendo y enviando.
 */
describe('el tope de canales del plan', () => {
  let tokenChico: string;
  const PN = (n: number) => `55500000000000${n}`;
  const conectar = (n: number) =>
    http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenChico))
      .send({ ...CRED, phoneNumberId: PN(n), wabaId: `77700000000000${n}` });

  beforeAll(async () => {
    // Cuenta nueva, en Starter: un canal.
    const r = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Hostal Chico',
        slug: 'hostal-chico',
        email: 'owner@chico.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Dueña',
      })
      .expect(201);
    tokenChico = r.body.token;
  });

  it('el primero entra; el segundo se rechaza con el tope y lo que hay', async () => {
    await conectar(1).expect(201);
    verificaciones = [];
    suscripciones = [];
    const r = await conectar(2).expect(402);
    expect(r.body.codigo).toBe('limite_de_canales');
    expect(r.body.tope).toBe(1);
    expect(r.body.conectados).toBe(1);
    // Se rechaza ANTES de hablar con Meta: ni se verifica ni se suscribe la WABA.
    expect(verificaciones).toEqual([]);
    expect(suscripciones).toEqual([]);
  });

  it('desconectar libera la plaza', async () => {
    const lista = await http.get('/v1/canales').set(auth(tokenChico)).expect(200);
    await http.delete(`/v1/canales/${lista.body[0].id}`).set(auth(tokenChico)).expect(204);
    await conectar(2).expect(201);
  });

  it('renovar el desconectado NO cuela un segundo canal por la puerta de atrás', async () => {
    const lista = await http.get('/v1/canales').set(auth(tokenChico)).expect(200);
    const desconectado = lista.body.find((c: { status: string }) => c.status === 'disconnected');
    const r = await http
      .patch(`/v1/canales/${desconectado.id}/credenciales`)
      .set(auth(tokenChico))
      .send({ accessToken: CRED.accessToken })
      .expect(402);
    expect(r.body.codigo).toBe('limite_de_canales');
  });

  it('subir de plan abre el cupo, sin tocar nada más', async () => {
    await admin.query(
      `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'growth')
        WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'hostal-chico')`,
    );
    await conectar(3).expect(201);
  });
});

/**
 * «Conectar con Meta» (ADR-015): la app es de la plataforma, y el dueño no
 * pega nada. Lo que se prueba es que el token no pasa en claro por el
 * navegador, que el sobre no vale en otra cuenta, y que un canal conectado así
 * verifica sus webhooks con la clave de la PLATAFORMA.
 */
describe('conectar con la app de Meta de la plataforma', () => {
  let credencial: string;
  let tokenOtra: string;

  beforeAll(async () => {
    const r = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Otra con Meta',
        slug: 'otra-con-meta',
        email: 'owner@otrameta.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Otra',
      })
      .expect(201);
    tokenOtra = r.body.token;
  });

  it('la pantalla recibe los ids públicos de la app, y NUNCA su clave secreta', async () => {
    const r = await http.get('/v1/canales/meta').set(auth(tokenOwner)).expect(200);
    expect(r.body).toEqual({
      disponible: true,
      appId: META.appId,
      version: 'v21.0',
      configWhatsapp: META.configWhatsapp,
      configPaginas: META.configPaginas,
    });
    expect(JSON.stringify(r.body)).not.toContain(META.appSecret);
  });

  it('un agente no abre una conexión con Meta', async () => {
    await http
      .post('/v1/canales/meta/whatsapp')
      .set(auth(tokenAgente))
      .send({ code: 'CODIGO-DE-META-1', wabaId: WABA_DE_PLATAFORMA })
      .expect(403);
  });

  it('el código se cambia por los números, y el token vuelve SELLADO, no en claro', async () => {
    intercambios = [];
    const r = await http
      .post('/v1/canales/meta/whatsapp')
      .set(auth(tokenOwner))
      .send({ code: 'CODIGO-DE-META-1', wabaId: WABA_DE_PLATAFORMA })
      .expect(200);
    expect(intercambios).toEqual(['CODIGO-DE-META-1']);
    expect(
      r.body.cuentas[0].numeros.map((n: { phoneNumberId: string }) => n.phoneNumberId),
    ).toEqual([NUMERO_EN_LA_APP, NUMERO_NUEVO]);
    credencial = r.body.credencial;
    // Ni en la respuesta, ni dentro del sobre una vez decodificado.
    expect(JSON.stringify(r.body)).not.toContain('PLATAFORMA-token');
    expect(Buffer.from(credencial, 'base64url').toString('utf8')).not.toContain('PLATAFORMA-token');
  });

  it('un código que Meta ya no acepta: 422, y no se guarda nada', async () => {
    const r = await http
      .post('/v1/canales/meta/whatsapp')
      .set(auth(tokenOwner))
      .send({ code: 'CADUCADO-codigo-viejo', wabaId: WABA_DE_PLATAFORMA })
      .expect(422);
    expect(r.body.codigo).toBe('codigo_de_meta_rechazado');
  });

  it('el sobre de una cuenta no vale en otra, ni uno manipulado', async () => {
    const ajeno = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOtra))
      .send({ phoneNumberId: NUMERO_EN_LA_APP, wabaId: WABA_DE_PLATAFORMA, credencial })
      .expect(422);
    expect(ajeno.body.codigo).toBe('conexion_caducada');

    const roto = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({
        phoneNumberId: NUMERO_EN_LA_APP,
        wabaId: WABA_DE_PLATAFORMA,
        credencial: 'AAAAAA' + credencial.slice(6),
      })
      .expect(422);
    expect(roto.body.codigo).toBe('conexion_caducada');
  });

  it('coexistencia: el número sigue en el celular, así que NO se registra de nuevo', async () => {
    registros = [];
    sincronizaciones = [];
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ phoneNumberId: NUMERO_EN_LA_APP, wabaId: WABA_DE_PLATAFORMA, credencial })
      .expect(201);
    expect(r.body.conectadoVia).toBe('plataforma');
    // Registrarlo otra vez lo sacaría de la app del celular.
    expect(registros).toEqual([]);
    // Y se piden la agenda y los chats que el dueño compartió, EN ESE ORDEN:
    // Meta exige la agenda primero, y así los chats llegan ya con nombre.
    expect(sincronizaciones).toEqual([
      `${NUMERO_EN_LA_APP}:smb_app_state_sync`,
      `${NUMERO_EN_LA_APP}:history`,
    ]);
    expect(r.body.historialPedido).toBe(true);

    const { rows } = await admin.query<{ kind: string }>(
      `SELECT kind FROM channel_secrets WHERE channel_account_id = $1 ORDER BY kind`,
      [r.body.id],
    );
    expect(rows.map((x) => x.kind)).toEqual(['access_token', 'app_secret']);
    const { rows: rastro } = await admin.query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE entity_id = $1 AND action = 'canal.conectado'`,
      [r.body.id],
    );
    expect(rastro[0]!.meta).toMatchObject({ via: 'plataforma', coexistencia: true });
  });

  it('sus webhooks se verifican con la clave de la PLATAFORMA, no con una del cliente', async () => {
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA_DE_PLATAFORMA,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '51955000000',
                  phone_number_id: NUMERO_EN_LA_APP,
                },
                contacts: [{ profile: { name: 'Rosa' }, wa_id: '51911222333' }],
                messages: [
                  {
                    from: '51911222333',
                    id: 'wamid.PLATAFORMA1',
                    timestamp: '1757440000',
                    type: 'text',
                    text: { body: '¿Tienen bungalow?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const conClaveAjena = await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, 'una-clave-cualquiera-del-cliente'))
      .send(cuerpo);
    const conLaDeLaPlataforma = await http
      .post('/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', firmar(cuerpo, META.appSecret))
      .send(cuerpo);
    expect(conClaveAjena.status).toBe(401);
    expect(conLaDeLaPlataforma.status).toBe(200);
    const { rows } = await admin.query<{ signature_ok: boolean; status: string }>(
      `SELECT signature_ok, status FROM inbound_events
        WHERE raw::text LIKE '%wamid.PLATAFORMA1%' ORDER BY signature_ok`,
    );
    // La de clave ajena queda guardada como rastro, marcada y sin procesar;
    // la firmada con la clave de la plataforma es la única que entra.
    expect(rows).toEqual([
      { signature_ok: false, status: 'failed' },
      { signature_ok: true, status: 'pending' },
    ]);
  });

  it('número nuevo: se registra con un PIN, que se guarda cifrado y no sale en el rastro', async () => {
    registros = [];
    sincronizaciones = [];
    const r = await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ phoneNumberId: NUMERO_NUEVO, wabaId: WABA_DE_PLATAFORMA, credencial })
      .expect(201);
    // Un número nuevo no tiene app del celular de la que traer nada.
    expect(sincronizaciones).toEqual([]);
    expect(r.body.historialPedido).toBeNull();
    expect(registros).toHaveLength(1);
    expect(registros[0]!.phoneNumberId).toBe(NUMERO_NUEVO);
    expect(registros[0]!.pin).toMatch(/^[0-9]{6}$/);

    const { rows } = await admin.query<{ kind: string; ciphertext: Buffer }>(
      `SELECT kind, ciphertext FROM channel_secrets WHERE channel_account_id = $1 ORDER BY kind`,
      [r.body.id],
    );
    expect(rows.map((x) => x.kind)).toEqual(['access_token', 'app_secret', 'pin']);
    const pin = rows.find((x) => x.kind === 'pin')!;
    expect(pin.ciphertext.toString('utf8')).not.toContain(registros[0]!.pin);

    const { rows: rastro } = await admin.query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE entity_id = $1 AND action = 'canal.conectado'`,
      [r.body.id],
    );
    expect(rastro[0]!.meta).toMatchObject({ coexistencia: false, registrado: true });
    expect(JSON.stringify(rastro[0]!.meta)).not.toContain(registros[0]!.pin);
  });

  it('páginas: un inicio de sesión trae Facebook e Instagram, y conecta sin pegar nada', async () => {
    const sesion = await http
      .post('/v1/canales/meta/paginas')
      .set(auth(tokenOwner))
      .send({ code: 'CODIGO-DE-META-PAGINAS' })
      .expect(200);
    expect(sesion.body.facebook).toEqual([
      { paginaId: PAGINA_DE_PLATAFORMA, pagina: 'Hotel con la app', yaConectado: false },
    ]);
    expect(sesion.body.instagram[0]).toMatchObject({
      usuario: '@hotelconlaapp',
      yaConectado: false,
    });
    expect(JSON.stringify(sesion.body)).not.toContain(TOKEN_DE_PAGINA);

    const r = await http
      .post('/v1/canales/facebook')
      .set(auth(tokenOwner))
      .send({ paginaId: PAGINA_DE_PLATAFORMA, credencial: sesion.body.credencial })
      .expect(201);
    expect(r.body.conectadoVia).toBe('plataforma');
  });

  it('sin plaza en el plan, el código NO se gasta: vale una sola vez', async () => {
    // La otra cuenta está en Starter (un canal) y lo llena pegando credenciales.
    await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOtra))
      .send({ ...CRED, phoneNumberId: '710000000000001', wabaId: '810000000000001' })
      .expect(201);
    intercambios = [];
    const r = await http
      .post('/v1/canales/meta/whatsapp')
      .set(auth(tokenOtra))
      .send({ code: 'CODIGO-QUE-NO-DEBE-GASTARSE', wabaId: WABA_DE_PLATAFORMA })
      .expect(402);
    expect(r.body.codigo).toBe('limite_de_canales');
    expect(intercambios).toEqual([]);
  });

  it('pegar credenciales sigue funcionando igual, y queda marcado como tal', async () => {
    const lista = await http.get('/v1/canales').set(auth(tokenOtra)).expect(200);
    expect(lista.body[0].conectadoVia).toBe('credenciales');
  });

  it('ni token ni sobre: se rechaza antes de llegar al servicio', async () => {
    await http
      .post('/v1/canales/whatsapp')
      .set(auth(tokenOwner))
      .send({ phoneNumberId: NUMERO_NUEVO, wabaId: WABA_DE_PLATAFORMA })
      .expect(400);
  });
});
