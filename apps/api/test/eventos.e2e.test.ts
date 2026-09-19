/**
 * Eventos en vivo (SSE) por HTTP real.
 *
 * Se prueba el camino entero: escribir en el outbox dispara `pg_notify`, la
 * API lo reparte y la pantalla lo recibe. Y lo que más importa de todo: que
 * una cuenta NO recibe los eventos de otra.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrar, withTenant, reintentandoSiChocaElCatalogo } from '@crmapp/db';
import { escribirEnOutbox } from '@crmapp/queue';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_eventos';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let app2: Pool;
let baseUrl: string;
let tokenA: string;
let tenantA: string;
let tenantB: string;

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
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app`);
  await conf.end();
  app2 = new Pool({ connectionString: url(DB, 'crmapp_app', 'crmapp_dev') });

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
  await app.listen(0);
  baseUrl = await app.getUrl();

  const http = request(app.getHttpServer());
  const alta = async (slug: string) =>
    (
      await http
        .post('/v1/cuentas')
        .send({
          nombreDeCuenta: slug,
          slug,
          email: `${slug}@eventos.test`,
          contrasena: 'contrasena-muy-larga',
          nombreCompleto: 'Jefe',
        })
        .expect(201)
    ).body as { token: string; tenantId: string };
  const a = await alta('paraiso-eventos');
  tokenA = a.token;
  tenantA = a.tenantId;
  tenantB = (await alta('otra-eventos')).tenantId;
});

afterAll(async () => {
  await app?.close();
  await app2?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

/** Abre el flujo y devuelve las líneas que van llegando. */
async function abrirFlujo(token: string) {
  const control = new AbortController();
  const r = await fetch(`${baseUrl.replace('[::1]', '127.0.0.1')}/v1/eventos`, {
    headers: { authorization: `Bearer ${token}` },
    signal: control.signal,
  });
  const lector = r.body!.getReader();
  const texto = new TextDecoder();
  let recibido = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        recibido += texto.decode(value, { stream: true });
      }
    } catch {
      /* se cerró */
    }
  })();
  return {
    estado: r.status,
    tipoDeContenido: r.headers.get('content-type'),
    /** Espera hasta que el flujo contenga ese texto, o se rinde. */
    async esperar(fragmento: string, ms = 3000): Promise<boolean> {
      const hasta = Date.now() + ms;
      while (Date.now() < hasta) {
        if (recibido.includes(fragmento)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    get todo() {
      return recibido;
    },
    cerrar: () => control.abort(),
  };
}

/** Escribe un evento en el outbox del inquilino, como hace el worker. */
async function evento(tenantId: string, eventType: string, conversationId: string) {
  await withTenant(app2, tenantId, async (c) => {
    await escribirEnOutbox(c, {
      tenantId,
      aggregateType: 'message',
      aggregateId: '01a00000-0000-7000-8000-000000000001',
      eventType,
      payload: { conversationId },
    });
  });
}

describe('eventos en vivo', () => {
  it('sin sesión no se abre el flujo', async () => {
    const r = await fetch(`${baseUrl.replace('[::1]', '127.0.0.1')}/v1/eventos`);
    expect(r.status).toBe(401);
  });

  it('un mensaje nuevo llega a la pantalla sin recargar', async () => {
    const flujo = await abrirFlujo(tokenA);
    expect(flujo.estado).toBe(200);
    expect(flujo.tipoDeContenido).toContain('text/event-stream');
    expect(await flujo.esperar(': conectado')).toBe(true);

    await evento(tenantA, 'mensaje.recibido', '01a00000-0000-7000-8000-0000000000c1');
    expect(await flujo.esperar('event: mensaje.recibido')).toBe(true);
    expect(flujo.todo).toContain('01a00000-0000-7000-8000-0000000000c1');
    flujo.cerrar();
  });

  it('los eventos de otra cuenta NO se reciben', async () => {
    const flujo = await abrirFlujo(tokenA);
    expect(await flujo.esperar(': conectado')).toBe(true);

    await evento(tenantB, 'mensaje.recibido', '01a00000-0000-7000-8000-0000000000b2');
    // Y uno propio después: si llega el propio y no el ajeno, el filtro funciona.
    await evento(tenantA, 'mensaje.enviado', '01a00000-0000-7000-8000-0000000000a2');
    expect(await flujo.esperar('event: mensaje.enviado')).toBe(true);
    expect(flujo.todo).not.toContain('0000000000b2');
    flujo.cerrar();
  });

  it('al cerrarse la pantalla se suelta la escucha', async () => {
    const flujo = await abrirFlujo(tokenA);
    expect(await flujo.esperar(': conectado')).toBe(true);
    flujo.cerrar();
    // La baja ocurre cuando Node ve cerrado el socket: se espera un poco.
    await new Promise((r) => setTimeout(r, 300));
    const servicio = app.get<{ suscritos: number }>(
      (await import('../src/tokens.js')).TOKEN_EVENTOS,
    );
    expect(servicio.suscritos).toBe(0);
  });
});
