/**
 * Panel de control por HTTP real. Lo que se prueba es que las cifras
 * accionables digan la verdad: sin responder, ventanas a punto de cerrarse y
 * sin asignar son las que hacen que un agente abra una conversación u otra.
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
const DB = 'crmapp_test_panel';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tenantId: string;
let ca: string;
let ahora = new Date();

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

/** Conversación con control fino de lo que mide el panel. */
async function conversacion(o: {
  nombre: string;
  ventanaEnHoras?: number | null;
  /** Contestó una persona del equipo. */
  respondida?: boolean;
  /** Contestó solo el bot: hay saliente, pero ninguna persona escribió. */
  soloBot?: boolean;
  asignada?: boolean;
  estado?: string;
}) {
  const c = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
      [tenantId, o.nombre],
    )
  ).rows[0]!.id;
  const ci = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1,$2,'whatsapp',$3,$4) RETURNING id`,
      [tenantId, c, ca, `u-${o.nombre}`],
    )
  ).rows[0]!.id;
  const entrante = new Date(ahora.getTime() - 3_600_000);
  const usuario = (await admin.query<{ id: string }>(`SELECT id FROM users LIMIT 1`)).rows[0]!.id;
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations
         (tenant_id, contact_identity_id, contact_id, channel_account_id, status,
          last_inbound_at, last_outbound_at, session_expires_at, assignee_user_id,
          first_response_at, created_at, human_reply_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,$11) RETURNING id`,
      [
        tenantId,
        ci,
        c,
        ca,
        o.estado ?? 'open',
        entrante,
        o.respondida || o.soloBot ? new Date(entrante.getTime() + 120_000) : null,
        o.ventanaEnHoras === null || o.ventanaEnHoras === undefined
          ? null
          : new Date(ahora.getTime() + o.ventanaEnHoras * 3_600_000),
        o.asignada ? usuario : null,
        o.respondida ? new Date(entrante.getTime() + 120_000) : null,
        o.respondida ? new Date(entrante.getTime() + 120_000) : null,
      ],
    )
  ).rows[0]!.id;
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
      ahora: () => ahora,
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

  ca = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name, status)
       VALUES ($1,'whatsapp','pn-panel','WA','connected') RETURNING id`,
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

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

describe('GET /v1/panel', () => {
  it('cuenta vacía: todo a cero y sin mediana', async () => {
    const r = await http.get('/v1/panel').set(auth()).expect(200);
    expect(r.body.atencion).toEqual({ sinResponder: 0, ventanasPorCerrar: 0, sinAsignar: 0 });
    expect(r.body.respuesta.medianaSegundos).toBeNull();
    expect(r.body.actividadHoy).toEqual([]);
  });

  it('distingue sin responder, ventana a punto de cerrarse y sin asignar', async () => {
    // Escribió el contacto y nadie contestó; la ventana cierra en 1 h.
    await conversacion({ nombre: 'Urgente', ventanaEnHoras: 1 });
    // Respondida y asignada, con ventana holgada: no aparece en nada.
    await conversacion({
      nombre: 'Atendida',
      ventanaEnHoras: 20,
      respondida: true,
      asignada: true,
    });
    // Respondida pero con la ventana a punto de cerrarse: solo cuenta ahí.
    await conversacion({
      nombre: 'PorCerrar',
      ventanaEnHoras: 1.5,
      respondida: true,
      asignada: true,
    });
    // Cerrada: no cuenta en ninguna, ni siquiera su ventana.
    await conversacion({ nombre: 'Cerrada', ventanaEnHoras: 1, estado: 'closed' });

    const r = await http.get('/v1/panel').set(auth()).expect(200);
    expect(r.body.atencion).toEqual({
      sinResponder: 1,
      ventanasPorCerrar: 2,
      sinAsignar: 1,
    });
    expect(r.body.conversaciones).toMatchObject({ abiertas: 3, pendientes: 0 });
    // Dos conversaciones respondidas en dos minutos: la mediana es 120 s.
    expect(r.body.respuesta).toMatchObject({ medianaSegundos: 120, conversacionesMedidas: 2 });
  });

  it('lo contestado solo por el bot sigue sin responder: espera a una persona', async () => {
    const antes = (await http.get('/v1/panel').set(auth()).expect(200)).body.atencion.sinResponder;
    await conversacion({ nombre: 'SoloBot', ventanaEnHoras: 20, soloBot: true, asignada: true });
    const r = await http.get('/v1/panel').set(auth()).expect(200);
    expect(r.body.atencion.sinResponder).toBe(antes + 1);
  });

  it('la actividad de hoy va por canal y dirección', async () => {
    const conv = await conversacion({ nombre: 'Conteo', ventanaEnHoras: 10 });
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status)
       VALUES ($1,$2,$3,'inbound','text','a','delivered'),
              ($1,$2,$3,'inbound','text','b','delivered'),
              ($1,$2,$3,'outbound','text','c','sent')`,
      [tenantId, conv, ca],
    );
    const r = await http.get('/v1/panel').set(auth()).expect(200);
    expect(r.body.actividadHoy).toEqual([{ canal: 'whatsapp', entrantes: 2, salientes: 1 }]);
  });

  it('otro inquilino no ve nada de esto', async () => {
    const r = await http.get('/v1/panel').set(auth(tokenAjeno)).expect(200);
    expect(r.body.atencion).toEqual({ sinResponder: 0, ventanasPorCerrar: 0, sinAsignar: 0 });
    expect(r.body.actividadHoy).toEqual([]);
  });

  it('sin sesión → 401', async () => {
    await http.get('/v1/panel').expect(401);
  });

  describe('«hoy» es el día del hotel, no el del servidor', () => {
    /** 00:30 UTC del 17 = 19:30 del 16 en Lima. Mismo día para el hotel. */
    const nocheEnLima = new Date('2026-09-17T00:30:00Z');
    /** 20:00 UTC del 16 = 15:00 del 16 en Lima: la tarde del MISMO día. */
    const tardeEnLima = new Date('2026-09-16T20:00:00Z');
    const original = ahora;

    afterAll(async () => {
      ahora = original;
      await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
      await admin.query(`DELETE FROM messages WHERE created_at = $1`, [tardeEnLima]);
    });

    const conZona = async (tz: string) => {
      await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
      await admin.query(
        `INSERT INTO business_hours (tenant_id, timezone, schedule) VALUES ($1, $2, '{}'::jsonb)`,
        [tenantId, tz],
      );
    };

    const actividadDe = async (canal: string) => {
      const r = await http.get('/v1/panel').set(auth()).expect(200);
      const fila = (r.body.actividadHoy as { canal: string; entrantes: number }[]).find(
        (f) => f.canal === canal,
      );
      return fila?.entrantes ?? 0;
    };

    it('a las 19:30 de Lima sigue contando lo de esa misma tarde', async () => {
      // Con el día UTC, a esa hora el panel ya se había puesto a cero y decía
      // que no se había atendido a nadie, con el equipo trabajando.
      await conZona('America/Lima');
      ahora = nocheEnLima;
      const conv = await conversacion({ nombre: 'DeLaTarde' });
      await admin.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, created_at)
         VALUES ($1, $2, $3, 'inbound', 'text', 'de la tarde', 'delivered', $4)`,
        [tenantId, conv, ca, tardeEnLima],
      );
      expect(await actividadDe('whatsapp')).toBeGreaterThanOrEqual(1);
    });

    it('sin horario configurado se usa UTC: nunca se inventa una zona horaria', async () => {
      await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
      ahora = nocheEnLima;
      // Para UTC ya es el día 17, así que lo de las 20:00 del 16 no cuenta.
      expect(await actividadDe('whatsapp')).toBe(0);
    });
  });
});
