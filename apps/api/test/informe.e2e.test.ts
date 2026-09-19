/**
 * El informe del periodo, por HTTP y con números exactos.
 *
 * Todo el escenario se construye con fechas explícitas y un reloj fijo: los
 * valores por defecto de la base usan el `now()` de verdad, y con él una fila
 * «de hoy» caería fuera de la ventana y el test pasaría o fallaría según el
 * día en que se ejecute.
 *
 * Lo que se prueba es lo que un informe puede hacer mentir: la mediana y el
 * p90 en lugar de una media, que confirmadas y canceladas cuenten por su
 * evento, que la conversión sea sobre una cohorte, y que el estado de
 * atención dé lo mismo que la bandeja.
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
const DB = 'crmapp_test_informe';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

const RELOJ = new Date('2026-03-10T12:00:00Z');
/** Un instante N horas antes del reloj fijo. */
const hace = (horas: number) => new Date(RELOJ.getTime() - horas * 3_600_000);

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let duena: string;

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function alta(slug: string) {
  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: slug,
      slug,
      email: `${slug}@test.test`,
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: `Dueña de ${slug}`,
    })
    .expect(201);
  return r.body as { token: string };
}

async function uno<T>(sql: string, params: unknown[]): Promise<T> {
  return (await admin.query(sql, params)).rows[0] as T;
}

