/**
 * Salesbots por HTTP: definir, versionar, publicar y probar.
 *
 * Lo que de verdad se prueba aquí son las dos reglas que protegen al cliente:
 * publicar VALIDA —un bucle sin espera no llega a hablar con nadie— y guardar
 * VERSIONA, así que lo que ya está corriendo no cambia bajo los pies.
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
const DB = 'crmapp_test_flujos_api';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;

const BUENO = {
  inicio: 'saludo',
  nodos: [
    { id: 'saludo', tipo: 'mensaje', texto: '¿Buscas repuestos?', siguiente: 'espera' },
    { id: 'espera', tipo: 'esperar_respuesta', segundos: 3600, siguiente: 'fin', alExpirar: 'fin' },
    { id: 'fin', tipo: 'fin' },
  ],
};

/** Dos mensajes que se llaman entre sí: enviaría hasta que alguien lo apague. */
const BUCLE = {
  inicio: 'a',
  nodos: [
    { id: 'a', tipo: 'mensaje', texto: 'hola', siguiente: 'b' },
    { id: 'b', tipo: 'mensaje', texto: 'otra vez', siguiente: 'a' },
  ],
};

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
  return r.body as { token: string };
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
  token = (await alta('bots')).token;
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

async function crear(
  nombre: string,
  grafo: unknown = BUENO,
  disparadores: unknown[] = [{ tipo: 'conversacion_abierta' }],
) {
  const r = await http
    .post('/v1/flujos')
    .set(auth())
    .send({ nombre, grafo, disparadores })
    .expect(201);
  return r.body as { id: string; version: number };
}

