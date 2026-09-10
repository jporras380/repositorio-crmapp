/**
 * `GET /v1/cuenta/uso`: el consumo del mes frente a los límites del plan, por
 * inquilino. Solo lectura; qué se cobra es P-21.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { inicioDePeriodo, migrar } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_uso_api';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;

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
  const a = await alta('acme');
  token = a.token;
  tenantId = a.tenantId;
  tokenAjeno = (await alta('ajena')).token;
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

describe('GET /v1/cuenta/uso', () => {
  it('cuenta nueva: todo a cero, con los límites del plan de prueba', async () => {
    const r = await http.get('/v1/cuenta/uso').set(auth()).expect(200);
    expect(r.body.plan).toBe('starter');
    expect(r.body.uso).toEqual({
      'messages.inbound': 0,
      'messages.outbound': 0,
      'templates.sent': 0,
      'conversations.opened': 0,
      'media.stored_bytes': 0,
      'bot.runs': 0,
    });
    expect(r.body.limites.conversaciones_mes).toEqual({ limite: 1000, usado: 0 });
    expect(r.body.limites.bot_runs_mes).toEqual({ limite: 500, usado: 0 });
    // Límites sin métrica todavía (asientos, IA): límite visible, uso desconocido.
    expect(r.body.limites.agentes).toEqual({ limite: 3, usado: null });
    expect(r.body.periodo).toMatch(/^\d{4}-\d{2}$/);
  });

  it('refleja los agregados del mes y no los de otro inquilino', async () => {
    const periodo = inicioDePeriodo(new Date());
    await admin.query(
      `INSERT INTO usage_rollups (tenant_id, metric, period, quantity) VALUES
         ($1, 'conversations.opened', $2, 7), ($1, 'messages.outbound', $2, 3)`,
      [tenantId, periodo],
    );
    const r = await http.get('/v1/cuenta/uso').set(auth()).expect(200);
    expect(r.body.uso['conversations.opened']).toBe(7);
    expect(r.body.uso['messages.outbound']).toBe(3);
    expect(r.body.limites.conversaciones_mes).toEqual({ limite: 1000, usado: 7 });

    const ajeno = await http.get('/v1/cuenta/uso').set(auth(tokenAjeno)).expect(200);
    expect(ajeno.body.uso['conversations.opened']).toBe(0);
  });

  it('sin sesión → 401', async () => {
    await http.get('/v1/cuenta/uso').expect(401);
  });
});
