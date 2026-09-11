/**
 * El embudo por HTTP.
 *
 * Lo que se prueba son las reglas que protegen el número que mira el jefe de
 * ventas: el pronóstico suma solo lo que sigue en juego, una etapa no se lleva
 * por delante los leads que tiene dentro, y un contacto no acumula dos
 * oportunidades abiertas a la vez en el mismo embudo.
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
const DB = 'crmapp_test_embudo';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let embudoId: string;
let etapas: { id: string; nombre: string; tipo: string }[];

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

/** Un huésped. No hace falta conversación para tener lead. */
async function contacto(nombre: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
    [tenantId, nombre],
  );
  return rows[0]!.id;
}

const etapa = (nombre: string) => etapas.find((e) => e.nombre === nombre)!.id;

async function crearLead(contactoId: string, titulo: string, importe = 0, etapaId?: string) {
  const r = await http
    .post('/v1/leads')
    .set(auth())
    .send({ contactoId, titulo, importe, ...(etapaId ? { etapaId } : {}) })
    .expect(201);
  return (r.body as { id: string }).id;
}

async function tablero() {
  const r = await http.get('/v1/leads/tablero').set(auth()).expect(200);
  return r.body as {
    embudo: { id: string; nombre: string; moneda: string };
    pronostico: number;
    leadsAbiertos: number;
    columnas: { etapa: { id: string; nombre: string }; total: number; importe: number }[];
  };
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
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app`);
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', 'crmapp_dev'),
      jwtSecret: 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres',
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
      modoSandbox: true,
    }),
    { logger: false, rawBody: true },
  );
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());
  token = (await alta('hotel')).token;
  tokenAjeno = (await alta('otro-hotel')).token;
  tenantId = (await admin.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'hotel'`))
    .rows[0]!.id;

  const r = await http.get('/v1/embudos').set(auth()).expect(200);
  const embudo = (r.body as { id: string; etapas: typeof etapas }[])[0]!;
  embudoId = embudo.id;
  etapas = embudo.etapas;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('embudo', () => {
  it('una cuenta nueva ya viene con su embudo montado', async () => {
    const r = await http.get('/v1/embudos').set(auth()).expect(200);
    const embudos = r.body as { nombre: string; moneda: string; etapas: { nombre: string }[] }[];
    expect(embudos).toHaveLength(1);
    expect(embudos[0]!.nombre).toBe('Reservas');
    expect(embudos[0]!.moneda).toBe('PEN');
    // El recorrido de una reserva, no un tablero en blanco que nadie sabe llenar.
    expect(embudos[0]!.etapas.map((e) => e.nombre)).toEqual([
      'Consulta',
      'Interesado',
      'Cotización enviada',
      'Reserva pendiente',
      'Confirmada',
      'Perdida',
    ]);
  });

  it('el pronóstico suma lo que sigue en juego, no lo ya cerrado', async () => {
    const ana = await contacto('Ana Quispe');
    const luis = await contacto('Luis Ramos');
    await crearLead(ana, 'Bungalow matrimonial, 2 noches', 45_000);
    const deLuis = await crearLead(luis, 'Familiar VIP para 5', 90_000);

    expect((await tablero()).pronostico).toBe(135_000);

    // Se confirma la de Luis: sale del pronóstico y queda cerrada como ganada.
    await http
      .patch(`/v1/leads/${deLuis}`)
      .set(auth())
      .send({ etapaId: etapa('Confirmada') })
      .expect(200);

    const t = await tablero();
    expect(t.pronostico).toBe(45_000);
    expect(t.leadsAbiertos).toBe(1);
    const confirmada = t.columnas.find((c) => c.etapa.nombre === 'Confirmada')!;
    expect(confirmada.total).toBe(1);

    const detalle = await http.get(`/v1/leads/${deLuis}`).set(auth()).expect(200);
    expect(detalle.body.estado).toBe('ganado');
    expect(detalle.body.cerradoEn).not.toBeNull();
    // Y queda dicho quién lo movió y desde dónde.
    expect(detalle.body.historial[0]).toMatchObject({ tipo: 'movido', hasta: 'Confirmada' });
  });

  it('devolver un lead cerrado a una etapa abierta lo reabre', async () => {
    const pedro = await contacto('Pedro Salas');
    const id = await crearLead(pedro, 'Doble fin de semana', 20_000, etapa('Confirmada'));
    expect((await http.get(`/v1/leads/${id}`).set(auth())).body.estado).toBe('ganado');

    await http
      .patch(`/v1/leads/${id}`)
      .set(auth())
      .send({ etapaId: etapa('Interesado') })
      .expect(200);
    const d = await http.get(`/v1/leads/${id}`).set(auth()).expect(200);
    expect(d.body.estado).toBe('abierto');
    expect(d.body.cerradoEn).toBeNull();
  });

  it('un huésped no acumula dos reservas abiertas a la vez', async () => {
    const rosa = await contacto('Rosa Díaz');
    await crearLead(rosa, 'Consulta de enero');
    const r = await http
      .post('/v1/leads')
      .set(auth())
      .send({ contactoId: rosa, titulo: 'Otra consulta' })
      .expect(409);
    expect(r.body.codigo).toBe('lead_abierto_existente');
  });

  it('borrar una etapa con leads exige decir a dónde van, y los lleva', async () => {
    const nueva = await http
      .post(`/v1/embudos/${embudoId}/etapas`)
      .set(auth())
      .send({ nombre: 'Esperando depósito', color: '#64D2FF' })
      .expect(201);
    const nuevaId = (nueva.body as { id: string }).id;

    const juan = await contacto('Juan Flores');
    const suLead = await crearLead(juan, 'Bungalow con depósito', 30_000, nuevaId);

    // Sin destino no se borra: ahí dentro hay trabajo del cliente.
    const sinDestino = await http.delete(`/v1/etapas/${nuevaId}`).set(auth()).expect(409);
    expect(sinDestino.body.codigo).toBe('etapa_con_leads');
    expect(sinDestino.body.leads).toBe(1);

    await http
      .delete(`/v1/etapas/${nuevaId}?destino=${etapa('Interesado')}`)
      .set(auth())
      .expect(200);

    const d = await http.get(`/v1/leads/${suLead}`).set(auth()).expect(200);
    expect(d.body.etapaId).toBe(etapa('Interesado'));
    expect(d.body.importe).toBe(30_000);
  });

  it('cambiar el tipo de una etapa cierra o reabre lo que hay dentro', async () => {
    const marta = await contacto('Marta Vega');
    const id = await crearLead(marta, 'Familiar 3 noches', 60_000, etapa('Reserva pendiente'));
    expect((await tablero()).pronostico).toBeGreaterThanOrEqual(60_000);

    await http
      .patch(`/v1/etapas/${etapa('Reserva pendiente')}`)
      .set(auth())
      .send({ tipo: 'ganada' })
      .expect(200);

    const d = await http.get(`/v1/leads/${id}`).set(auth()).expect(200);
    expect(d.body.estado).toBe('ganado');

    // Se deja como estaba para no contaminar el resto de casos.
    await http
      .patch(`/v1/etapas/${etapa('Reserva pendiente')}`)
      .set(auth())
      .send({ tipo: 'abierta' })
      .expect(200);
    expect((await http.get(`/v1/leads/${id}`).set(auth())).body.estado).toBe('abierto');
  });

  it('el orden de las etapas se manda entero, o no se manda', async () => {
    const ids = etapas.map((e) => e.id);
    const r = await http
      .patch(`/v1/embudos/${embudoId}/etapas/orden`)
      .set(auth())
      .send({ ids: ids.slice(0, 2) })
      .expect(422);
    expect(r.body.codigo).toBe('orden_incompleto');
  });

  it('la búsqueda mira el título y el nombre del huésped', async () => {
    const busca = async (q: string) => {
      const r = await http.get(`/v1/leads/tablero?q=${encodeURIComponent(q)}`).set(auth());
      return (r.body as { columnas: { total: number }[] }).columnas.reduce(
        (s, c) => s + c.total,
        0,
      );
    };
    expect(await busca('Quispe')).toBe(1);
    expect(await busca('bungalow')).toBeGreaterThanOrEqual(1);
    expect(await busca('no existe nadie así')).toBe(0);
  });

  it('el embudo del hotel de al lado no existe para este', async () => {
    const r = await http.get('/v1/embudos').set(auth(tokenAjeno)).expect(200);
    const ajenos = r.body as { id: string }[];
    expect(ajenos).toHaveLength(1);
    expect(ajenos[0]!.id).not.toBe(embudoId);

    const t = await http.get('/v1/leads/tablero').set(auth(tokenAjeno)).expect(200);
    expect(t.body.columnas.every((c: { total: number }) => c.total === 0)).toBe(true);
  });

  it('sin sesión no hay tablero', async () => {
    await http.get('/v1/leads/tablero').expect(401);
  });
});
