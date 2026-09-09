/**
 * Medios por HTTP real: subida directa (preparar → PUT al almacén →
 * confirmar), envío con `mediaAssetId`, URL firmada de lectura y aislamiento
 * entre inquilinos. El almacén es el de memoria; MinIO se prueba en
 * packages/storage.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar } from '@crmapp/db';
import { AlmacenEnMemoria } from '@crmapp/storage';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_medios';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let conversationId: string;
const almacen = new AlmacenEnMemoria();

async function alta(slug: string) {
  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: slug,
      slug,
      email: `${slug}@test.test`,
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Jefe',
    })
    .expect(201);
  return r.body as { token: string; tenantId: string };
}

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
      modoSandbox: true,
      almacen,
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());

  const a = await alta('acme');
  token = a.token;
  tenantId = a.tenantId;
  tokenAjeno = (await alta('ajena')).token;

  // Conversación abierta con ventana vigente, para poder enviar.
  const ca = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
       VALUES ($1, 'whatsapp', 'pn-acme', 'WA') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const c = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'Ana') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const ci = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1, $2, 'whatsapp', $3, 'wa-ana') RETURNING id`,
      [tenantId, c, ca],
    )
  ).rows[0]!.id;
  conversationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, status, last_inbound_at, session_expires_at)
       VALUES ($1, $2, $3, $4, 'open', now(), now() + interval '20 hours') RETURNING id`,
      [tenantId, ci, c, ca],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

describe('subida directa y envío', () => {
  let mediaAssetId: string;

  it('prepara la subida: media_asset pending + URL de PUT firmada', async () => {
    const r = await http
      .post('/v1/medios/subidas')
      .set(auth())
      .send({ mime: 'image/jpeg', bytes: 1234 })
      .expect(201);
    mediaAssetId = r.body.mediaAssetId;
    expect(r.body.urlDeSubida).toContain(`tenants/${tenantId}/media/${mediaAssetId}.jpg`);

    const { rows } = await admin.query<{ status: string; kind: string }>(
      `SELECT status, kind FROM media_assets WHERE id = $1`,
      [mediaAssetId],
    );
    expect(rows[0]).toEqual({ status: 'pending', kind: 'image' });
  });

  it('confirmar antes de que el objeto exista → 409', async () => {
    const r = await http
      .post(`/v1/medios/subidas/${mediaAssetId}/confirmar`)
      .set(auth())
      .expect(409);
    expect(r.body.codigo).toBe('subida_incompleta');
  });

  it('enviar con un medio aún no almacenado → 409', async () => {
    await http
      .post(`/v1/conversaciones/${conversationId}/mensajes`)
      .set(auth())
      .send({ tipo: 'image', mediaAssetId })
      .expect(409);
  });

  it('tras el PUT del navegador, confirmar marca stored y devuelve URL de lectura', async () => {
    // Simula el PUT directo del navegador al almacén.
    await almacen.guardar(
      `tenants/${tenantId}/media/${mediaAssetId}.jpg`,
      Buffer.from('jpg'),
      'image/jpeg',
    );
    const r = await http
      .post(`/v1/medios/subidas/${mediaAssetId}/confirmar`)
      .set(auth())
      .expect(200);
    expect(r.body.urlDeLectura).toContain(mediaAssetId);
    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM media_assets WHERE id = $1`,
      [mediaAssetId],
    );
    expect(rows[0]!.status).toBe('stored');
  });

  it('enviar con mediaAssetId encola el mensaje enlazado al medio, sin URL en el outbox', async () => {
    const r = await http
      .post(`/v1/conversaciones/${conversationId}/mensajes`)
      .set(auth())
      .send({ tipo: 'image', mediaAssetId, pieDeFoto: 'foto' })
      .expect(202);
    const m = await admin.query<{ media_asset_id: string }>(
      `SELECT media_asset_id FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(m.rows[0]!.media_asset_id).toBe(mediaAssetId);

    const o = await admin.query<{ payload: { peticion: Record<string, unknown> } }>(
      `SELECT payload FROM outbox WHERE event_type = 'mensaje.enviar' AND aggregate_id = $1`,
      [r.body.id],
    );
    // La URL la firma el worker al enviar, no la API al encolar.
    expect(o.rows[0]!.payload.peticion).toMatchObject({ tipo: 'image', url: null, mediaAssetId });
  });

  it('el listado de mensajes expone medio_id y su estado', async () => {
    const r = await http
      .get(`/v1/conversaciones/${conversationId}/mensajes`)
      .set(auth())
      .expect(200);
    const conMedio = r.body.items.find(
      (m: { medio_id: string | null }) => m.medio_id === mediaAssetId,
    );
    expect(conMedio).toBeTruthy();
    expect(conMedio.medio_estado).toBe('stored');
  });

  it('GET /v1/medios/:id/url devuelve una URL firmada de vida corta', async () => {
    const r = await http.get(`/v1/medios/${mediaAssetId}/url`).set(auth()).expect(200);
    expect(r.body.url).toContain(mediaAssetId);
    expect(r.body.expiraEnSegundos).toBe(300);
    expect(r.body.mime).toBe('image/jpeg');
  });

  it('otro inquilino no ve el medio: 404, ni para leer ni para enviar', async () => {
    await http.get(`/v1/medios/${mediaAssetId}/url`).set(auth(tokenAjeno)).expect(404);
    await http
      .post(`/v1/medios/subidas/${mediaAssetId}/confirmar`)
      .set(auth(tokenAjeno))
      .expect(404);
  });

  it('medio sin url ni mediaAssetId → 400; tipo no permitido → 415; demasiado grande → 413', async () => {
    await http
      .post(`/v1/conversaciones/${conversationId}/mensajes`)
      .set(auth())
      .send({ tipo: 'image' })
      .expect(400);
    await http
      .post('/v1/medios/subidas')
      .set(auth())
      .send({ mime: 'application/x-msdownload', bytes: 10 })
      .expect(415);
    await http
      .post('/v1/medios/subidas')
      .set(auth())
      .send({ mime: 'image/png', bytes: 200 * 1024 * 1024 })
      .expect(413);
  });

  it('la URL externa sigue funcionando como antes', async () => {
    await http
      .post(`/v1/conversaciones/${conversationId}/mensajes`)
      .set(auth())
      .send({ tipo: 'image', url: 'https://ejemplo.test/foto.jpg' })
      .expect(202);
  });

  it('sin sesión → 401', async () => {
    await http.get(`/v1/medios/${mediaAssetId}/url`).expect(401);
  });
});