describe('flujos', () => {
  it('crear deja el flujo en borrador con su primera versión', async () => {
    const { id, version } = await crear('Calificar leads');
    expect(version).toBe(1);
    const r = await http.get(`/v1/flujos/${id}`).set(auth()).expect(200);
    expect(r.body).toMatchObject({ nombre: 'Calificar leads', estado: 'borrador', version: null });
    expect(r.body.problemas).toEqual([]);
    // `version` es la PUBLICADA; en borrador todavía no hay ninguna.
  });

  it('publicar valida: un bucle sin espera no llega a hablar con nadie', async () => {
    const { id } = await crear('Bucle', BUCLE);
    const r = await http.post(`/v1/flujos/${id}/publicar`).set(auth()).expect(422);
    expect(r.body.codigo).toBe('flujo_invalido');
    expect(r.body.problemas.map((p: { codigo: string }) => p.codigo)).toContain('bucle_sin_espera');
    // Sigue en borrador: publicar es todo o nada.
    const d = await http.get(`/v1/flujos/${id}`).set(auth()).expect(200);
    expect(d.body.estado).toBe('borrador');
  });

  it('un flujo sin disparador no se publica: no se ejecutaría nunca', async () => {
    const { id } = await crear('Sin disparador', BUENO, []);
    const r = await http.post(`/v1/flujos/${id}/publicar`).set(auth()).expect(422);
    expect(r.body.codigo).toBe('flujo_sin_disparador');
  });

  it('publicar activa la última versión; guardar después NO cambia la publicada', async () => {
    const { id } = await crear('Bienvenida');
    await http.post(`/v1/flujos/${id}/publicar`).set(auth()).expect(201);
    expect((await http.get(`/v1/flujos/${id}`).set(auth())).body).toMatchObject({
      estado: 'activo',
      version: 1,
    });

    const nuevo = {
      ...BUENO,
      nodos: BUENO.nodos.map((n) => (n.id === 'saludo' ? { ...n, texto: 'Texto nuevo' } : n)),
    };
    const g = await http.patch(`/v1/flujos/${id}`).set(auth()).send({ grafo: nuevo }).expect(200);
    expect(g.body.version).toBe(2);

    // Lo publicado sigue siendo la 1: las ejecuciones en vuelo no cambian de
    // grafo por guardar un borrador.
    const { rows } = await admin.query<{ version: number }>(
      `SELECT v.version FROM flows f JOIN flow_versions v ON v.id = f.current_version_id WHERE f.id = $1`,
      [id],
    );
    expect(rows[0]!.version).toBe(1);

    await http.post(`/v1/flujos/${id}/publicar`).set(auth()).expect(201);
    const { rows: despues } = await admin.query<{ version: number }>(
      `SELECT v.version FROM flows f JOIN flow_versions v ON v.id = f.current_version_id WHERE f.id = $1`,
      [id],
    );
    expect(despues[0]!.version).toBe(2);
  });

  it('pausar deja de disparar sin cancelar lo que ya corre', async () => {
    const { id } = await crear('Pausable');
    await http.post(`/v1/flujos/${id}/publicar`).set(auth()).expect(201);
    await http.post(`/v1/flujos/${id}/pausar`).set(auth()).expect(201);
    expect((await http.get(`/v1/flujos/${id}`).set(auth())).body.estado).toBe('pausado');
    // La versión publicada se conserva: reanudar no obliga a republicar.
    expect((await http.get(`/v1/flujos/${id}`).set(auth())).body.version).toBe(1);
  });

  it('el modo prueba dice qué haría el flujo sin enviar nada', async () => {
    const grafo = {
      inicio: 'saludo',
      nodos: [
        { id: 'saludo', tipo: 'mensaje', texto: '¿Te interesa?', siguiente: 'espera' },
        {
          id: 'espera',
          tipo: 'esperar_respuesta',
          segundos: 600,
          siguiente: 'ramas',
          alExpirar: 'fin',
        },
        {
          id: 'ramas',
          tipo: 'condicion',
          casos: [{ contiene: ['sí', 'si'], siguiente: 'cierre' }],
          siNo: 'fin',
        },
        { id: 'cierre', tipo: 'mensaje', texto: 'Genial, te llamo.', siguiente: 'fin' },
        { id: 'fin', tipo: 'fin' },
      ],
    };
    const r = await http
      .post('/v1/flujos/probar')
      .set(auth())
      .send({ grafo, respuestas: ['Sí, claro'] })
      .expect(201);
    expect(r.body.final).toBe('fin');
    expect(r.body.pasos.flatMap((p: { efectos: unknown[] }) => p.efectos)).toEqual([
      { tipo: 'enviar_texto', texto: '¿Te interesa?' },
      { tipo: 'enviar_texto', texto: 'Genial, te llamo.' },
    ]);
    // Probar no crea nada: no hay flujo, ni versión, ni ejecución.
    const { rows } = await admin.query(`SELECT 1 FROM flow_runs`);
    expect(rows).toHaveLength(0);
  });

  it('un grafo mal formado se rechaza antes de llegar al dominio', async () => {
    const r = await http
      .post('/v1/flujos')
      .set(auth())
      .send({ nombre: 'Roto', grafo: { inicio: 'a', nodos: [{ id: 'a', tipo: 'mensaje' }] } })
      .expect(400);
    expect(r.body.codigo).toBe('datos_invalidos');
  });

  it('dos flujos con el mismo nombre, no', async () => {
    await crear('Repetido');
    const r = await http
      .post('/v1/flujos')
      .set(auth())
      .send({ nombre: 'repetido', grafo: BUENO, disparadores: [] })
      .expect(409);
    expect(r.body.codigo).toBe('flujo_repetido');
  });

  it('el flujo de otro inquilino no existe', async () => {
    const { id } = await crear('Privado');
    await http.get(`/v1/flujos/${id}`).set(auth(tokenAjeno)).expect(404);
    await http.post(`/v1/flujos/${id}/publicar`).set(auth(tokenAjeno)).expect(404);
    expect((await http.get('/v1/flujos').set(auth(tokenAjeno))).body).toEqual([]);
  });

  it('sin sesión no hay flujos', async () => {
    await http.get('/v1/flujos').expect(401);
  });
});
