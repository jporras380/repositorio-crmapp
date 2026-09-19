/**
 * IA asistida con la clave del hotel (P-11), por HTTP real contra PostgreSQL.
 *
 * El proveedor es falso: se prueba lo que es nuestro. Que la IA empieza
 * apagada, que la clave se verifica antes de guardarse y nunca vuelve, que la
 * sugerencia NO envía nada, que lleva la conversación en orden y el catálogo
 * del hotel, y que lo enviado a partir de ella queda marcado como IA pero
 * enviado por una persona.
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
import { ErrorDeNegocio } from '../src/auth/auth.service.js';
import type { PeticionDeSugerencia } from '../src/ia/cliente-de-ia.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_ia';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

const CLAVE = 'sk-ant-api03-clave-de-prueba-suficientemente-larga';
let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tokenOwner: string;
let tokenAgente: string;
let tenantId: string;
let conversacionId: string;
const pedidas: PeticionDeSugerencia[] = [];

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
      clienteDeIa: {
        verificar: async ({ apiKey, modelo }) => {
          if (apiKey.includes('rechazada')) {
            throw new ErrorDeNegocio('ia_clave_rechazada', 'Anthropic rechazó la clave.', 422);
          }
          if (modelo === 'claude-haiku-4-5' && apiKey.includes('sin-haiku')) {
            throw new ErrorDeNegocio('ia_sin_permiso', 'Sin permiso para ese modelo.', 422);
          }
        },
        sugerir: async (p) => {
          pedidas.push(p);
          return 'Hola Rosa, sí tenemos el Bungalow Matrimonial. ¿Para qué fechas lo necesitas?';
        },
      },
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
      slug: 'paraiso-ia',
      email: 'owner@paraiso.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Owner',
    })
    .expect(201);
  tokenOwner = alta.body.token;
  tenantId = alta.body.tenantId;
  const inv = await http
    .post('/v1/invitaciones')
    .set(auth(tokenOwner))
    .send({ email: 'agente@paraiso.test', rol: 'agent' })
    .expect(201);
  tokenAgente = (
    await http
      .post('/v1/invitaciones/aceptar')
      .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: 'Agente' })
      .expect(200)
  ).body.token;

  // Catálogo, canal, contacto y una conversación con dos entrantes y una respuesta.
  await admin.query(
    `INSERT INTO room_types (tenant_id, name, capacity, base_rate_cents, currency)
     VALUES ($1, 'Bungalow Matrimonial', 2, 18000, 'PEN')`,
    [tenantId],
  );
  const ca = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name, status)
       VALUES ($1, 'whatsapp', 'pn-ia', 'WA', 'connected') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const co = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'Rosa Quispe') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const ci = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1, $2, 'whatsapp', $3, '51999888777') RETURNING id`,
      [tenantId, co, ca],
    )
  ).rows[0]!.id;
  const ahora = Date.now();
  conversacionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id,
         status, last_inbound_at, session_expires_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6) RETURNING id`,
      [tenantId, ci, co, ca, new Date(ahora - 60_000), new Date(ahora + 20 * 3_600_000)],
    )
  ).rows[0]!.id;
  const mensajes: [string, string, number][] = [
    ['inbound', 'Hola, buenas tardes', 300_000],
    ['outbound', 'Hola, ¿en qué te ayudamos?', 200_000],
    ['inbound', '¿Tienen bungalow para dos?', 60_000],
  ];
  for (const [direccion, texto, hace] of mensajes) {
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, created_at)
       VALUES ($1, $2, $3, $4, 'text', $5, 'delivered', $6)`,
      [tenantId, conversacionId, ca, direccion, texto, new Date(ahora - hace)],
    );
  }
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('ajustes de IA', () => {
  it('empieza apagada, sin clave, y un agente puede leerlo', async () => {
    const r = await http.get('/v1/ia/ajustes').set(auth(tokenAgente)).expect(200);
    expect(r.body).toMatchObject({ activa: false, tieneClave: false, modelo: 'claude-opus-5' });
  });

  it('un agente no puede configurarla', async () => {
    await http.put('/v1/ia/ajustes').set(auth(tokenAgente)).send({ activa: true }).expect(403);
  });

  it('activarla sin clave no se puede', async () => {
    const r = await http
      .put('/v1/ia/ajustes')
      .set(auth(tokenOwner))
      .send({ activa: true })
      .expect(422);
    expect(r.body.codigo).toBe('ia_sin_clave');
  });

  it('una clave con forma equivocada ni se manda al proveedor', async () => {
    await http
      .put('/v1/ia/ajustes')
      .set(auth(tokenOwner))
      .send({ clave: 'no-es-una-clave' })
      .expect(400);
  });

  it('una clave que Anthropic rechaza: 422 y no se guarda nada', async () => {
    await http
      .put('/v1/ia/ajustes')
      .set(auth(tokenOwner))
      .send({ clave: 'sk-ant-api03-rechazada-suficientemente-larga', activa: true })
      .expect(422);
    const { rows } = await admin.query(`SELECT 1 FROM tenant_secrets`);
    expect(rows).toHaveLength(0);
  });

  it('una clave válida se guarda cifrada, activa la IA y nunca vuelve en la respuesta', async () => {
    const r = await http
      .put('/v1/ia/ajustes')
      .set(auth(tokenOwner))
      .send({ clave: CLAVE, activa: true, instrucciones: 'Check-in desde las 14:00.' })
      .expect(200);
    expect(r.body).toMatchObject({ activa: true, tieneClave: true });
    expect(JSON.stringify(r.body)).not.toContain('sk-ant');
    const { rows } = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM tenant_secrets WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain('sk-ant');
  });

  it('cambiar a un modelo que esa clave no puede usar se comprueba antes de guardar', async () => {
    await http
      .put('/v1/ia/ajustes')
      .set(auth(tokenOwner))
      .send({ clave: 'sk-ant-api03-sin-haiku-suficientemente-larga', modelo: 'claude-haiku-4-5' })
      .expect(422);
    const r = await http.get('/v1/ia/ajustes').set(auth(tokenOwner)).expect(200);
    expect(r.body.modelo).toBe('claude-opus-5');
  });

  it('otra cuenta no ve ni la clave ni los ajustes de esta', async () => {
    const otra = await http
      .post('/v1/cuentas')
      .send({
        nombreDeCuenta: 'Otra',
        slug: 'otra-ia',
        email: 'x@otra-ia.test',
        contrasena: 'contrasena-muy-larga',
        nombreCompleto: 'Otro',
      })
      .expect(201);
    const r = await http.get('/v1/ia/ajustes').set(auth(otra.body.token)).expect(200);
    expect(r.body).toMatchObject({ activa: false, tieneClave: false });
  });
});

describe('sugerir respuesta', () => {
  it('devuelve un borrador y NO envía nada', async () => {
    const antes = await admin.query(`SELECT count(*)::int AS n FROM messages`);
    const r = await http
      .post(`/v1/conversaciones/${conversacionId}/sugerencia`)
      .set(auth(tokenAgente))
      .expect(200);
    expect(r.body.texto).toContain('Bungalow Matrimonial');
    expect(r.body.modelo).toBe('claude-opus-5');
    const despues = await admin.query(`SELECT count(*)::int AS n FROM messages`);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('la IA recibe la conversación en orden, el catálogo, las instrucciones y la clave del hotel', async () => {
    const p = pedidas.at(-1)!;
    expect(p.apiKey).toBe(CLAVE);
    expect(p.sistema).toContain('Bungalow Matrimonial: hasta 2 personas, tarifa base PEN 180');
    expect(p.sistema).toContain('Check-in desde las 14:00.');
    expect(p.sistema).toContain('No inventes precios');
    const orden = [
      'Cliente: Hola, buenas tardes',
      'Hotel: Hola, ¿en qué te ayudamos?',
      'Cliente: ¿Tienen bungalow para dos?',
    ].map((l) => p.mensaje.indexOf(l));
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(p.mensaje).toContain('Rosa Quispe');
  });

  it('cada sugerencia se mide', async () => {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1 AND metric = 'ai.suggestions'`,
      [tenantId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('lo enviado a partir del borrador queda como IA, pero lo envió una persona', async () => {
    const r = await http
      .post(`/v1/conversaciones/${conversacionId}/mensajes`)
      .set(auth(tokenAgente))
      .send({ tipo: 'text', texto: 'Hola Rosa, sí tenemos.', generadoPorIa: true })
      .expect(202);
    const { rows } = await admin.query<{ sent_by: string; ai_generated: boolean }>(
      `SELECT sent_by, ai_generated FROM messages WHERE id = $1`,
      [r.body.id],
    );
    expect(rows[0]).toEqual({ sent_by: 'human', ai_generated: true });
  });

  it('una conversación que no existe (o no se puede ver) da 404 sin llamar a la IA', async () => {
    const n = pedidas.length;
    await http
      .post('/v1/conversaciones/00000000-0000-7000-8000-000000000000/sugerencia')
      .set(auth(tokenAgente))
      .expect(404);
    expect(pedidas).toHaveLength(n);
  });

  it('borrar la clave apaga la IA y sugerir deja de funcionar', async () => {
    const r = await http.delete('/v1/ia/clave').set(auth(tokenOwner)).expect(200);
    expect(r.body).toMatchObject({ activa: false, tieneClave: false });
    const s = await http
      .post(`/v1/conversaciones/${conversacionId}/sugerencia`)
      .set(auth(tokenAgente))
      .expect(409);
    expect(s.body.codigo).toBe('ia_desactivada');
  });
});
