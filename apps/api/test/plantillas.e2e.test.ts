/**
 * Plantillas por HTTP real (ARCH §5.6): sincronización de HSM desde el
 * proveedor, la puerta de envío exigiendo `aprobada`, las sugerencias fuera
 * de ventana, y respuestas rápidas con versiones.
 *
 * El sandbox hace de Meta: declara qué plantillas existen y en qué estado.
 * El CRM nunca decide un estado; lo refleja.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar } from '@crmapp/db';
import { AdaptadorSandbox, type ChannelAdapter } from '@crmapp/channels';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_plantillas';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let channelAccountId: string;

const sandbox = new AdaptadorSandbox({
  canal: 'whatsapp',
  plantillas: [
    {
      nombre: 'bienvenida',
      idioma: 'es',
      estado: 'aprobada',
      categoriaEfectiva: 'UTILITY',
      motivoDeRechazo: null,
      calidad: 'GREEN',
      externalId: 'tpl-1',
    },
    {
      nombre: 'promo',
      idioma: 'es',
      estado: 'rechazada',
      categoriaEfectiva: 'MARKETING',
      motivoDeRechazo: 'INVALID_FORMAT',
      calidad: null,
      externalId: 'tpl-2',
    },
  ],
});

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

/** Conversación con la ventana abierta (`haceHoras` < 24) o cerrada. */
async function conversacion(nombre: string, haceHoras: number): Promise<string> {
  const c = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
      [tenantId, nombre],
    )
  ).rows[0]!.id;
  const ci = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1, $2, 'whatsapp', $3, $4) RETURNING id`,
      [tenantId, c, channelAccountId, `u-${nombre}`],
    )
  ).rows[0]!.id;
  const entrante = new Date(Date.now() - haceHoras * 3_600_000);
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, status, last_inbound_at, session_expires_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6) RETURNING id`,
      [tenantId, ci, c, channelAccountId, entrante, new Date(entrante.getTime() + 24 * 3_600_000)],
    )
  ).rows[0]!.id;
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
      canales: new Map<string, ChannelAdapter>([['whatsapp', sandbox]]),
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

  channelAccountId = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, provider_account_id, display_name, status)
       VALUES ($1, 'whatsapp', 'pn-acme', 'waba-acme', 'WA', 'connected') RETURNING id`,
      [tenantId],
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

describe('plantillas de WhatsApp: el estado lo fija Meta', () => {
  it('sincronizar trae las plantillas con el estado del proveedor y crea su versión 1', async () => {
    const r = await http
      .post(`/v1/canales/${channelAccountId}/plantillas/sincronizar`)
      .set(auth())
      .expect(200);
    expect(r.body).toEqual({ total: 2, nuevas: 2, actualizadas: 0 });

    const lista = await http
      .get(`/v1/canales/${channelAccountId}/plantillas`)
      .set(auth())
      .expect(200);
    expect(lista.body.map((p: { nombre: string; estado: string }) => [p.nombre, p.estado])).toEqual(
      [
        ['bienvenida', 'aprobada'],
        ['promo', 'rechazada'],
      ],
    );
    const promo = lista.body.find((p: { nombre: string }) => p.nombre === 'promo');
    // El motivo se guarda y se muestra: es lo único que permite corregir.
    expect(promo.motivoDeRechazo).toBe('INVALID_FORMAT');
    expect(promo.categoriaEfectiva).toBe('MARKETING');

    const v = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wa_template_versions WHERE tenant_id = $1 AND version = 1`,
      [tenantId],
    );
    expect(v.rows[0]!.n).toBe(2);
  });

  it('sincronizar de nuevo sin cambios: nada nuevo, nada actualizado', async () => {
    const r = await http
      .post(`/v1/canales/${channelAccountId}/plantillas/sincronizar`)
      .set(auth())
      .expect(200);
    expect(r.body).toEqual({ total: 2, nuevas: 0, actualizadas: 0 });
  });

  it('fuera de ventana se sugieren SOLO las aprobadas', async () => {
    const conv = await conversacion('Ana', 30);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'tarde' })
      .expect(409);
    expect(r.body.codigo).toBe('fuera_de_ventana');
    expect(r.body.plantillasSugeridas.map((p: { nombre: string }) => p.nombre)).toEqual([
      'bienvenida',
    ]);
  });

  it('una plantilla rechazada no sale (422 con estado y motivo); una desconocida tampoco', async () => {
    const conv = await conversacion('Bea', 30);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'template', nombre: 'promo', idioma: 'es', parametros: [] })
      .expect(422);
    expect(r.body.codigo).toBe('plantilla_no_aprobada');
    expect(r.body).toMatchObject({ estado: 'rechazada', motivoDeRechazo: 'INVALID_FORMAT' });

    const d = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'template', nombre: 'inventada', idioma: 'es', parametros: [] })
      .expect(422);
    expect(d.body.codigo).toBe('plantilla_desconocida');
  });

  it('una aprobada sale y el mensaje queda enlazado a la VERSIÓN enviada', async () => {
    const conv = await conversacion('Caro', 30);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'template', nombre: 'bienvenida', idioma: 'es', parametros: ['Caro'] })
      .expect(202);
    const m = await admin.query<{ wa_template_version_id: string | null }>(
      `SELECT wa_template_version_id FROM messages WHERE id = $1`,
      [r.body.id],
    );
    const v = await admin.query<{ id: string }>(
      `SELECT v.id FROM wa_template_versions v JOIN wa_templates t ON t.id = v.template_id WHERE t.name = 'bienvenida'`,
    );
    expect(m.rows[0]!.wa_template_version_id).toBe(v.rows[0]!.id);
  });

  it('otro inquilino no ve la cuenta ni sus plantillas', async () => {
    await http.get(`/v1/canales/${channelAccountId}/plantillas`).set(auth(tokenAjeno)).expect(404);
    await http
      .post(`/v1/canales/${channelAccountId}/plantillas/sincronizar`)
      .set(auth(tokenAjeno))
      .expect(404);
  });
});