/** Contacto + identidad + conversación, todo con la fecha que se le diga. */
async function conversacion(o: {
  canal: string;
  cuenta: string;
  creada: Date;
  respondidaTrasSegundos?: number;
  ultimoEntrante?: Date;
  ultimoSaliente?: Date;
  asignada?: string;
}) {
  const { id: contacto } = await uno<{ id: string }>(
    `INSERT INTO contacts (tenant_id, display_name, created_at) VALUES ($1, 'Huésped', $2) RETURNING id`,
    [tenantId, o.creada],
  );
  const { id: identidad } = await uno<{ id: string }>(
    `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
     VALUES ($1,$2,$3,$4, uuidv7()::text) RETURNING id`,
    [tenantId, contacto, o.canal, o.cuenta],
  );
  const { id } = await uno<{ id: string }>(
    `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id,
                                created_at, first_response_at, last_inbound_at, last_outbound_at,
                                human_reply_at, assignee_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      tenantId,
      identidad,
      contacto,
      o.cuenta,
      o.creada,
      o.respondidaTrasSegundos === undefined
        ? null
        : new Date(o.creada.getTime() + o.respondidaTrasSegundos * 1000),
      o.ultimoEntrante ?? o.creada,
      o.ultimoSaliente ?? null,
      o.ultimoSaliente ?? null,
      o.asignada ?? null,
    ],
  );
  return { id, contacto };
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
  // `messages` está particionada por mes y la migración solo crea las del mes
  // real en adelante; el escenario vive en febrero y marzo de 2026.
  for (const mes of ['2026-02-01', '2026-03-01']) {
    await conf.query(`SELECT app.ensure_partition('messages', $1::date)`, [mes]);
  }
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', 'crmapp_dev'),
      authDatabaseUrl: url(DB, 'crmapp_auth', 'crmapp_dev'),
      jwtSecret: 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres',
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
      modoSandbox: true,
      ahora: () => RELOJ,
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());
  token = (await alta('paraiso')).token;
  tokenAjeno = (await alta('otro-hotel')).token;
  ({ id: tenantId } = await uno<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'paraiso'`,
    [],
  ));
  ({ id: duena } = await uno<{ id: string }>(
    `SELECT user_id AS id FROM memberships WHERE tenant_id = $1`,
    [tenantId],
  ));

  // --- El escenario -----------------------------------------------------------
  const { id: wa } = await uno<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
     VALUES ($1,'whatsapp','pn-informe','WA') RETURNING id`,
    [tenantId],
  );
  const { id: ig } = await uno<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
     VALUES ($1,'instagram','ig-informe','IG') RETURNING id`,
    [tenantId],
  );

  // Tres de WhatsApp y una de Instagram en la última semana; respondidas en
  // 2 min, 10 min y 1 h. Mediana 600 s; p90 = 600 + 0,8 × 3000 = 3000 s.
  const a = await conversacion({
    canal: 'whatsapp',
    cuenta: wa,
    creada: hace(26),
    respondidaTrasSegundos: 120,
    // Escribió el cliente después de nuestra respuesta: por responder, y
    // asignada a la dueña.
    ultimoSaliente: hace(25),
    ultimoEntrante: hace(2),
    asignada: duena,
  });
  const b = await conversacion({
    canal: 'whatsapp',
    cuenta: wa,
    creada: hace(30),
    respondidaTrasSegundos: 600,
  });
  await conversacion({
    canal: 'whatsapp',
    cuenta: wa,
    creada: hace(50),
    respondidaTrasSegundos: 3600,
  });
  await conversacion({ canal: 'instagram', cuenta: ig, creada: hace(60) });
  // Hace diez días: fuera de la semana, dentro del mes.
  await conversacion({ canal: 'whatsapp', cuenta: wa, creada: hace(240) });

  // Dos respuestas humanas de la dueña en la semana, una de hace un mes.
  for (const cuando of [hace(25), hace(3), hace(24 * 20)]) {
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body,
                             status, sent_by, sent_by_user_id, created_at)
       VALUES ($1,$2,$3,'outbound','text','hola','sent','human',$4,$5)`,
      [tenantId, a.id, wa, duena, cuando],
    );
  }

  // Embudo: dos consultas en la semana (A y B); A termina en reserva; una
  // perdida en la semana.
  const { pipeline, primera, perdida } = await uno<{
    pipeline: string;
    primera: string;
    perdida: string;
  }>(
    `SELECT p.id AS pipeline,
            (SELECT id FROM pipeline_stages WHERE pipeline_id = p.id ORDER BY position LIMIT 1) AS primera,
            (SELECT id FROM pipeline_stages WHERE pipeline_id = p.id AND kind = 'perdida' LIMIT 1) AS perdida
       FROM pipelines p WHERE p.tenant_id = $1 AND p.is_default`,
    [tenantId],
  );
  for (const [contacto, creada] of [
    [a.contacto, hace(26)],
    [b.contacto, hace(30)],
  ] as const) {
    await admin.query(
      `INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, title, created_at)
       VALUES ($1,$2,$3,$4,'Consulta',$5)`,
      [tenantId, pipeline, primera, contacto, creada],
    );
  }
  const viejo = await conversacion({ canal: 'whatsapp', cuenta: wa, creada: hace(24 * 40) });
  await admin.query(
    `INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, title, status, created_at, closed_at)
     VALUES ($1,$2,$3,$4,'Se fue a otro hotel','perdido',$5,$6)`,
    [tenantId, pipeline, perdida, viejo.contacto, hace(24 * 40), hace(5)],
  );

  // Reservas: A reserva y confirma en la semana (S/ 900) y paga S/ 300; otra
  // se crea y se cancela en la semana.
  const { id: tipo } = await uno<{ id: string }>(
    `INSERT INTO room_types (tenant_id, name, capacity, base_rate_cents) VALUES ($1,'Familiar',5,30000) RETURNING id`,
    [tenantId],
  );
  const reserva = async (contacto: string, total: number, estado: string) =>
    (
      await uno<{ id: string }>(
        `INSERT INTO reservations (tenant_id, contact_id, room_type_id, room_type_name, check_in, check_out,
                                   guests, status, total_cents, created_at)
         VALUES ($1,$2,$3,'Familiar','2026-04-01','2026-04-04',3,$4,$5,$6) RETURNING id`,
        [tenantId, contacto, tipo, estado, total, hace(20)],
      )
    ).id;
  const confirmada = await reserva(a.contacto, 90_000, 'confirmada');
  const cancelada = await reserva(b.contacto, 60_000, 'cancelada');
  for (const [id, type, cuando] of [
    [confirmada, 'creada', hace(20)],
    [confirmada, 'confirmar', hace(10)],
    [cancelada, 'creada', hace(20)],
    [cancelada, 'cancelar', hace(8)],
  ] as const) {
    await admin.query(
      `INSERT INTO reservation_events (tenant_id, reservation_id, type, at) VALUES ($1,$2,$3,$4)`,
      [tenantId, id, type, cuando],
    );
  }
  await admin.query(
    `INSERT INTO reservation_payments (tenant_id, reservation_id, amount_cents, method, paid_at)
     VALUES ($1,$2,30000,'yape',$3)`,
    [tenantId, confirmada, hace(9)],
  );
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('informe de los últimos 7 días', () => {
  const informe = async (periodo = '7d') =>
    (await http.get(`/v1/panel/informe?periodo=${periodo}`).set(auth()).expect(200)).body;

  it('cuenta las conversaciones nuevas por canal, dentro de la ventana y solo dentro', async () => {
    const r = await informe();
    expect(r.conversaciones.nuevas).toBe(4);
    expect(r.conversaciones.porCanal).toEqual([
      { canal: 'whatsapp', nuevas: 3 },
      { canal: 'instagram', nuevas: 1 },
    ]);
    // La de hace diez días entra en el mes, no en la semana.
    expect((await informe('30d')).conversaciones.nuevas).toBe(5);
  });

  it('mediana y p90, no media: una respuesta lenta no disfraza el día normal', async () => {
    const r = await informe();
    expect(r.respuesta).toEqual({ medianaSegundos: 600, p90Segundos: 3000, medidas: 3 });
    // La media habría sido 1440 s: ni el día normal ni el peor caso.
  });

  it('por agente: lo asignado, lo que le toca responder y lo que respondió en el periodo', async () => {
    const r = await informe();
    const d = r.agentes.find((a: { id: string }) => a.id === duena);
    expect(d).toMatchObject({ asignadasAbiertas: 1, porResponder: 1, respuestasEnviadas: 2 });
  });

  it('el estado de atención de ahora usa la misma definición que la bandeja', async () => {
    const r = await informe();
    const bandeja = await http
      .get('/v1/conversaciones?atencion=por_responder')
      .set(auth())
      .expect(200);
    expect(r.conversaciones.atencionAhora.por_responder).toBe(bandeja.body.items.length);
  });

  it('confirmadas y canceladas cuentan por su evento, e importes por moneda', async () => {
    const r = await informe();
    expect(r.reservas).toEqual({
      generadas: 2,
      confirmadas: 1,
      canceladas: 1,
      porMoneda: [{ moneda: 'PEN', confirmado: 90_000, cobrado: 30_000 }],
    });
    // Las dos se crearon hace 20 h y se movieron hace 8–10 h: también caen en las últimas 24 h.
    expect((await informe('24h')).reservas).toMatchObject({
      generadas: 2,
      confirmadas: 1,
      canceladas: 1,
    });
  });

  it('la conversión es de una cohorte: de las consultas de la semana, cuántas reservaron', async () => {
    const r = await informe();
    expect(r.embudo).toEqual({ consultas: 2, conReserva: 1, perdidas: 1 });
  });

  it('clientes nuevos son los creados en la ventana', async () => {
    expect((await informe()).clientesNuevos).toBe(4);
  });

  it('un periodo que no existe se rechaza', async () => {
    const r = await http.get('/v1/panel/informe?periodo=anual').set(auth()).expect(400);
    expect(r.body.codigo).toBe('periodo_invalido');
  });

  it('el hotel de al lado no ve nada de esto', async () => {
    const r = await http.get('/v1/panel/informe?periodo=30d').set(auth(tokenAjeno)).expect(200);
    expect(r.body.conversaciones.nuevas).toBe(0);
    expect(r.body.reservas.generadas).toBe(0);
  });
});
