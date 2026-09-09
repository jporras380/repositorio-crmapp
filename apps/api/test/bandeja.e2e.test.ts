/**
 * Bandeja y envío (ARCH §9) por HTTP real contra PostgreSQL real.
 *
 * Lo que se prueba solo existe atravesando la puerta completa: suscripción →
 * estado de la conversación → ventana → capacidades → outbox. Y el filtrado
 * por etiquetas con color, que es el mecanismo de Zenvia que el usuario pidió.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_bandeja';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tenantId: string;
let userId: string;
let channelAccountId: string;
let ahora = new Date();

/** Crea contacto+identidad+conversación con un entrante hace `haceHoras`. */
async function conversacion(
  nombre: string,
  opts: { haceHoras?: number; respondida?: boolean; canal?: string } = {},
) {
  const canal = opts.canal ?? 'whatsapp';
  const ca =
    canal === 'whatsapp'
      ? channelAccountId
      : (
          await admin.query<{ id: string }>(
            `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
             VALUES ($1, $2, $3, $4) ON CONFLICT (channel, external_id) DO UPDATE SET display_name = EXCLUDED.display_name
             RETURNING id`,
            [tenantId, canal, `ext-${canal}`, canal],
          )
        ).rows[0]!.id;
  const c = await admin.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
    [tenantId, nombre],
  );
  const ci = await admin.query<{ id: string }>(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id, handle)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, c.rows[0]!.id, canal, ca, `u-${nombre}-${canal}`, nombre],
  );
  const entrante = new Date(Date.now() - (opts.haceHoras ?? 1) * 3_600_000);
  const saliente = opts.respondida ? new Date(entrante.getTime() + 60_000) : null;
  const conv = await admin.query<{ id: string }>(
    `INSERT INTO conversations
       (tenant_id, contact_identity_id, contact_id, channel_account_id, status,
        last_inbound_at, last_outbound_at, session_expires_at, unread_count)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, 1) RETURNING id`,
    [
      tenantId,
      ci.rows[0]!.id,
      c.rows[0]!.id,
      ca,
      entrante,
      saliente,
      new Date(entrante.getTime() + 24 * 3_600_000),
    ],
  );
  await admin.query(
    `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, created_at)
     VALUES ($1, $2, $3, 'inbound', 'text', $4, 'delivered', $5)`,
    [tenantId, conv.rows[0]!.id, ca, `hola de ${nombre}`, entrante],
  );
  return conv.rows[0]!.id;
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
      ahora: () => ahora,
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());

  // Alta por la propia API: deja la suscripción en prueba.
  const alta = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: 'Nippon',
      slug: 'nippon',
      email: 'jefe@nippon.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Jefe',
    })
    .expect(201);
  token = alta.body.token;
  tenantId = alta.body.tenantId;
  userId = alta.body.userId;

  channelAccountId = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
       VALUES ($1, 'whatsapp', 'pn-nippon', 'WA Nippon') RETURNING id`,
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

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('listado y filtros', () => {
  let sinResponder: string;
  let respondida: string;
  let deInstagram: string;
  let etiquetaUrgente: string;

  beforeAll(async () => {
    sinResponder = await conversacion('Ana', { haceHoras: 1 });
    respondida = await conversacion('Bruno', { haceHoras: 2, respondida: true });
    deInstagram = await conversacion('Carla', { haceHoras: 3, canal: 'instagram' });
    const t = await http
      .post('/v1/etiquetas')
      .set(auth())
      .send({ nombre: 'Urgente', color: '#ff3b30' })
      .expect(201);
    etiquetaUrgente = t.body.id;
    await http
      .patch(`/v1/conversaciones/${sinResponder}/etiquetas`)
      .set(auth())
      .send({ tagId: etiquetaUrgente })
      .expect(204);
  });

  it('lista ordenada por último entrante, con vista previa y etiquetas con color', async () => {
    const r = await http.get('/v1/conversaciones').set(auth()).expect(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids.slice(0, 3)).toEqual([sinResponder, respondida, deInstagram]);
    const ana = r.body.items[0];
    expect(ana.contacto.nombre).toBe('Ana');
    expect(ana.vistaPrevia).toBe('hola de Ana');
    expect(ana.etiquetas).toEqual([{ id: etiquetaUrgente, nombre: 'Urgente', color: '#ff3b30' }]);
    expect(ana.ventanaAbierta).toBe(true);
    expect(ana.ventanaExpiraEn).toBeTruthy();
  });

  it('filtra "sin respuesta" (derivado, no almacenado)', async () => {
    const r = await http
      .get('/v1/conversaciones')
      .query({ sinRespuesta: 'true' })
      .set(auth())
      .expect(200);
    const ids = r.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(sinResponder);
    expect(ids).not.toContain(respondida);
  });

  it('filtra por canal', async () => {
    const r = await http
      .get('/v1/conversaciones')
      .query({ canal: 'instagram' })
      .set(auth())
      .expect(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([deInstagram]);
  });

  it('filtra por etiqueta: el color es el filtro de primer nivel', async () => {
    const r = await http
      .get('/v1/conversaciones')
      .query({ etiquetaId: etiquetaUrgente })
      .set(auth())
      .expect(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([sinResponder]);
  });

  it('pagina por cursor sin repetir ni saltar', async () => {
    const p1 = await http.get('/v1/conversaciones').query({ limite: 2 }).set(auth()).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.siguienteCursor).toBeTruthy();
    const p2 = await http
      .get('/v1/conversaciones')
      .query({ limite: 2, cursor: p1.body.siguienteCursor })
      .set(auth())
      .expect(200);
    const todos = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(todos).size).toBe(todos.length);
    expect(todos).toContain(deInstagram);
  });

  it('un cursor manipulado da 400, no 500', async () => {
    const r = await http
      .get('/v1/conversaciones')
      .query({ cursor: 'basura' })
      .set(auth())
      .expect(400);
    expect(r.body.codigo).toBe('cursor_invalido');
  });

  it('los mensajes de una conversación se listan del más nuevo al más antiguo', async () => {
    const r = await http.get(`/v1/conversaciones/${sinResponder}/mensajes`).set(auth()).expect(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].direccion).toBe('inbound');
    expect(r.body.items[0].texto).toBe('hola de Ana');
  });
});

describe('la puerta de envío (ARCH §9)', () => {
  it('texto dentro de ventana: 202, queued, outbox y contador de no leídos a cero', async () => {
    const conv = await conversacion('Diego', { haceHoras: 1 });
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'Hola Diego' })
      .expect(202);
    expect(r.body.estado).toBe('queued');

    const m = await admin.query<{ status: string; direction: string; sent_by_user_id: string }>(
      `SELECT status, direction, sent_by_user_id FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(m.rows[0]).toMatchObject({
      status: 'queued',
      direction: 'outbound',
      sent_by_user_id: userId,
    });

    const o = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE aggregate_id = $1`,
      [r.body.id],
    );
    expect(o.rows.map((x) => x.event_type)).toContain('mensaje.enviar');

    const c = await admin.query<{ unread_count: number; first_response_at: Date | null }>(
      `SELECT unread_count, first_response_at FROM conversations WHERE id = $1`,
      [conv],
    );
    expect(c.rows[0]!.unread_count).toBe(0);
    expect(c.rows[0]!.first_response_at).toBeTruthy();
  });

  it('un saliente NO reinicia la ventana de WhatsApp', async () => {
    const conv = await conversacion('Elena', { haceHoras: 5 });
    const antes = (
      await admin.query<{ session_expires_at: Date }>(
        `SELECT session_expires_at FROM conversations WHERE id = $1`,
        [conv],
      )
    ).rows[0]!.session_expires_at;
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'x' })
      .expect(202);
    const despues = (
      await admin.query<{ session_expires_at: Date }>(
        `SELECT session_expires_at FROM conversations WHERE id = $1`,
        [conv],
      )
    ).rows[0]!.session_expires_at;
    expect(despues.getTime()).toBe(antes.getTime());
  });

  it('fuera de ventana: 409 con código y hueco para plantillas sugeridas', async () => {
    const conv = await conversacion('Fabio', { haceHoras: 30 });
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'tarde' })
      .expect(409);
    expect(r.body.codigo).toBe('fuera_de_ventana');
    expect(r.body.plantillasSugeridas).toEqual([]);
  });

  it('una plantilla sí pasa fuera de ventana', async () => {
    const conv = await conversacion('Gema', { haceHoras: 30 });
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'template', nombre: 'recordatorio', idioma: 'es', parametros: ['Gema'] })
      .expect(202);
  });

  it('un texto de más de 4096 caracteres lo rechazan las capacidades del canal', async () => {
    const conv = await conversacion('Hugo', { haceHoras: 1 });
    // Zod limita a 4096 en la ruta; se prueba el límite de la ruta y que el
    // motivo llegue nombrado.
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'a'.repeat(5000) })
      .expect(400);
    expect(r.body.codigo).toBe('datos_invalidos');
  });

  it('conversación cerrada: 409', async () => {
    const conv = await conversacion('Iris', { haceHoras: 1 });
    await http
      .patch(`/v1/conversaciones/${conv}/estado`)
      .set(auth())
      .send({ estado: 'closed' })
      .expect(204);
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'x' })
      .expect(409);
    expect(r.body.codigo).toBe('conversacion_cerrada');
  });

  it('suscripción en gracia: texto sí, imagen no (402 con motivo)', async () => {
    const conv = await conversacion('Julia', { haceHoras: 1 });
    // Mover el reloj de la API 35 días adelante: prueba caducada, en gracia.
    const original = ahora;
    ahora = new Date(Date.now() + 35 * 86_400_000);
    // La ventana también habría caducado con el reloj adelantado: se reabre a mano.
    await admin.query(`UPDATE conversations SET session_expires_at = $2 WHERE id = $1`, [
      conv,
      new Date(ahora.getTime() + 3_600_000),
    ]);
    try {
      await http
        .post(`/v1/conversaciones/${conv}/mensajes`)
        .set(auth())
        .send({ tipo: 'text', texto: 'texto permitido' })
        .expect(202);
      const r = await http
        .post(`/v1/conversaciones/${conv}/mensajes`)
        .set(auth())
        .send({ tipo: 'image', url: 'https://ejemplo.test/foto.jpg' })
        .expect(402);
      expect(r.body.codigo).toBe('suscripcion_medios_no_permitidos_en_gracia');
      expect(r.body.mensaje).toMatch(/solo se pueden enviar mensajes de texto/i);
    } finally {
      ahora = original;
    }
  });

  it('suscripción suspendida: nada, ni texto', async () => {
    const conv = await conversacion('Kai', { haceHoras: 1 });
    const original = ahora;
    ahora = new Date(Date.now() + 60 * 86_400_000);
    await admin.query(`UPDATE conversations SET session_expires_at = $2 WHERE id = $1`, [
      conv,
      new Date(ahora.getTime() + 3_600_000),
    ]);
    try {
      const r = await http
        .post(`/v1/conversaciones/${conv}/mensajes`)
        .set(auth())
        .send({ tipo: 'text', texto: 'x' })
        .expect(402);
      expect(r.body.codigo).toBe('suscripcion_suscripcion_suspendida');
    } finally {
      ahora = original;
    }
  });
});

describe('aislamiento y acciones', () => {
  it('la conversación de otra cuenta no existe: 404, no 403', async () => {
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
    const conv = await conversacion('Luz', { haceHoras: 1 });
    const r = await http
      .get(`/v1/conversaciones/${conv}/mensajes`)
      .set({ Authorization: `Bearer ${otra.body.token}` })
      .expect(404);
    expect(r.body.codigo).toBe('conversacion_no_encontrada');
    const lista = await http
      .get('/v1/conversaciones')
      .set({ Authorization: `Bearer ${otra.body.token}` })
      .expect(200);
    expect(lista.body.items).toHaveLength(0);
  });

  it('asignar a un agente de la cuenta; rechazar a uno ajeno', async () => {
    const conv = await conversacion('Mario', { haceHoras: 1 });
    await http
      .patch(`/v1/conversaciones/${conv}/asignacion`)
      .set(auth())
      .send({ agenteId: userId })
      .expect(204);
    const r = await http
      .patch(`/v1/conversaciones/${conv}/asignacion`)
      .set(auth())
      .send({ agenteId: '00000000-0000-7000-8000-000000000009' })
      .expect(422);
    expect(r.body.codigo).toBe('agente_invalido');
    const f = await http
      .get('/v1/conversaciones')
      .query({ agenteId: userId })
      .set(auth())
      .expect(200);
    expect(f.body.items.map((i: { id: string }) => i.id)).toContain(conv);
  });

  it('quitar una etiqueta', async () => {
    const conv = await conversacion('Nora', { haceHoras: 1 });
    const t = await http
      .post('/v1/etiquetas')
      .set(auth())
      .send({ nombre: 'VIP', color: '#34c759' })
      .expect(201);
    await http
      .patch(`/v1/conversaciones/${conv}/etiquetas`)
      .set(auth())
      .send({ tagId: t.body.id })
      .expect(204);
    await http
      .patch(`/v1/conversaciones/${conv}/etiquetas`)
      .set(auth())
      .send({ tagId: t.body.id, poner: false })
      .expect(204);
    const r = await http
      .get('/v1/conversaciones')
      .query({ etiquetaId: t.body.id })
      .set(auth())
      .expect(200);
    expect(r.body.items).toHaveLength(0);
  });

  it('una etiqueta repetida da 409 y un color inválido 400', async () => {
    await http
      .post('/v1/etiquetas')
      .set(auth())
      .send({ nombre: 'Dup', color: '#000000' })
      .expect(201);
    expect(
      (
        await http
          .post('/v1/etiquetas')
          .set(auth())
          .send({ nombre: 'Dup', color: '#000000' })
          .expect(409)
      ).body.codigo,
    ).toBe('etiqueta_repetida');
    await http.post('/v1/etiquetas').set(auth()).send({ nombre: 'Mal', color: 'rojo' }).expect(400);
  });

  it('todo queda en auditoría', async () => {
    const { rows } = await admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1`,
      [tenantId],
    );
    const acciones = rows.map((r) => r.action);
    expect(acciones).toEqual(
      expect.arrayContaining(['mensaje.enviado', 'conversacion.asignada', 'conversacion.estado']),
    );
  });
});
