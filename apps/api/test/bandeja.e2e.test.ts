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
import { migrar, reintentandoSiChocaElCatalogo } from '@crmapp/db';
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
  opts: {
    haceHoras?: number;
    /** Contestó una persona del equipo. */
    respondida?: boolean;
    /** Contestó solo el bot: hay saliente, pero ninguna persona escribió. */
    soloBot?: boolean;
    canal?: string;
  } = {},
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
  const saliente = opts.respondida || opts.soloBot ? new Date(entrante.getTime() + 60_000) : null;
  const conv = await admin.query<{ id: string }>(
    `INSERT INTO conversations
       (tenant_id, contact_identity_id, contact_id, channel_account_id, status,
        last_inbound_at, last_outbound_at, session_expires_at, unread_count, human_reply_at)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, 1, $8) RETURNING id`,
    [
      tenantId,
      ci.rows[0]!.id,
      c.rows[0]!.id,
      ca,
      entrante,
      saliente,
      new Date(entrante.getTime() + 24 * 3_600_000),
      opts.respondida ? saliente : null,
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
      modoSandbox: true,
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

  it('GET /v1/etiquetas lista las de la cuenta con su color, y otra cuenta no las ve', async () => {
    const creada = await http

      .post('/v1/etiquetas')

      .set(auth())

      .send({ nombre: 'Prioridad', color: '#ff9500' })

      .expect(201);

    const r = await http.get('/v1/etiquetas').set(auth()).expect(200);

    expect(r.body).toEqual(
      expect.arrayContaining([{ id: creada.body.id, nombre: 'Prioridad', color: '#ff9500' }]),
    );

    const otra = await http

      .post('/v1/cuentas')

      .send({
        nombreDeCuenta: 'Otra',

        slug: 'otra-etiquetas',

        email: 'otra-etiquetas@test.test',

        contrasena: 'contrasena-muy-larga',

        nombreCompleto: 'Otra',
      })

      .expect(201);

    const ajena = await http
      .get('/v1/etiquetas')
      .set({ Authorization: `Bearer ${otra.body.token}` })
      .expect(200);

    expect(ajena.body).toEqual([]);
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

  it('"sin respuesta" es la cifra del panel: lo contestado solo por el bot sigue esperando', async () => {
    const soloBot = await conversacion('Dora', { haceHoras: 4, soloBot: true });
    const lista = await http
      .get('/v1/conversaciones')
      .query({ sinRespuesta: 'true', limite: 100 })
      .set(auth())
      .expect(200);
    const ids = lista.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(soloBot);

    const panel = await http.get('/v1/panel').set(auth()).expect(200);
    expect(panel.body.atencion.sinResponder).toBe(ids.length);
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

  it('una plantilla APROBADA sí pasa fuera de ventana; una desconocida, no', async () => {
    const conv = await conversacion('Gema', { haceHoras: 30 });
    // Sin sincronizar, la plantilla no existe para el CRM: 422 con motivo.
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'template', nombre: 'recordatorio', idioma: 'es', parametros: ['Gema'] })
      .expect(422);
    expect(r.body.codigo).toBe('plantilla_desconocida');

    // Aprobada por Meta (aquí, sembrada como lo dejaría una sincronización).
    await admin.query(
      `INSERT INTO wa_templates (tenant_id, channel_account_id, name, language, status)
       VALUES ($1, $2, 'recordatorio', 'es', 'aprobada')`,
      [tenantId, channelAccountId],
    );
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

describe('respuesta a comentarios (Instagram)', () => {
  /** Hilo de comentarios con un comentario recibido hace 30 h: ventana cerrada, pero se puede responder. */
  async function hiloDeComentarios(nombre: string, conComentario = true) {
    const conv = await conversacion(nombre, { haceHoras: 30, canal: 'instagram' });
    await admin.query(
      `UPDATE conversations SET kind = 'comment_thread', external_thread_id = 'post.7' WHERE id = $1`,
      [conv],
    );
    if (conComentario) {
      // Un id por hilo, como en Meta: reutilizar el mismo en todos mezclaba
      // las cuentas de respuestas privadas entre conversaciones.
      await admin.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, payload, status, created_at)
         SELECT tenant_id, id, channel_account_id, 'inbound', 'text', 'Precio?',
                jsonb_build_object('comentario',
                  jsonb_build_object('id', $2::text, 'postId', 'post.7')),
                'delivered', now() - interval '29 hours'
           FROM conversations WHERE id = $1`,
        [conv, `c.${nombre}`],
      );
    }
    return conv;
  }

  it('responde al último comentario aunque la ventana esté cerrada, en público o en privado', async () => {
    const conv = await hiloDeComentarios('Karen');
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'privada', texto: 'Te escribo por aquí' })
      .expect(202);
    const o = await admin.query<{ payload: { peticion: Record<string, unknown> } }>(
      `SELECT payload FROM outbox WHERE event_type = 'mensaje.enviar' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(o.rows[0]!.payload.peticion).toEqual({
      tipo: 'comment_reply',
      modo: 'privada',
      texto: 'Te escribo por aquí',
      comentarioId: 'c.Karen',
    });
    const m = await admin.query<{ type: string; body: string; payload: Record<string, unknown> }>(
      `SELECT type, body, payload FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(m.rows[0]).toMatchObject({ type: 'text', body: 'Te escribo por aquí' });
    expect(m.rows[0]!.payload).toMatchObject({ comentario: { id: 'c.Karen', modo: 'privada' } });
  });

  it('la privada es UNA por comentario: la segunda se impide, no se intenta', async () => {
    // Gastarla no se deshace. Antes esto salía hacia Meta y fallaba allí con
    // un error genérico; ahora muere en la puerta diciendo qué queda.
    const conv = await hiloDeComentarios('Única');
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'privada', texto: 'Hola, ahora te cuento' })
      .expect(202);

    const segunda = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'privada', texto: 'Los precios son…' })
      .expect(409);
    expect(segunda.body.codigo).toBe('respuesta_privada_agotada');

    // La pública no se toca: es la salida que le queda al agente.
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'publica', texto: 'Te escribimos por privado' })
      .expect(202);
  });

  it('una privada que FALLÓ no gasta el cupo: no salió nada', async () => {
    const conv = await hiloDeComentarios('Reintento');
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'privada', texto: 'primer intento' })
      .expect(202);
    await admin.query(`UPDATE messages SET status = 'failed' WHERE id = $1`, [r.body.id]);

    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'privada', texto: 'segundo intento' })
      .expect(202);
  });

  it('el listado dice de cada respuesta si fue pública o privada', async () => {
    const conv = await hiloDeComentarios('Modos');
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'publica', texto: 'en público' })
      .expect(202);
    const lista = await http.get(`/v1/conversaciones/${conv}/mensajes`).set(auth()).expect(200);
    expect(lista.body.items[0].modo_comentario).toBe('publica');
  });

  it('el modo por defecto es privado, y la lista distingue el hilo de comentarios', async () => {
    const conv = await hiloDeComentarios('Omar');
    // Sin `modo`: privada, como en Kommo. Es donde se captura el lead.
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', texto: 'Te escribo' })
      .expect(202);
    const o = await admin.query<{ payload: { peticion: { modo: string } } }>(
      `SELECT payload FROM outbox WHERE event_type = 'mensaje.enviar' AND aggregate_id = $1`,
      [r.body.id],
    );
    expect(o.rows[0]!.payload.peticion.modo).toBe('privada');

    // Y el listado deja filtrar por tipo de hilo.
    const lista = await http.get('/v1/conversaciones?tipo=comment_thread').set(auth()).expect(200);
    expect(lista.body.items.length).toBeGreaterThan(0);
    expect(lista.body.items.every((c: { tipo: string }) => c.tipo === 'comment_thread')).toBe(true);
    const item = lista.body.items.find((c: { id: string }) => c.id === conv);
    expect(item).toMatchObject({ tipo: 'comment_thread', publicacionId: 'post.7' });

    const dms = await http.get('/v1/conversaciones?tipo=dm').set(auth()).expect(200);
    expect(dms.body.items.every((c: { tipo: string }) => c.tipo === 'dm')).toBe(true);
  });

  it('un texto libre en ese mismo hilo sigue chocando con la ventana', async () => {
    const conv = await hiloDeComentarios('Leo');
    const r = await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'hola' })
      .expect(409);
    expect(r.body.codigo).toBe('fuera_de_ventana');
  });

  it('sin comentario al que responder → 400; en WhatsApp → 422', async () => {
    const sinComentarios = await hiloDeComentarios('Mia', false);
    const r = await http
      .post(`/v1/conversaciones/${sinComentarios}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'publica', texto: 'x' })
      .expect(400);
    expect(r.body.codigo).toBe('comentario_requerido');
    const wa = await conversacion('Nico', { haceHoras: 1 });
    const r2 = await http
      .post(`/v1/conversaciones/${wa}/mensajes`)
      .set(auth())
      .send({ tipo: 'comment_reply', modo: 'publica', texto: 'x', comentarioId: 'c.1' })
      .expect(422);
    expect(r2.body.codigo).toBe('canal_sin_comentarios');
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

describe('estado de atención, aplazar, notas y vistas (0020)', () => {
  const listar = async (query = '') =>
    (await http.get(`/v1/conversaciones${query}`).set(auth()).expect(200)).body as {
      items: {
        id: string;
        atencion: string;
        aplazadaHasta: string | null;
        enEspera: boolean;
        noLeidos: number;
      }[];
    };

  it('el estado se DEDUCE: nueva → por responder → esperando cliente → cerrada', async () => {
    const id = await conversacion('Elena Deduce');
    const de = async () => (await listar()).items.find((x) => x.id === id)!.atencion;

    // Nadie ha respondido nunca: nueva. Que el bot conteste no la atiende.
    expect(await de()).toBe('nueva');

    // Responde una persona por la puerta de envío: pasa a esperando cliente.
    await http
      .post(`/v1/conversaciones/${id}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'Buenas, ¿para qué fechas?' })
      .expect(202);
    expect(await de()).toBe('esperando_cliente');

    // Escribe el cliente: vuelve a estar en nuestro tejado.
    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() + interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect(await de()).toBe('por_responder');

    await http
      .patch(`/v1/conversaciones/${id}/estado`)
      .set(auth())
      .send({ estado: 'closed' })
      .expect(204);
    expect(await de()).toBe('cerrada');
  });

  it('aplazar la manda a seguimiento, y despertarla la devuelve', async () => {
    const id = await conversacion('Jorge Aplazado');
    const hasta = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await http.patch(`/v1/conversaciones/${id}/aplazar`).set(auth()).send({ hasta }).expect(204);

    const aplazada = (await listar()).items.find((x) => x.id === id)!;
    expect(aplazada.atencion).toBe('seguimiento');
    expect(aplazada.aplazadaHasta).not.toBeNull();

    // Y se puede filtrar por ello, con la MISMA definición que se muestra.
    expect((await listar('?atencion=seguimiento')).items.map((x) => x.id)).toContain(id);

    await http
      .patch(`/v1/conversaciones/${id}/aplazar`)
      .set(auth())
      .send({ hasta: null })
      .expect(204);
    expect((await listar()).items.find((x) => x.id === id)!.atencion).toBe('nueva');
  });

  it('en espera la saca de pendientes y no la cierra', async () => {
    const id = await conversacion('Cliente Difícil');
    const de = async () => (await listar()).items.find((x) => x.id === id)!;
    expect((await de()).atencion).toBe('nueva');

    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: true })
      .expect(204);

    const enEspera = await de();
    expect(enEspera.atencion).toBe('en_espera');
    expect(enEspera.enEspera).toBe(true);
    // Sale de «sin respuesta», que es el motivo de existir del gesto.
    expect((await listar('?sinRespuesta=true')).items.map((x) => x.id)).not.toContain(id);
    // Pero NO está cerrada: sigue en la bandeja de todas.
    expect((await listar()).items.map((x) => x.id)).toContain(id);
  });

  it('si el cliente vuelve a escribir, reaparece: callar al bot no es esconderlo', async () => {
    const id = await conversacion('Insiste Pérez');
    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: true })
      .expect(204);
    expect((await listar()).items.find((x) => x.id === id)!.atencion).toBe('en_espera');

    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() + interval '1 minute' WHERE id = $1`,
      [id],
    );

    const despues = (await listar()).items.find((x) => x.id === id)!;
    // Vuelve a verse, porque cinco mensajes sin que nadie se entere sería una
    // trampa. Pero sigue en espera: el bot no le va a contestar.
    expect(despues.atencion).not.toBe('en_espera');
    expect(despues.enEspera).toBe(true);
  });

  it('quitar la espera la devuelve al estado que le toque', async () => {
    const id = await conversacion('Ya Le Contesto');
    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: true })
      .expect(204);
    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: false })
      .expect(204);

    const vuelta = (await listar()).items.find((x) => x.id === id)!;
    expect(vuelta.atencion).toBe('nueva');
    expect(vuelta.enEspera).toBe(false);
  });

  it('cerrar levanta la espera: «resuelto» empieza de cero, bot incluido', async () => {
    const id = await conversacion('Resuelto Ramírez');
    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: true })
      .expect(204);
    await http
      .patch(`/v1/conversaciones/${id}/estado`)
      .set(auth())
      .send({ estado: 'closed' })
      .expect(204);

    const cerrada = (await listar()).items.find((x) => x.id === id)!;
    expect(cerrada.atencion).toBe('cerrada');
    // La diferencia entera entre «resuelto» y «en espera» vive aquí: sin esta
    // marca levantada, el bot seguiría mudo para siempre.
    expect(cerrada.enEspera).toBe(false);
  });

  /*
   * El globo de sin leer (0036/PR-82).
   *
   * Antes solo lo apagaba ENVIAR un mensaje, así que se llamaba «sin leer» y
   * significaba «sin responder»: quien abría un hilo, lo leía y decidía no
   * contestar se quedaba el aviso puesto para siempre.
   */
  const sinLeerDe = async (id: string) => (await listar()).items.find((x) => x.id === id)!.noLeidos;

  const llegaUnMensaje = async (id: string) =>
    admin.query(
      `UPDATE conversations
          SET unread_count = unread_count + 1, last_inbound_at = now()
        WHERE id = $1`,
      [id],
    );

  it('LEER los mensajes no apaga el globo: mirar no es decidir', async () => {
    const id = await conversacion('Solo Miraba');
    await llegaUnMensaje(id);
    const antes = await sinLeerDe(id);
    expect(antes).toBeGreaterThan(0);

    // Abrir el hilo es un GET, y un GET no cambia nada. En una bandeja
    // compartida, quien entra a ver de qué va no ha atendido nada: borrarle
    // el aviso al equipo dejaría la conversación con pinta de resuelta.
    await http.get(`/v1/conversaciones/${id}/mensajes`).set(auth()).expect(200);
    expect(await sinLeerDe(id)).toBe(antes);
  });

  it('poner en espera apaga el globo; quitarla no lo devuelve', async () => {
    const id = await conversacion('Espera Sin Globo');
    await llegaUnMensaje(id);
    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: true })
      .expect(204);
    expect(await sinLeerDe(id)).toBe(0);

    await http
      .patch(`/v1/conversaciones/${id}/espera`)
      .set(auth())
      .send({ enEspera: false })
      .expect(204);
    // Lo que estaba leído sigue leído: devolver el aviso sería inventarse que
    // hay algo nuevo que nadie ha visto.
    expect(await sinLeerDe(id)).toBe(0);
  });

  it('marcar resuelto apaga el globo', async () => {
    const id = await conversacion('Resuelto Sin Globo');
    await llegaUnMensaje(id);
    await http
      .patch(`/v1/conversaciones/${id}/estado`)
      .set(auth())
      .send({ estado: 'closed' })
      .expect(204);
    expect(await sinLeerDe(id)).toBe(0);
  });

  it('cerrar en bloque también: cincuenta cerradas no pueden seguir pidiendo atención', async () => {
    const a = await conversacion('Bloque Uno');
    const b = await conversacion('Bloque Dos');
    await llegaUnMensaje(a);
    await llegaUnMensaje(b);

    await http
      .post('/v1/conversaciones/cerrar')
      .set(auth())
      .send({ ids: [a, b] })
      .expect(200);
    expect(await sinLeerDe(a)).toBe(0);
    expect(await sinLeerDe(b)).toBe(0);
  });

  it('aplazar hacia atrás no aplaza nada', async () => {
    const id = await conversacion('Sin futuro');
    const r = await http
      .patch(`/v1/conversaciones/${id}/aplazar`)
      .set(auth())
      .send({ hasta: new Date(Date.now() - 60_000).toISOString() })
      .expect(422);
    expect(r.body.codigo).toBe('fecha_pasada');
  });

  it('la búsqueda encuentra por el nombre del contacto', async () => {
    await conversacion('Lucía Buscada');
    const r = await listar('?q=Buscada');
    expect(r.items).toHaveLength(1);
    expect((await listar('?q=nadie-asi')).items).toHaveLength(0);
  });

  it('las notas internas no son mensajes: quedan aparte y no tocan la ventana', async () => {
    const id = await conversacion('Con notas');
    const { body } = await http
      .post(`/v1/conversaciones/${id}/notas`)
      .set(auth())
      .send({ cuerpo: 'Pidió cuna y cama extra. Confirmar con limpieza.' })
      .expect(201);

    const notas = await http.get(`/v1/conversaciones/${id}/notas`).set(auth()).expect(200);
    expect(notas.body[0]).toMatchObject({
      cuerpo: 'Pidió cuna y cama extra. Confirmar con limpieza.',
    });
    expect(notas.body[0].autor).toBeTruthy();

    // No ha entrado en `messages`: si entrara, la puerta de envío podría
    // mandársela al cliente.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND body LIKE '%limpieza%'`,
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    await http.delete(`/v1/notas/${body.id}`).set(auth()).expect(204);
    expect((await http.get(`/v1/conversaciones/${id}/notas`).set(auth())).body).toHaveLength(0);
  });

  it('una vista guardada se vuelve a guardar con el mismo nombre en vez de fallar', async () => {
    const primera = await http
      .post('/v1/vistas')
      .set(auth())
      .send({ nombre: 'Sin responder de hoy', filtros: { sinRespuesta: 'true' } })
      .expect(201);

    const segunda = await http
      .post('/v1/vistas')
      .set(auth())
      .send({
        nombre: 'Sin responder de hoy',
        filtros: { sinRespuesta: 'true', canal: 'whatsapp' },
      })
      .expect(201);
    expect(segunda.body.id).toBe(primera.body.id);

    const vistas = (await http.get('/v1/vistas').set(auth()).expect(200)).body as {
      id: string;
      nombre: string;
      filtros: Record<string, string>;
    }[];
    expect(vistas).toHaveLength(1);
    expect(vistas[0]!.filtros).toEqual({ sinRespuesta: 'true', canal: 'whatsapp' });

    await http.delete(`/v1/vistas/${primera.body.id}`).set(auth()).expect(204);
    expect((await http.get('/v1/vistas').set(auth())).body).toHaveLength(0);
  });
});

