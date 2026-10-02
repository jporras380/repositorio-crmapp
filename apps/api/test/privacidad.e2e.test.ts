/**
 * Cuánto tiempo guarda el hotel sus mensajes (0052), por HTTP real.
 *
 * Lo que se prueba: viene apagado, lo cambia SOLO el propietario, y antes de
 * elegir se ve cuántos mensajes caerían con cada plazo. Qué se borra de
 * verdad lo prueba `packages/db/test/retencion.test.ts`, contra la función.
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
const DB = 'crmapp_test_privacidad';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tokenOwner: string;
let tokenAdmin: string;
let tenantId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
      slug: 'paraiso-privacidad',
      email: 'owner@privacidad.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Owner',
    })
    .expect(201);
  tokenOwner = alta.body.token;
  tenantId = alta.body.tenantId;
  const inv = await http
    .post('/v1/invitaciones')
    .set(auth(tokenOwner))
    .send({ email: 'admin@privacidad.test', rol: 'admin' })
    .expect(201);
  tokenAdmin = (
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

describe('privacidad: cuánto se guardan los mensajes', () => {
  it('viene apagado: se guarda todo, como siempre', async () => {
    const r = await http.get('/v1/cuenta/privacidad').set(auth(tokenAdmin)).expect(200);
    expect(r.body.retencionMeses).toBeNull();
    expect(r.body.puedeCambiar).toBe(false);
  });

  it('antes de elegir se ve cuántos mensajes caerían con cada plazo', async () => {
    // Un canal, un contacto y una conversación mínimos para colgar mensajes viejos.
    const ca = (
      await admin.query<{ id: string }>(
        `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
         VALUES ($1, 'whatsapp', 'pn-priv', 'WA') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    const co = (
      await admin.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'Rosa') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    const ci = (
      await admin.query<{ id: string }>(
        `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id,
                                         external_user_id)
         VALUES ($1, $2, 'whatsapp', $3, 'wa-rosa') RETURNING id`,
        [tenantId, co, ca],
      )
    ).rows[0]!.id;
    const cv = (
      await admin.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, ci, co, ca],
      )
    ).rows[0]!.id;
    for (const meses of [30, 30, 15]) {
      await admin.query(
        `SELECT app.ensure_partition('public.messages',
                                     date_trunc('month', now() - make_interval(months => $1))::date)`,
        [meses],
      );
      await admin.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type,
                               body, created_at)
         VALUES ($1, $2, $3, 'inbound', 'text', 'hola', now() - make_interval(months => $4))`,
        [tenantId, cv, ca, meses],
      );
    }

    const r = await http.get('/v1/cuenta/privacidad').set(auth(tokenOwner)).expect(200);
    expect(r.body.caerianConCadaPlazo).toEqual({ '12': 3, '24': 2, '36': 0, '60': 0 });
    expect(r.body.puedeCambiar).toBe(true);
  });

  it('un administrador NO lo cambia: borrar historial es decisión del propietario', async () => {
    const r = await http
      .put('/v1/cuenta/privacidad')
      .set(auth(tokenAdmin))
      .send({ retencionMeses: 24 })
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso');
  });

  it('un plazo que no está en la lista se rechaza, también uno de menos de un año', async () => {
    await http
      .put('/v1/cuenta/privacidad')
      .set(auth(tokenOwner))
      .send({ retencionMeses: 6 })
      .expect(400);
  });

  it('el propietario lo pone, queda registrado, y puede volver a «siempre»', async () => {
    const r = await http
      .put('/v1/cuenta/privacidad')
      .set(auth(tokenOwner))
      .send({ retencionMeses: 24 })
      .expect(200);
    expect(r.body.retencionMeses).toBe(24);
    const { rows } = await admin.query<{ meta: { retencionMeses: number } }>(
      `SELECT meta FROM audit_log WHERE tenant_id = $1 AND action = 'cuenta.retencion'`,
      [tenantId],
    );
    expect(rows[0]!.meta.retencionMeses).toBe(24);

    const vuelta = await http
      .put('/v1/cuenta/privacidad')
      .set(auth(tokenOwner))
      .send({ retencionMeses: null })
      .expect(200);
    expect(vuelta.body.retencionMeses).toBeNull();
  });
});
