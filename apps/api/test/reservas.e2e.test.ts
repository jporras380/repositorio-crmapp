/**
 * Reservas por HTTP.
 *
 * El caso central es el criterio 10 del encargo —crear una reserva desde una
 * conversación— y alrededor, lo que costaría dinero equivocar: que el precio
 * lo ponga el servidor y no la pantalla, que la reserva no cambie cuando cambia
 * la tarifa, y que confirmarla gane el lead del embudo.
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
const DB = 'crmapp_test_reservas';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let tipoFamiliar: string;
let tipoDoble: string;
let habitacion1: string;
let habitacionDoble: string;
let desayuno: string;

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function alta(slug: string) {
  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: slug,
      slug,
      email: `${slug}@test.test`,
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Recepción',
    })
    .expect(201);
  return r.body as { token: string };
}

/** Una conversación de WhatsApp con su lead abierto, como la dejaría la ingesta. */
async function conversacionConLead(nombre: string) {
  const ca = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
       VALUES ($1,'whatsapp',$2,'WA') RETURNING id`,
      [tenantId, `pn-${nombre}`],
    )
  ).rows[0]!.id;
  const contacto = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
      [tenantId, nombre],
    )
  ).rows[0]!.id;
  const identidad = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1,$2,'whatsapp',$3,$4) RETURNING id`,
      [tenantId, contacto, ca, `wa-${nombre}`],
    )
  ).rows[0]!.id;
  const conversacion = (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, identidad, contacto, ca],
    )
  ).rows[0]!.id;
  const lead = (
    await admin.query<{ id: string }>(
      `INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, conversation_id, title)
       SELECT $1, p.id, s.id, $2, $3, 'Consulta de ' || $4
         FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id = p.id AND s.position = 0
        WHERE p.tenant_id = $1 AND p.is_default
       RETURNING id`,
      [tenantId, contacto, conversacion, nombre],
    )
  ).rows[0]!.id;
  return { contacto, conversacion, lead };
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
      // Reloj fijo: las fechas de estas pruebas son de 2026 y 2027, y sin esto
      // pasarían a estar «en el pasado» con el calendario y el test se pudriría.
      ahora: () => new Date('2026-01-15T12:00:00Z'),
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
  tenantId = (await admin.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'paraiso'`))
    .rows[0]!.id;

  // El catálogo, por la API real.
  tipoFamiliar = (
    await http
      .post('/v1/hotel/tipos')
      .set(auth())
      .send({ nombre: 'Familiar', capacidad: 5, precioBase: 26_000 })
      .expect(201)
  ).body.id;
  tipoDoble = (
    await http
      .post('/v1/hotel/tipos')
      .set(auth())
      .send({ nombre: 'Doble', capacidad: 2, precioBase: 14_000 })
      .expect(201)
  ).body.id;
  habitacion1 = (
    await http
      .post('/v1/hotel/habitaciones')
      .set(auth())
      .send({ tipoId: tipoFamiliar, nombre: 'Familiar 101' })
      .expect(201)
  ).body.id;
  habitacionDoble = (
    await http
      .post('/v1/hotel/habitaciones')
      .set(auth())
      .send({ tipoId: tipoDoble, nombre: 'Doble 1' })
      .expect(201)
  ).body.id;
  await http
    .post('/v1/hotel/tarifas')
    .set(auth())
    .send({
      tipoId: tipoFamiliar,
      nombre: 'Fiestas Patrias',
      desde: '2026-07-27',
      hasta: '2026-07-29',
      precio: 42_000,
      minNoches: 2,
    })
    .expect(201);
  desayuno = (
    await http
      .post('/v1/hotel/servicios')
      .set(auth())
      .send({ nombre: 'Desayuno', precio: 1_800, unidad: 'por_persona_noche' })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('crear una reserva desde la conversación (criterio 10)', () => {
  it('copia la cotización con sus líneas y se cuelga del lead abierto', async () => {
    const { conversacion, lead } = await conversacionConLead('Rosa');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoFamiliar,
        entrada: '2026-07-26',
        salida: '2026-07-29',
        personas: 3,
        servicios: [desayuno],
      })
      .expect(201);

    // 26: base 260 · 27 y 28: Fiestas Patrias 420 · 9 desayunos a 18.
    expect(r.body).toMatchObject({
      estado: 'pendiente',
      tipo: 'Familiar',
      noches: 3,
      total: 26_000 + 42_000 * 2 + 9 * 1_800,
      leadId: lead,
      acciones: ['confirmar', 'cancelar'],
    });
    expect(
      r.body.lineas.map((l: { tipo: string; descripcion: string }) => [l.tipo, l.descripcion]),
    ).toEqual([
      ['noche', 'Precio base'],
      ['noche', 'Fiestas Patrias'],
      ['noche', 'Fiestas Patrias'],
      ['servicio', 'Desayuno'],
    ]);
    expect(r.body.saldo).toMatchObject({ pagado: 0, pendiente: r.body.total });

    // Y la conversación sabe que tiene reserva: es lo que pinta la ficha.
    const deLaConversacion = await http
      .get(`/v1/reservas?conversacionId=${conversacion}`)
      .set(auth())
      .expect(200);
    expect(deLaConversacion.body).toHaveLength(1);
  });

  it('el precio lo pone el servidor: un total mandado desde la pantalla se rechaza', async () => {
    const { conversacion } = await conversacionConLead('Tramposo');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2026-09-01',
        salida: '2026-09-02',
        personas: 2,
        total: 1,
      })
      .expect(400);
    expect(r.body.codigo).toBe('datos_invalidos');
  });

  it('cambiar la tarifa mañana NO cambia la reserva de hoy', async () => {
    const { conversacion } = await conversacionConLead('Luis');
    const antes = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2026-10-01',
        salida: '2026-10-03',
        personas: 2,
      })
      .expect(201);
    expect(antes.body.total).toBe(28_000);

    await http
      .patch(`/v1/hotel/tipos/${tipoDoble}`)
      .set(auth())
      .send({ precioBase: 99_000 })
      .expect(204);

    const despues = await http.get(`/v1/reservas/${antes.body.id}`).set(auth()).expect(200);
    expect(despues.body.total).toBe(28_000);
    expect(despues.body.lineas[0].unitario).toBe(14_000);
    await http
      .patch(`/v1/hotel/tipos/${tipoDoble}`)
      .set(auth())
      .send({ precioBase: 14_000 })
      .expect(204);
  });

  it('una cotización con avisos no se reserva sin aceptarlos a sabiendas', async () => {
    const { conversacion } = await conversacionConLead('Pedro');
    // Una sola noche de Fiestas Patrias: la tarifa pide dos.
    const sinAceptar = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoFamiliar,
        entrada: '2026-07-27',
        salida: '2026-07-28',
        personas: 2,
      })
      .expect(422);
    expect(sinAceptar.body.codigo).toBe('cotizacion_con_avisos');
    expect(sinAceptar.body.problemas[0].codigo).toBe('minimo_de_noches');

    await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoFamiliar,
        entrada: '2026-07-27',
        salida: '2026-07-28',
        personas: 2,
        aceptarAvisos: true,
      })
      .expect(201);
  });

  it('una entrada en el pasado se avisa: equivocarse de año no pasa en silencio', async () => {
    const { conversacion } = await conversacionConLead('Despistado');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2026-01-05',
        salida: '2026-01-07',
        personas: 2,
      })
      .expect(422);
    expect(r.body.codigo).toBe('cotizacion_con_avisos');
    expect(r.body.problemas.map((p: { codigo: string }) => p.codigo)).toContain('entrada_pasada');

    // Registrar tarde la estancia de alguien que ya vino es legítimo, a sabiendas.
    await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2026-01-05',
        salida: '2026-01-07',
        personas: 2,
        aceptarAvisos: true,
      })
      .expect(201);
  });

  it('un descuento queda como línea propia y no puede superar el total', async () => {
    const { contacto } = await conversacionConLead('Marta');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: contacto,
        tipoId: tipoDoble,
        entrada: '2026-11-01',
        salida: '2026-11-03',
        personas: 2,
        descuento: { importe: 3_000, motivo: 'Cliente recurrente' },
      })
      .expect(201);
    expect(r.body.total).toBe(25_000);
    expect(r.body.lineas.at(-1)).toMatchObject({
      tipo: 'descuento',
      descripcion: 'Cliente recurrente',
      total: -3_000,
    });

    const excesivo = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: contacto,
        tipoId: tipoDoble,
        entrada: '2026-11-10',
        salida: '2026-11-11',
        personas: 2,
        descuento: { importe: 999_999, motivo: 'Error' },
      })
      .expect(422);
    expect(excesivo.body.codigo).toBe('descuento_excesivo');
  });
});

describe('ciclo de vida', () => {
  it('confirmar gana el lead del embudo, en la misma operación', async () => {
    const { conversacion, lead } = await conversacionConLead('Carla');
    const { body: reserva } = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2026-12-01',
        salida: '2026-12-03',
        personas: 2,
      })
      .expect(201);

    const confirmada = await http
      .patch(`/v1/reservas/${reserva.id}/estado`)
      .set(auth())
      .send({ accion: 'confirmar' })
      .expect(200);
    expect(confirmada.body).toMatchObject({
      estado: 'confirmada',
      acciones: ['llegar', 'cancelar'],
    });

    const { rows } = await admin.query<{ status: string; kind: string; amount_cents: string }>(
      `SELECT l.status, s.kind, l.amount_cents FROM leads l
         JOIN pipeline_stages s ON s.id = l.stage_id WHERE l.id = $1`,
      [lead],
    );
    expect(rows[0]).toMatchObject({ status: 'ganado', kind: 'ganada' });
    expect(Number(rows[0]!.amount_cents)).toBe(reserva.total);
  });

  it('no hay check-in sin confirmar, ni cancelación de quien ya está en casa', async () => {
    const { conversacion } = await conversacionConLead('Jorge');
    const { body: reserva } = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        conversacionId: conversacion,
        tipoId: tipoDoble,
        entrada: '2027-01-05',
        salida: '2027-01-06',
        personas: 1,
      })
      .expect(201);

    const sinConfirmar = await http
      .patch(`/v1/reservas/${reserva.id}/estado`)
      .set(auth())
      .send({ accion: 'llegar' })
      .expect(409);
    expect(sinConfirmar.body.codigo).toBe('transicion_no_permitida');

    for (const accion of ['confirmar', 'llegar']) {
      await http
        .patch(`/v1/reservas/${reserva.id}/estado`)
        .set(auth())
        .send({ accion })
        .expect(200);
    }
    const cancelar = await http
      .patch(`/v1/reservas/${reserva.id}/estado`)
      .set(auth())
      .send({ accion: 'cancelar' })
      .expect(409);
    expect(cancelar.body.mensaje).toMatch(/registra la salida/);

    const fin = await http
      .patch(`/v1/reservas/${reserva.id}/estado`)
      .set(auth())
      .send({ accion: 'salir' })
      .expect(200);
    expect(fin.body).toMatchObject({ estado: 'finalizada', acciones: [] });
    expect(fin.body.historial.map((h: { tipo: string }) => h.tipo)).toEqual([
      'creada',
      'confirmar',
      'llegar',
      'salir',
    ]);
  });

  it('los pagos llevan el saldo, y pagar de más se dice como saldo a favor', async () => {
    const { contacto } = await conversacionConLead('Elena');
    const { body: reserva } = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: contacto,
        tipoId: tipoDoble,
        entrada: '2027-02-01',
        salida: '2027-02-03',
        personas: 2,
      })
      .expect(201);

    await http
      .post(`/v1/reservas/${reserva.id}/pagos`)
      .set(auth())
      .send({ importe: 10_000, metodo: 'yape' })
      .expect(201);
    const r = await http
      .post(`/v1/reservas/${reserva.id}/pagos`)
      .set(auth())
      .send({ importe: 20_000, metodo: 'efectivo', referencia: 'Recibo 0042' })
      .expect(201);
    expect(r.body.saldo).toEqual({ total: 28_000, pagado: 30_000, pendiente: 0, aFavor: 2_000 });
    expect(r.body.pagos.map((p: { metodo: string }) => p.metodo)).toEqual(['yape', 'efectivo']);
  });

  it('en una reserva cancelada no se cobra', async () => {
    const { contacto } = await conversacionConLead('Cancela');
    const { body: reserva } = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: contacto,
        tipoId: tipoDoble,
        entrada: '2027-03-01',
        salida: '2027-03-02',
        personas: 1,
      })
      .expect(201);
    await http
      .patch(`/v1/reservas/${reserva.id}/estado`)
      .set(auth())
      .send({ accion: 'cancelar' })
      .expect(200);
    const r = await http
      .post(`/v1/reservas/${reserva.id}/pagos`)
      .set(auth())
      .send({ importe: 1_000, metodo: 'efectivo' })
      .expect(409);
    expect(r.body.codigo).toBe('reserva_cancelada');
  });
});

describe('habitación concreta', () => {
  it('dos reservas vivas en la misma habitación que comparten noche se AVISAN, no se bloquean', async () => {
    const a = await conversacionConLead('Uno');
    const b = await conversacionConLead('Dos');
    const primera = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: a.contacto,
        tipoId: tipoFamiliar,
        entrada: '2026-08-10',
        salida: '2026-08-13',
        personas: 2,
        habitacionId: habitacion1,
      })
      .expect(201);
    expect(primera.body.solapes).toEqual([]);

    const segunda = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: b.contacto,
        tipoId: tipoFamiliar,
        entrada: '2026-08-12',
        salida: '2026-08-14',
        personas: 2,
        habitacionId: habitacion1,
      })
      .expect(201);
    expect(segunda.body.solapes).toHaveLength(1);
    expect(segunda.body.solapes[0]).toMatchObject({ contacto: 'Uno', entrada: '2026-08-10' });
  });

  it('salir el 13 y entrar otro el 13 no es un solape', async () => {
    const c = await conversacionConLead('Tres');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: c.contacto,
        tipoId: tipoFamiliar,
        entrada: '2026-08-14',
        salida: '2026-08-16',
        personas: 2,
        habitacionId: habitacion1,
      })
      .expect(201);
    expect(r.body.solapes).toEqual([]);
  });

  it('no se asigna una habitación de otro tipo que el reservado', async () => {
    const c = await conversacionConLead('Cuatro');
    const r = await http
      .post('/v1/reservas')
      .set(auth())
      .send({
        contactoId: c.contacto,
        tipoId: tipoFamiliar,
        entrada: '2026-09-20',
        salida: '2026-09-21',
        personas: 2,
        habitacionId: habitacionDoble,
      })
      .expect(422);
    expect(r.body.codigo).toBe('habitacion_de_otro_tipo');
  });
});

describe('aislamiento', () => {
  it('las reservas del hotel de al lado no existen', async () => {
    const r = await http.get('/v1/reservas').set(auth(tokenAjeno)).expect(200);
    expect(r.body).toEqual([]);
  });

  it('sin sesión no hay reservas', async () => {
    await http.get('/v1/reservas').expect(401);
  });
});