describe('administrar etiquetas', () => {
  let tagId: string;
  let conv: string;

  beforeAll(async () => {
    tagId = (
      await http
        .post('/v1/etiquetas')
        .set(auth())
        .send({ nombre: 'Reserva julio', color: '#34c759' })
        .expect(201)
    ).body.id;
    conv = await conversacion('Elena-etiquetas', { haceHoras: 5 });
    await http
      .patch(`/v1/conversaciones/${conv}/etiquetas`)
      .set(auth())
      .send({ tagId, poner: true })
      .expect(204);
  });

  it('el listado de gestión dice dónde se usa cada etiqueta', async () => {
    const r = await http.get('/v1/etiquetas/uso').set(auth()).expect(200);
    const e = r.body.find((x: { id: string }) => x.id === tagId);
    expect(e).toMatchObject({
      nombre: 'Reserva julio',
      usos: { conversaciones: 1, clientes: 0, leads: 0 },
      bots: [],
    });
  });

  it('renombrar y recolorear la cambia en la conversación que ya la lleva', async () => {
    await http
      .patch(`/v1/etiquetas/${tagId}`)
      .set(auth())
      .send({ nombre: 'Reserva agosto', color: '#ff9500' })
      .expect(204);
    const lista = await http
      .get('/v1/conversaciones')
      .query({ limite: 100 })
      .set(auth())
      .expect(200);
    const c = lista.body.items.find((i: { id: string }) => i.id === conv);
    expect(c.etiquetas).toEqual([{ id: tagId, nombre: 'Reserva agosto', color: '#ff9500' }]);
  });

  it('un nombre que ya existe da 409', async () => {
    await http
      .post('/v1/etiquetas')
      .set(auth())
      .send({ nombre: 'Duplicada', color: null })
      .expect(201);
    const r = await http
      .patch(`/v1/etiquetas/${tagId}`)
      .set(auth())
      .send({ nombre: 'Duplicada' })
      .expect(409);
    expect(r.body.codigo).toBe('etiqueta_repetida');
  });

  it('un agente no puede editar ni borrar etiquetas', async () => {
    const inv = await http
      .post('/v1/invitaciones')
      .set(auth())
      .send({ email: 'agente-etiquetas@nippon.test', rol: 'agent' })
      .expect(201);
    const agente = (
      await http
        .post('/v1/invitaciones/aceptar')
        .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: 'Ag' })
        .expect(200)
    ).body.token;
    const a = { Authorization: `Bearer ${agente}` };
    await http.patch(`/v1/etiquetas/${tagId}`).set(a).send({ color: '#000000' }).expect(403);
    await http.delete(`/v1/etiquetas/${tagId}`).set(a).expect(403);
  });

  it('no se borra la que usa un bot en su versión vigente, y dice cuál', async () => {
    const flujo = (
      await admin.query<{ id: string }>(
        `INSERT INTO flows (tenant_id, name, status) VALUES ($1, 'Bienvenida', 'activo') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    const version = (
      await admin.query<{ id: string }>(
        `INSERT INTO flow_versions (tenant_id, flow_id, version, graph)
         VALUES ($1, $2, 1, $3) RETURNING id`,
        [
          tenantId,
          flujo,
          JSON.stringify({
            inicio: 'n1',
            nodos: [{ id: 'n1', tipo: 'etiquetar', etiquetaId: tagId, siguiente: null }],
          }),
        ],
      )
    ).rows[0]!.id;
    await admin.query(`UPDATE flows SET current_version_id = $1 WHERE id = $2`, [version, flujo]);

    const r = await http.delete(`/v1/etiquetas/${tagId}`).set(auth()).expect(409);
    expect(r.body).toMatchObject({ codigo: 'etiqueta_en_uso_por_bot', bots: ['Bienvenida'] });
    const uso = await http.get('/v1/etiquetas/uso').set(auth()).expect(200);
    expect(uso.body.find((x: { id: string }) => x.id === tagId).bots).toEqual(['Bienvenida']);

    // Quitada del bot (su versión vigente ya no la usa), se puede borrar.
    await admin.query(`UPDATE flows SET current_version_id = NULL WHERE id = $1`, [flujo]);
  });

  it('borrarla la quita de todo lo que la llevaba', async () => {
    await http.delete(`/v1/etiquetas/${tagId}`).set(auth()).expect(204);
    const { rows } = await admin.query(`SELECT 1 FROM conversation_tags WHERE tag_id = $1`, [
      tagId,
    ]);
    expect(rows).toHaveLength(0);
    await http.delete(`/v1/etiquetas/${tagId}`).set(auth()).expect(404);
  });
});

describe('reparto automático: configuración (0026)', () => {
  it('por defecto apagado, con los miembros y sus conversaciones abiertas', async () => {
    const r = await http.get('/v1/cuenta/reparto').set(auth()).expect(200);
    expect(r.body.modo).toBe('off');
    const yo = r.body.miembros.find((m: { userId: string }) => m.userId === userId);
    expect(yo).toMatchObject({ recibe: true, rol: 'owner' });
    expect(typeof yo.abiertas).toBe('number');
  });

  it('el propietario lo enciende y saca a alguien del reparto', async () => {
    const r = await http
      .put('/v1/cuenta/reparto')
      .set(auth())
      .send({ modo: 'least_busy', miembros: [{ userId, recibe: false }] })
      .expect(200);
    expect(r.body.modo).toBe('least_busy');
    expect(r.body.miembros.find((m: { userId: string }) => m.userId === userId).recibe).toBe(false);
  });

  it('un agente no puede cambiarlo', async () => {
    const inv = await http
      .post('/v1/invitaciones')
      .set(auth())
      .send({ email: 'agente-reparto@nippon.test', rol: 'agent' })
      .expect(201);
    const agente = (
      await http
        .post('/v1/invitaciones/aceptar')
        .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: 'Ag' })
        .expect(200)
    ).body.token;
    await http
      .put('/v1/cuenta/reparto')
      .set({ Authorization: `Bearer ${agente}` })
      .send({ modo: 'off' })
      .expect(403);
  });
});

describe('buscar dentro de los mensajes (0028)', () => {
  let conv: string;

  beforeAll(async () => {
    conv = await conversacion('Rosa Buscadora', { haceHoras: 6 });
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status)
       VALUES ($1, $2, $3, 'inbound', 'text', $4, 'delivered')`,
      [tenantId, conv, channelAccountId, '¿Tienen bungalow matrimonial para el 12 de julio?'],
    );
  });

  const buscar = async (q: string) =>
    (
      await http.get('/v1/conversaciones').query({ q, limite: 100 }).set(auth()).expect(200)
    ).body.items.map((i: { id: string }) => i.id);

  it('encuentra por una palabra dicha en la conversación', async () => {
    expect(await buscar('bungalow')).toContain(conv);
  });

  it('encuentra aunque la palabra esté en otra forma: reservas → reserva', async () => {
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status)
       VALUES ($1, $2, $3, 'outbound', 'text', 'Confirmamos tu reserva', 'sent')`,
      [tenantId, conv, channelAccountId],
    );
    expect(await buscar('reservas')).toContain(conv);
  });

  it('sigue encontrando por el nombre del contacto', async () => {
    expect(await buscar('Buscadora')).toContain(conv);
  });

  it('lo que nadie dijo no aparece', async () => {
    expect(await buscar('helicoptero')).not.toContain(conv);
  });
});

describe('cuando un bot pide una persona (0029)', () => {
  let conv: string;

  beforeAll(async () => {
    conv = await conversacion('Tomás Relevado', { haceHoras: 4 });
    await admin.query(
      `UPDATE conversations SET handoff_reason = $2, handoff_at = now() WHERE id = $1`,
      [conv, 'pregunta por un grupo de 20 personas'],
    );
  });

  const listar = async (q: Record<string, unknown> = {}) =>
    (
      await http
        .get('/v1/conversaciones')
        .query({ limite: 100, ...q })
        .set(auth())
        .expect(200)
    ).body.items as { id: string; relevo: { motivo: string } | null }[];

  it('el motivo viaja en el listado, para que se vea sin abrir el hilo', async () => {
    const fila = (await listar()).find((c) => c.id === conv);
    expect(fila?.relevo?.motivo).toBe('pregunta por un grupo de 20 personas');
  });

  it('el filtro «piden persona» deja solo esas', async () => {
    const ids = (await listar({ relevo: 'true' })).map((c) => c.id);
    expect(ids).toContain(conv);
    expect(ids).toHaveLength(1);
  });

  it('las demás conversaciones no traen relevo', async () => {
    const otras = (await listar()).filter((c) => c.id !== conv);
    expect(otras.every((c) => c.relevo === null)).toBe(true);
  });
});

describe('quién dijo cada cosa', () => {
  let conv: string;

  beforeAll(async () => {
    conv = await conversacion('Julia Testigo', { haceHoras: 2 });
  });

  const mensajes = async () =>
    (await http.get(`/v1/conversaciones/${conv}/mensajes`).set(auth()).expect(200)).body.items as {
      direccion: string;
      origen: string;
      autor: string | null;
      autor_id: string | null;
    }[];

  it('lo que escribe una persona lleva su nombre', async () => {
    await http
      .post(`/v1/conversaciones/${conv}/mensajes`)
      .set(auth())
      .send({ tipo: 'text', texto: 'Buenas, le confirmo el bungalow' })
      .expect(202);

    const ultimo = (await mensajes())[0]!;
    expect(ultimo).toMatchObject({ direccion: 'outbound', origen: 'human', autor: 'Jefe' });
    expect(ultimo.autor_id).toBe(userId);
  });

  it('lo que entra no tiene autor del lado del hotel', async () => {
    const entrante = (await mensajes()).find((m) => m.direccion === 'inbound')!;
    expect(entrante.autor).toBeNull();
    expect(entrante.autor_id).toBeNull();
  });

  it('lo que manda un bot tampoco tiene persona detrás', async () => {
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, sent_by)
       VALUES ($1, $2, $3, 'outbound', 'text', 'Soy un bot', 'sent', 'bot')`,
      [tenantId, conv, channelAccountId],
    );
    const delBot = (await mensajes()).find((m) => m.origen === 'bot')!;
    expect(delBot.autor).toBeNull();
  });

  it('el mensaje sobrevive a que su autor deje el equipo', async () => {
    // La membresía se va; el mensaje se queda. Borrar el historial porque
    // alguien se fue sería perder lo que se le dijo al cliente.
    const otro = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Vecina',
        slug: 'vecina-autores',
        email: 'vecina-autores@test.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Vecina',
      })
      .expect(201);
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, sent_by, sent_by_user_id)
       VALUES ($1, $2, $3, 'outbound', 'text', 'De alguien de fuera', 'sent', 'human', $4)`,
      [tenantId, conv, channelAccountId, otro.body.userId],
    );
    // RLS: un usuario de otra cuenta no se resuelve aquí, así que el hilo
    // sigue entero y sin nombre, en vez de romperse.
    const huerfano = (await mensajes()).find((m) => m.direccion === 'outbound')!;
    expect(huerfano).toBeTruthy();
  });
});

describe('cerrar en bloque', () => {
  const estadoDe = async (id: string) =>
    (
      await admin.query<{ status: string; human_reply_at: Date | null }>(
        `SELECT status, human_reply_at FROM conversations WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  it('cierra las marcadas y deja de contarlas como sin responder', async () => {
    const a = await conversacion('Bloque A', { haceHoras: 40 });
    const b = await conversacion('Bloque B', { haceHoras: 40 });

    const antes = await http
      .get('/v1/conversaciones')
      .query({ atencion: 'nueva', limite: 100 })
      .set(auth())
      .expect(200);
    expect(antes.body.items.map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining([a, b]),
    );

    const r = await http
      .post('/v1/conversaciones/cerrar')
      .set(auth())
      .send({ ids: [a, b] })
      .expect(200);
    expect(r.body.cerradas).toBe(2);

    const despues = await http
      .get('/v1/conversaciones')
      .query({ atencion: 'nueva', limite: 100 })
      .set(auth())
      .expect(200);
    const ids = despues.body.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
  });

  it('cerrar devuelve el turno a los bots, igual que cerrar una sola', async () => {
    const c = await conversacion('Bloque Bot', { haceHoras: 5, respondida: true });
    expect((await estadoDe(c)).human_reply_at).not.toBeNull();
    await http
      .post('/v1/conversaciones/cerrar')
      .set(auth())
      .send({ ids: [c] })
      .expect(200);
    expect((await estadoDe(c)).human_reply_at).toBeNull();
  });

  it('las que ya estaban cerradas no se cuentan dos veces', async () => {
    const c = await conversacion('Bloque Repetida', { haceHoras: 6 });
    await http
      .post('/v1/conversaciones/cerrar')
      .set(auth())
      .send({ ids: [c] })
      .expect(200);
    const otra = await http
      .post('/v1/conversaciones/cerrar')
      .set(auth())
      .send({ ids: [c] })
      .expect(200);
    // Quien marca cincuenta filas no ha mirado el estado de cada una.
    expect(otra.body.cerradas).toBe(0);
  });

  it('una conversación de otra cuenta no se cierra: ni siquiera se ve', async () => {
    const mia = await conversacion('Bloque Mía', { haceHoras: 7 });
    const otra = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Ajena cierre',
        slug: 'ajena-cierre',
        email: 'ajena-cierre@test.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Ajena',
      })
      .expect(201);

    // La cabecera se pone a mano: el `auth()` de este fichero usa siempre el
    // token de la cuenta principal e ignora lo que se le pase, y con él la
    // petición iba como yo mismo — el test decía «fuga» sin haberla.
    const r = await http
      .post('/v1/conversaciones/cerrar')
      .set({ Authorization: `Bearer ${otra.body.token as string}` })
      .send({ ids: [mia] })
      .expect(200);
    expect(r.body.cerradas).toBe(0);
    expect((await estadoDe(mia)).status).not.toBe('closed');
  });

  it('hay un tope: cerrar doscientas de un clic no tiene deshacer', async () => {
    const muchas = Array.from(
      { length: 101 },
      (_, i) => `01a00000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    await http.post('/v1/conversaciones/cerrar').set(auth()).send({ ids: muchas }).expect(400);
  });
});
