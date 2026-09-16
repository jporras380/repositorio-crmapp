/**
 * Horario de atención por HTTP real.
 *
 * Lo que se prueba es lo que evita un fallo silencioso: que un horario
 * imposible se rechace al guardarlo —y no un domingo a las tres— y que el
 * aviso no se pueda encender sin texto, porque entonces no avisaría de nada.
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
const DB = 'crmapp_test_horario';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tokenOwner: string;
let tokenAgente: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HORARIO = {
  '1': [
    ['09:00', '13:00'],
    ['15:00', '20:00'],
  ],
  '6': [['09:00', '13:00']],
};

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

  const alta = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: 'El Paraíso',
      slug: 'paraiso-horario',
      email: 'owner@horario.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Owner',
    })
    .expect(201);
  tokenOwner = alta.body.token;
  const inv = await http
    .post('/v1/invitaciones')
    .set(auth(tokenOwner))
    .send({ email: 'agente@horario.test', rol: 'agent' })
    .expect(201);
  tokenAgente = (
    await http
      .post('/v1/invitaciones/aceptar')
      .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: 'Ag' })
      .expect(200)
  ).body.token;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('horario de atención', () => {
  it('sin configurar: zona de Perú, sin horario y sin aviso', async () => {
    const r = await http.get('/v1/cuenta/horario').set(auth(tokenAgente)).expect(200);
    expect(r.body).toEqual({
      zonaHoraria: 'America/Lima',
      horario: {},
      avisoActivo: false,
      avisoTexto: '',
      configurado: false,
    });
  });

  it('un agente no puede cambiarlo', async () => {
    await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenAgente))
      .send({ horario: HORARIO })
      .expect(403);
  });

  it('el propietario guarda horario, zona y aviso', async () => {
    const r = await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({
        horario: HORARIO,
        zonaHoraria: 'America/Lima',
        avisoActivo: true,
        avisoTexto: 'Gracias por escribir. Atendemos de 9 a 20 y te respondemos mañana.',
      })
      .expect(200);
    expect(r.body).toMatchObject({ configurado: true, avisoActivo: true });
    expect(r.body.horario['1']).toEqual([
      ['09:00', '13:00'],
      ['15:00', '20:00'],
    ]);
  });

  it('guardar dos veces no crea dos horarios', async () => {
    await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({ horario: { '1': [['10:00', '19:00']] } })
      .expect(200);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM business_hours`);
    expect(rows[0].n).toBe(1);
  });

  it('un tramo que cierra antes de abrir se rechaza y se explica', async () => {
    const r = await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({ horario: { '3': [['22:00', '02:00']] } })
      .expect(422);
    expect(r.body.codigo).toBe('horario_invalido');
    expect(r.body.mensaje).toContain('miércoles');
  });

  it('dos tramos que se pisan se rechazan', async () => {
    const r = await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({
        horario: {
          '2': [
            ['09:00', '14:00'],
            ['13:00', '18:00'],
          ],
        },
      })
      .expect(422);
    expect(r.body.mensaje).toContain('martes');
  });

  it('una zona horaria inventada se rechaza', async () => {
    const r = await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({ zonaHoraria: 'Marte/Olympus' })
      .expect(422);
    expect(r.body.codigo).toBe('zona_horaria_invalida');
  });

  it('el aviso no se enciende sin texto', async () => {
    const r = await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({ avisoActivo: true, avisoTexto: '   ' })
      .expect(422);
    expect(r.body.codigo).toBe('aviso_sin_texto');
  });

  it('una hora imposible ni llega al servicio', async () => {
    await http
      .put('/v1/cuenta/horario')
      .set(auth(tokenOwner))
      .send({ horario: { '1': [['09:00', '25:00']] } })
      .expect(400);
  });
});
