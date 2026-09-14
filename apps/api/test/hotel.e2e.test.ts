/**
 * El catálogo del hotel y el cotizador, por HTTP.
 *
 * Lo que se prueba de verdad: que el cotizador de la API da lo mismo que las
 * reglas de `core` con datos reales de la base —fechas guardadas como `date`,
 * tarifas en orden de creación—, que un agente puede consultar precios pero no
 * cambiarlos, y que un tipo con habitaciones no se borra por accidente.
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
const DB = 'crmapp_test_hotel';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAgente: string;
let tokenAjeno: string;

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function alta(slug: string) {
  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: slug,
      slug,
      email: `${slug}@test.test`,
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Administración',
    })
    .expect(201);
  return r.body as { token: string };
}

async function crearTipo(nombre: string, capacidad = 4, precioBase: number | null = 20_000) {
  const r = await http
    .post('/v1/hotel/tipos')
    .set(auth())
    .send({ nombre, capacidad, precioBase })
    .expect(201);
  return (r.body as { id: string }).id;
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
      modoSandbox: true,
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

  const invitacion = await http
    .post('/v1/invitaciones')
    .set(auth())
    .send({ email: 'recepcion@test.test', rol: 'agent' })
    .expect(201);
  const aceptada = await http
    .post('/v1/invitaciones/aceptar')
    .send({
      token: (invitacion.body as { token: string }).token,
      contrasena: 'otra-contrasena-larga',
      nombreCompleto: 'Recepción',
    })
    .expect(200);
  tokenAgente = (aceptada.body as { token: string }).token;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('catálogo del hotel', () => {
  it('una cuenta nueva no trae precios inventados: el catálogo empieza vacío', async () => {
    const r = await http.get('/v1/hotel').set(auth()).expect(200);
    expect(r.body).toEqual({ tipos: [], servicios: [] });
  });

  it('se monta un tipo con sus habitaciones y sus tarifas', async () => {
    const id = await crearTipo('Bungalow Matrimonial', 2, 25_000);
    await http
      .post('/v1/hotel/habitaciones')
      .set(auth())
      .send({ tipoId: id, nombre: 'Bungalow 1' })
      .expect(201);
    await http
      .post('/v1/hotel/tarifas')
      .set(auth())
      .send({
        tipoId: id,
        nombre: 'Fiestas Patrias',
        desde: '2026-07-27',
        hasta: '2026-07-30',
        precio: 45_000,
        minNoches: 2,
      })
      .expect(201);

    const r = await http.get('/v1/hotel').set(auth()).expect(200);
    const bungalow = r.body.tipos.find(
      (t: { nombre: string }) => t.nombre === 'Bungalow Matrimonial',
    );
    expect(bungalow).toMatchObject({ capacidad: 2, precioBase: 25_000, moneda: 'PEN' });
    expect(bungalow.habitaciones).toHaveLength(1);
    // Las fechas vuelven como se guardaron, sin hora ni zona que las mueva un día.
    expect(bungalow.tarifas[0]).toMatchObject({ desde: '2026-07-27', hasta: '2026-07-30' });
  });

  it('dos tipos con el mismo nombre no', async () => {
    await crearTipo('Familiar');
    const r = await http
      .post('/v1/hotel/tipos')
      .set(auth())
      .send({ nombre: 'familiar', capacidad: 5 })
      .expect(409);
    expect(r.body.codigo).toBe('tipo_repetido');
  });

  it('una tarifa que termina antes de empezar se rechaza', async () => {
    const id = await crearTipo('Doble');
    const r = await http
      .post('/v1/hotel/tarifas')
      .set(auth())
      .send({ tipoId: id, nombre: 'Al revés', desde: '2026-08-10', hasta: '2026-08-01', precio: 1 })
      .expect(422);
    expect(r.body.codigo).toBe('rango_invalido');
  });

  it('un tipo con habitaciones no se borra; se archiva', async () => {
    const id = await crearTipo('Familiar VIP', 6, 40_000);
    await http
      .post('/v1/hotel/habitaciones')
      .set(auth())
      .send({ tipoId: id, nombre: 'VIP 1' })
      .expect(201);

    const r = await http.delete(`/v1/hotel/tipos/${id}`).set(auth()).expect(409);
    expect(r.body).toMatchObject({ codigo: 'tipo_con_habitaciones', habitaciones: 1 });

    await http.patch(`/v1/hotel/tipos/${id}`).set(auth()).send({ activo: false }).expect(204);
    const c = await http.get('/v1/hotel').set(auth()).expect(200);
    expect(c.body.tipos.find((t: { id: string }) => t.id === id).activo).toBe(false);
  });
});

describe('cotizador', () => {
  it('cotiza noche a noche con las tarifas guardadas en la base', async () => {
    const id = await crearTipo('Cotizable', 4, 20_000);
    await http
      .post('/v1/hotel/tarifas')
      .set(auth())
      .send({
        tipoId: id,
        nombre: 'Temporada alta',
        desde: '2026-07-01',
        hasta: '2026-08-31',
        precio: 30_000,
      })
      .expect(201);
    await http
      .post('/v1/hotel/tarifas')
      .set(auth())
      .send({
        tipoId: id,
        nombre: 'Fiestas Patrias',
        desde: '2026-07-27',
        hasta: '2026-07-29',
        precio: 45_000,
      })
      .expect(201);
    const { body: desayuno } = await http
      .post('/v1/hotel/servicios')
      .set(auth())
      .send({ nombre: 'Desayuno', precio: 1_500, unidad: 'por_persona_noche' })
      .expect(201);

    const r = await http
      .post('/v1/hotel/cotizar')
      .set(auth())
      .send({
        tipoId: id,
        entrada: '2026-06-30',
        salida: '2026-07-02',
        personas: 3,
        servicios: [desayuno.id],
      })
      .expect(200);
    // 30 jun: base 200 · 1 jul: temporada alta 300. Desayuno: 3 × 2 × 15.
    expect(r.body.detalle.map((n: { precio: number }) => n.precio)).toEqual([20_000, 30_000]);
    expect(r.body.servicios[0]).toMatchObject({ cantidad: 6, total: 9_000 });
    expect(r.body.total).toBe(59_000);
    expect(r.body.completa).toBe(true);

    // Y la específica gana a la general dentro de su rango.
    const fp = await http
      .post('/v1/hotel/cotizar')
      .set(auth())
      .send({ tipoId: id, entrada: '2026-07-28', salida: '2026-07-29', personas: 2 })
      .expect(200);
    expect(fp.body.detalle[0]).toMatchObject({ tarifa: 'Fiestas Patrias', precio: 45_000 });
  });

  it('un tipo sin precio base no cotiza a cero: lo dice', async () => {
    const id = await crearTipo('Sin precio', 2, null);
    const r = await http
      .post('/v1/hotel/cotizar')
      .set(auth())
      .send({ tipoId: id, entrada: '2026-09-01', salida: '2026-09-03', personas: 2 })
      .expect(200);
    expect(r.body.completa).toBe(false);
    expect(r.body.problemas.map((p: { codigo: string }) => p.codigo)).toContain('noche_sin_precio');
  });
});

describe('permisos y aislamiento', () => {
  it('un agente consulta y cotiza, pero no cambia precios', async () => {
    await http.get('/v1/hotel').set(auth(tokenAgente)).expect(200);
    const r = await http
      .post('/v1/hotel/tipos')
      .set(auth(tokenAgente))
      .send({ nombre: 'Del agente', capacidad: 2 })
      .expect(403);
    expect(r.body.codigo).toBe('permiso_insuficiente');
  });

  it('el catálogo del hotel de al lado no existe', async () => {
    const r = await http.get('/v1/hotel').set(auth(tokenAjeno)).expect(200);
    expect(r.body.tipos).toEqual([]);
  });

  it('sin sesión no hay precios', async () => {
    await http.get('/v1/hotel').expect(401);
  });
});
