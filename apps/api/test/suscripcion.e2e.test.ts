/**
 * Suscripción y límites del plan (ADR-011).
 *
 * Lo que se prueba es el modelo de cobro decidido: se paga por asiento
 * OCUPADO, los pagos los registra el operador y no el inquilino, y pasarse de
 * un límite avisa sin cortar lo que le llega al cliente.
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
const DB = 'crmapp_test_suscripcion';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tenantId: string;

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

  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: 'Acme',
      slug: 'acme',
      email: 'jefe@acme.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Jefa',
    })
    .expect(201);
  token = r.body.token;
  tenantId = r.body.tenantId;
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

describe('GET /v1/cuenta/suscripcion', () => {
  it('cobra por asiento ocupado, contando los miembros', async () => {
    const r = await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200);
    expect(r.body.plan.codigo).toBe('starter');
    expect(r.body.asientos).toBe(1);
    // starter son 2500 al mes por asiento: un miembro, 2500.
    expect(r.body.importeMensualCentimos).toBe(2500);
    expect(r.body.estado).toBe('prueba');
    expect(r.body.pagos).toEqual([]);
  });

  it('el importe sube con cada miembro, sin columna que mantener', async () => {
    const usuario = (
      await admin.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash) VALUES ('otro@acme.test','Otro','x') RETURNING id`,
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'agent')`,
      [tenantId, usuario],
    );
    const r = await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200);
    expect(r.body.asientos).toBe(2);
    expect(r.body.importeMensualCentimos).toBe(5000);
  });

  it('muestra los pagos que registró el operador', async () => {
    await admin.query(
      `INSERT INTO subscription_payments
         (tenant_id, amount_cents, currency, covers_from, covers_to, method, reference)
       VALUES ($1, 5000, 'USD', now(), now() + interval '1 month', 'transferencia', 'OP-1')`,
      [tenantId],
    );
    const r = await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200);
    expect(r.body.pagos).toHaveLength(1);
    expect(r.body.pagos[0]).toMatchObject({ importeCentimos: 5000, referencia: 'OP-1' });
  });

  it('el inquilino NO puede registrarse un pago: la app no tiene ese permiso', async () => {
    // La regla no es «no hay endpoint», que sería una promesa: es que el rol
    // de la aplicación no puede escribir en la tabla (migración 0016).
    const app = new Pool({ connectionString: url(DB, 'crmapp_app', 'crmapp_dev') });
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      await expect(
        c.query(
          `INSERT INTO subscription_payments (tenant_id, amount_cents, covers_from, covers_to)
           VALUES ($1, 1, now(), now() + interval '1 year')`,
          [tenantId],
        ),
      ).rejects.toThrow(/permission denied|permiso denegado/i);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
      await app.end();
    }
  });

  it('avisa al pasar del 80 % de un límite, sin cortar nada', async () => {
    // starter incluye 1000 conversaciones al mes.
    await admin.query(
      `INSERT INTO usage_rollups (tenant_id, metric, period, quantity) VALUES ($1, 'conversations.opened', $2, 850)`,
      [tenantId, inicioDePeriodo(new Date())],
    );
    const r = await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200);
    expect(r.body.avisos).toContainEqual({
      limite: 'conversaciones_mes',
      nivel: 'cerca',
      usado: 850,
      tope: 1000,
    });
  });
});

describe('límite de asientos al invitar', () => {
  it('deja invitar mientras quepan y explica cuándo no', async () => {
    // starter incluye 3 agentes y ya hay 2 miembros: entra una invitación más.
    await http
      .post('/v1/invitaciones')
      .set(auth())
      .send({ email: 'tercero@acme.test', rol: 'agent' })
      .expect(201);

    const r = await http
      .post('/v1/invitaciones')
      .set(auth())
      .send({ email: 'cuarto@acme.test', rol: 'agent' })
      .expect(402);
    expect(r.body.codigo).toBe('limite_de_asientos');
    expect(r.body.tope).toBe(3);
  });

  it('la invitación PENDIENTE ocupa asiento: si no, tres a la vez pasan el tope', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM invitations WHERE tenant_id = $1 AND accepted_at IS NULL`,
      [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