describe('respuestas rápidas: versiones y envío', () => {
  let id: string;

  it('crear con atajo; el atajo repetido da 409', async () => {
    const r = await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({ atajo: '/gracias', titulo: 'Gracias', cuerpo: 'Gracias por escribirnos.' })
      .expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ atajo: '/gracias', version: 1, medioId: null });

    const dup = await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({ atajo: '/gracias', titulo: 'Otra', cuerpo: 'x' })
      .expect(409);
    expect(dup.body.codigo).toBe('atajo_repetido');
  });

  it('sin texto ni adjunto → 400; atajo mal formado → 400', async () => {
    await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({ atajo: '/vacia', titulo: 'V' })
      .expect(400);
    await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({ atajo: 'sin-barra', titulo: 'V', cuerpo: 'x' })
      .expect(400);
  });

  it('editar el cuerpo crea la versión 2; el título se cambia en sitio', async () => {
    const r = await http
      .patch(`/v1/respuestas-rapidas/${id}`)
      .set(auth())
      .send({ cuerpo: 'Gracias por escribirnos, te respondemos enseguida.', titulo: 'Gracias v2' })
      .expect(200);
    expect(r.body).toMatchObject({ version: 2, titulo: 'Gracias v2' });
    const versiones = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quick_reply_versions WHERE quick_reply_id = $1`,
      [id],
    );
    expect(versiones.rows[0]!.n).toBe(2);
  });

  it('enviarla en ventana abierta produce un texto enlazado a la versión actual', async () => {
    const conv = await conversacion('Dani', 1);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'quick_reply', quickReplyId: id })
      .expect(202);
    const m = await admin.query<{ type: string; body: string; quick_reply_version_id: string }>(
      `SELECT type, body, quick_reply_version_id FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(m.rows[0]).toMatchObject({
      type: 'text',
      body: 'Gracias por escribirnos, te respondemos enseguida.',
    });
    const actual = await admin.query<{ current_version_id: string }>(
      `SELECT current_version_id FROM quick_replies WHERE id = $1`,
      [id],
    );
    expect(m.rows[0]!.quick_reply_version_id).toBe(actual.rows[0]!.current_version_id);
  });

  it('fuera de ventana una respuesta rápida se rechaza como el texto que es', async () => {
    const conv = await conversacion('Eli', 30);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'quick_reply', quickReplyId: id })
      .expect(409);
    expect(r.body.codigo).toBe('fuera_de_ventana');
  });

  it('con adjunto almacenado se envía como medio con el texto de pie', async () => {
    const medio = (
      await admin.query<{ id: string }>(
        `INSERT INTO media_assets (tenant_id, kind, status, storage_key, mime)
         VALUES ($1, 'image', 'stored', 'tenants/x/media/cat.jpg', 'image/jpeg') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    const q = await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({
        atajo: '/catalogo',
        titulo: 'Catálogo',
        cuerpo: 'Nuestro catálogo',
        mediaAssetId: medio,
      })
      .expect(201);
    const conv = await conversacion('Fer', 1);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'quick_reply', quickReplyId: q.body.id })
      .expect(202);
    const m = await admin.query<{ type: string; media_asset_id: string }>(
      `SELECT type, media_asset_id FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(m.rows[0]).toEqual({ type: 'image', media_asset_id: medio });
  });

  it('otro inquilino no la ve: 404 al editar', async () => {
    await http
      .patch(`/v1/respuestas-rapidas/${id}`)
      .set(auth(tokenAjeno))
      .send({ titulo: 'x' })
      .expect(404);
  });

  it('archivar la saca del listado y del envío, sin borrar sus versiones', async () => {
    await http.delete(`/v1/respuestas-rapidas/${id}`).set(auth()).expect(204);
    const lista = await http.get('/v1/respuestas-rapidas').set(auth()).expect(200);
    expect(lista.body.map((q: { atajo: string }) => q.atajo)).toEqual(['/catalogo']);

    const conv = await conversacion('Gus', 1);
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'quick_reply', quickReplyId: id })
      .expect(404);
    const versiones = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quick_reply_versions WHERE quick_reply_id = $1`,
      [id],
    );
    expect(versiones.rows[0]!.n).toBe(2);
    // El atajo queda libre para una nueva.
    await http
      .post('/v1/respuestas-rapidas')
      .set(auth())
      .send({ atajo: '/gracias', titulo: 'Gracias 3', cuerpo: 'Gracias.' })
      .expect(201);
  });
});
