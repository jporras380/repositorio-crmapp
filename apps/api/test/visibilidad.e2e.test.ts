/**
 * Visibilidad entre agentes (ADR-008), por HTTP real.
 *
 * Lo que hay que demostrar es que la lista y el acceso por id obedecen la
 * MISMA regla: un filtro en la lista que se pueda saltar escribiendo el id a
 * mano es decorativo.
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
const DB = 'crmapp_test_visibilidad';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let tokenOwner: string;
let tokenAgente: string;
let tenantId: string;
let agenteId: string;
let otroAgenteId: string;
let equipoId: string;
let channelAccountId: string;

// Conversaciones del escenario.
let mia: string; // asignada al agente
let sinAsignar: string;
let deMiEquipo: string; // asignada a otro, pero del equipo del agente
let ajena: string; // asignada a otro, de otro equipo

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function conversacion(nombre: string, asignadaA: string | null, teamId: string | null) {
  const c = (
    await admin.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
      [tenantId, nombre],
    )
  ).rows[0]!.id;
  const ci = (
    await admin.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1,$2,'whatsapp',$3,$4) RETURNING id`,
      [tenantId, c, channelAccountId, `u-${nombre}`],
    )
  ).rows[0]!.id;
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, assignee_user_id, team_id, last_inbound_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
      [tenantId, ci, c, channelAccountId, asignadaA, teamId],
    )
  ).rows[0]!.id;
}

async function invitarAgente(email: string): Promise<{ token: string; userId: string }> {
  const inv = await http
    .post('/v1/invitaciones')
    .set(auth(tokenOwner))
    .send({ email, rol: 'agent' })
    .expect(201);
  const r = await http
    .post('/v1/invitaciones/aceptar')
    .send({ token: inv.body.token, contrasena: 'contrasena-de-agente', nombreCompleto: email })
    .expect(200);
  return { token: r.body.token, userId: r.body.userId };
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
      nombreDeCuenta: 'Vis',
      slug: 'vis',
      email: 'owner@vis.test',
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Owner',
    })
    .expect(201);
  tokenOwner = alta.body.token;
  tenantId = alta.body.tenantId;

  const a = await invitarAgente('agente@vis.test');
  tokenAgente = a.token;
  agenteId = a.userId;
  otroAgenteId = (await invitarAgente('otro@vis.test')).userId;

  channelAccountId = (
    await admin.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name) VALUES ($1,'whatsapp','pn-vis','WA') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;

  // Equipo "Ventas" con el agente dentro.
  equipoId = (
    await admin.query<{ id: string }>(
      `INSERT INTO teams (tenant_id, name) VALUES ($1,'Ventas') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const membresia = (
    await admin.query<{ id: string }>(
      `SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, agenteId],
    )
  ).rows[0]!.id;
  await admin.query(
    `INSERT INTO team_members (tenant_id, team_id, membership_id) VALUES ($1,$2,$3)`,
    [tenantId, equipoId, membresia],
  );
  const otroEquipo = (
    await admin.query<{ id: string }>(
      `INSERT INTO teams (tenant_id, name) VALUES ($1,'Soporte') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;

  mia = await conversacion('Mia', agenteId, null);
  sinAsignar = await conversacion('Libre', null, null);
  deMiEquipo = await conversacion('Equipo', otroAgenteId, equipoId);
  ajena = await conversacion('Ajena', otroAgenteId, otroEquipo);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

const idsVisibles = async (token: string) =>
  (await http.get('/v1/conversaciones').set(auth(token)).expect(200)).body.items
    .map((i: { id: string }) => i.id)
    .sort();

const modo = (m: string) =>
  http
    .patch('/v1/cuenta/visibilidad-conversaciones')
    .set(auth(tokenOwner))
    .send({ modo: m })
    // 200 y no 204 desde PR-96: devuelve la configuración para que la
    // pantalla no tenga que volver a pedirla y enseñar el valor viejo.
    .expect(200);

describe('modo all (por defecto, como Kommo)', () => {
  it('el agente ve todo', async () => {
    expect(await idsVisibles(tokenAgente)).toEqual([mia, sinAsignar, deMiEquipo, ajena].sort());
  });
});

describe('modo team', () => {
  beforeAll(() => modo('team'));

  it('el agente ve las suyas, las sin asignar y las de su equipo — no las ajenas', async () => {
    expect(await idsVisibles(tokenAgente)).toEqual([mia, sinAsignar, deMiEquipo].sort());
  });

  it('la ajena tampoco se abre por id: 404, igual que si no existiera', async () => {
    // Un filtro en la lista que se pueda saltar escribiendo el id es decorativo.
    const r = await http
      .get(`/v1/conversaciones/${ajena}/mensajes`)
      .set(auth(tokenAgente))
      .expect(404);
    expect(r.body.codigo).toBe('conversacion_no_encontrada');
    await http
      .post(`/v1/conversaciones/${ajena}/mensajes`)
      .set(auth(tokenAgente))
      .send({ tipo: 'text', texto: 'x' })
      .expect(404);
  });

  it('las sin asignar siempre se ven: nadie las perdería', async () => {
    await http.get(`/v1/conversaciones/${sinAsignar}/mensajes`).set(auth(tokenAgente)).expect(200);
  });

  it('el propietario sigue viendo todo', async () => {
    expect(await idsVisibles(tokenOwner)).toEqual([mia, sinAsignar, deMiEquipo, ajena].sort());
  });
});

describe('modo assigned', () => {
  beforeAll(() => modo('assigned'));

  it('el agente ve solo las suyas', async () => {
    expect(await idsVisibles(tokenAgente)).toEqual([mia]);
  });

  it('ni siquiera las sin asignar', async () => {
    await http.get(`/v1/conversaciones/${sinAsignar}/mensajes`).set(auth(tokenAgente)).expect(404);
  });

  it('asignarle una la hace visible al instante', async () => {
    await http
      .patch(`/v1/conversaciones/${sinAsignar}/asignacion`)
      .set(auth(tokenOwner))
      .send({ agenteId })
      .expect(204);
    expect(await idsVisibles(tokenAgente)).toEqual([mia, sinAsignar].sort());
  });
});

describe('quién puede cambiar la política', () => {
  it('un agente no', async () => {
    const r = await http
      .patch('/v1/cuenta/visibilidad-conversaciones')
      .set(auth(tokenAgente))
      .send({ modo: 'all' })
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso');
  });

  it('un modo inventado da 400', async () => {
    await http
      .patch('/v1/cuenta/visibilidad-conversaciones')
      .set(auth(tokenOwner))
      .send({ modo: 'todo' })
      .expect(400);
  });

  it('queda en auditoría', async () => {
    const { rows } = await admin.query(
      `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'cuenta.visibilidad'`,
      [tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

/**
 * La visibilidad viaja con el reparto (PR-96).
 *
 * Llevaba desde 0010 aplicándose de verdad y **sin pantalla donde cambiarla**:
 * se hacía con un PATCH a mano. Ahora vive junto al reparto porque es la misma
 * pregunta vista por el otro lado —a quién le TOCA y qué puede VER—.
 */
describe('la visibilidad viaja con el reparto', () => {
  it('el reparto la lleva, para pintar la pantalla con una sola petición', async () => {
    await modo('all');
    const r = await http.get('/v1/cuenta/reparto').set(auth(tokenOwner)).expect(200);
    expect(r.body.visibilidad).toBe('all');
  });

  it('cambiarla devuelve la configuración ya actualizada', async () => {
    // Con 204 habría que volver a pedirla, y entre una respuesta y otra la
    // pantalla enseña el valor viejo.
    const r = await http
      .patch('/v1/cuenta/visibilidad-conversaciones')
      .set(auth(tokenOwner))
      .send({ modo: 'assigned' })
      .expect(200);
    expect(r.body.visibilidad).toBe('assigned');
    expect(Array.isArray(r.body.miembros)).toBe(true);
  });

  it('lo guardado es lo que se lee después', async () => {
    const r = await http.get('/v1/cuenta/reparto').set(auth(tokenOwner)).expect(200);
    expect(r.body.visibilidad).toBe('assigned');
  });

  it('un agente la LEE —le dice qué va a ver— pero no la cambia', async () => {
    const leer = await http.get('/v1/cuenta/reparto').set(auth(tokenAgente)).expect(200);
    expect(leer.body.visibilidad).toBe('assigned');

    const escribir = await http
      .patch('/v1/cuenta/visibilidad-conversaciones')
      .set(auth(tokenAgente))
      .send({ modo: 'all' })
      .expect(403);
    expect(escribir.body.codigo).toBe('sin_permiso');
  });

  it('y el cambio surte efecto en la bandeja, no solo en el ajuste', async () => {
    // Lo que hace que este ajuste importe: con `assigned` el agente deja de
    // ver las de otros. Si solo guardara la columna, esto no cambiaría.
    await modo('assigned');
    const suyas = await idsVisibles(tokenAgente);

    await modo('all');
    const todas = await idsVisibles(tokenAgente);

    expect(todas.length).toBeGreaterThan(suyas.length);
  });
});

/**
 * Equipos por la API (PR-97).
 *
 * `teams`, `team_members` y `conversations.team_id` existían desde 0002 y
 * 0004 **leéndose y sin que nadie las escribiera**. Los tests de arriba
 * sembraban los equipos con SQL directo, así que demostraban que la regla
 * funciona pero no que se pueda montar desde el producto.
 *
 * Lo que se prueba aquí es el recorrido entero por HTTP: crear el equipo,
 * meter a alguien, derivar una conversación, y que el modo `team` cambie lo
 * que ese agente ve. Si faltara cualquiera de las tres piezas, la
 * funcionalidad sería decorativa.
 */
describe('equipos por la API', () => {
  let nuevoEquipo: string;
  /** Propia, no la del escenario de arriba: los tests de antes la asignan. */
  let paraDerivar: string;

  it('un agente los LEE —sabe a dónde derivar— pero no los monta', async () => {
    await http.get('/v1/equipos').set(auth(tokenAgente)).expect(200);
    const r = await http
      .post('/v1/equipos')
      .set(auth(tokenAgente))
      .send({ nombre: 'Suyo' })
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso');
  });

  it('crear uno lo devuelve en la lista, con su contador a cero', async () => {
    const r = await http
      .post('/v1/equipos')
      .set(auth(tokenOwner))
      .send({ nombre: 'Mantenimiento' })
      .expect(201);
    const eq = r.body.find((e: { nombre: string }) => e.nombre === 'Mantenimiento');
    expect(eq).toBeTruthy();
    expect(eq.abiertas).toBe(0);
    expect(eq.miembros).toEqual([]);
    nuevoEquipo = eq.id;
  });

  it('el nombre no se puede repetir: es lo que se elige en un desplegable', async () => {
    const r = await http
      .post('/v1/equipos')
      .set(auth(tokenOwner))
      .send({ nombre: 'Mantenimiento' })
      .expect(409);
    expect(r.body.codigo).toBe('equipo_repetido');
  });

  it('meter a alguien es idempotente: marcar dos veces no es un error', async () => {
    await http
      .patch(`/v1/equipos/${nuevoEquipo}/miembros`)
      .set(auth(tokenOwner))
      .send({ userId: otroAgenteId, dentro: true })
      .expect(200);
    const r = await http
      .patch(`/v1/equipos/${nuevoEquipo}/miembros`)
      .set(auth(tokenOwner))
      .send({ userId: otroAgenteId, dentro: true })
      .expect(200);
    const eq = r.body.find((e: { id: string }) => e.id === nuevoEquipo);
    expect(eq.miembros).toHaveLength(1);
  });

  it('una persona puede estar en VARIOS equipos', async () => {
    // En un hotel pequeño, quien atiende recepción lleva también las reservas.
    await http
      .patch(`/v1/equipos/${equipoId}/miembros`)
      .set(auth(tokenOwner))
      .send({ userId: otroAgenteId, dentro: true })
      .expect(200);
    const r = await http.get('/v1/equipos').set(auth(tokenOwner)).expect(200);
    const enCuantos = r.body.filter((e: { miembros: { userId: string }[] }) =>
      e.miembros.some((m) => m.userId === otroAgenteId),
    );
    expect(enCuantos.length).toBeGreaterThanOrEqual(2);
  });

  it('derivar una conversación la pone en el equipo, sin asignársela a nadie', async () => {
    paraDerivar = await conversacion('Derivable', null, null);
    await http
      .patch(`/v1/conversaciones/${paraDerivar}/equipo`)
      .set(auth(tokenOwner))
      .send({ equipoId: nuevoEquipo })
      .expect(204);

    const r = await http.get('/v1/conversaciones').set(auth(tokenOwner)).expect(200);
    const c = r.body.items.find((i: { id: string }) => i.id === paraDerivar);
    expect(c.equipoId).toBe(nuevoEquipo);
    // Derivar no es asignar: sigue sin dueño.
    expect(c.agenteId).toBeNull();

    const lista = await http.get('/v1/equipos').set(auth(tokenOwner)).expect(200);
    expect(lista.body.find((e: { id: string }) => e.id === nuevoEquipo).abiertas).toBe(1);
  });

  it('un equipo inventado no cuela', async () => {
    const r = await http
      .patch(`/v1/conversaciones/${paraDerivar}/equipo`)
      .set(auth(tokenOwner))
      .send({ equipoId: '01a00000-0000-7000-8000-00000000dead' })
      .expect(422);
    expect(r.body.codigo).toBe('equipo_invalido');
  });

  it('y el modo `team` cambia lo que ve ese agente: el recorrido entero', async () => {
    // Esta es la prueba de que las tres piezas juntas hacen algo. Con una
    // sola de ellas, la funcionalidad sería decorativa.
    await http
      .patch(`/v1/conversaciones/${ajena}/equipo`)
      .set(auth(tokenOwner))
      .send({ equipoId: nuevoEquipo })
      .expect(204);
    await http
      .patch(`/v1/equipos/${nuevoEquipo}/miembros`)
      .set(auth(tokenOwner))
      .send({ userId: agenteId, dentro: true })
      .expect(200);

    await modo('team');
    const conEquipo = await idsVisibles(tokenAgente);
    expect(conEquipo).toContain(ajena);

    // Y sacarlo del equipo se la quita de delante.
    await http
      .patch(`/v1/equipos/${nuevoEquipo}/miembros`)
      .set(auth(tokenOwner))
      .send({ userId: agenteId, dentro: false })
      .expect(200);
    expect(await idsVisibles(tokenAgente)).not.toContain(ajena);
  });

  it('borrar el equipo NO cierra sus conversaciones: quedan sin equipo', async () => {
    // Perder trabajo en curso por reorganizar el organigrama sería el peor
    // cambio posible. El `ON DELETE SET NULL` de 0004 lo impide.
    await modo('all');
    await http.delete(`/v1/equipos/${nuevoEquipo}`).set(auth(tokenOwner)).expect(200);

    const r = await http.get('/v1/conversaciones').set(auth(tokenOwner)).expect(200);
    const c = r.body.items.find((i: { id: string }) => i.id === paraDerivar);
    expect(c).toBeTruthy();
    expect(c.equipoId).toBeNull();
  });

  it('renombrar uno que no existe da 404', async () => {
    const r = await http
      .patch('/v1/equipos/01a00000-0000-7000-8000-00000000dead')
      .set(auth(tokenOwner))
      .send({ nombre: 'Lo que sea' })
      .expect(404);
    expect(r.body.codigo).toBe('equipo_no_encontrado');
  });

  it('todo queda en la auditoría de la cuenta', async () => {
    const { rows } = await admin.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log
        WHERE tenant_id = $1 AND action LIKE 'equipo%' ORDER BY action`,
      [tenantId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'equipo.borrado',
      'equipo.creado',
      'equipo.miembro',
    ]);
  });
});

/**
 * Vistas de bandeja compartidas (0045).
 *
 * La migración 0020 dejó escrito cómo hacer esto: «compartirlas es otra
 * función, y cuando haga falta se añade una columna». Aquí se prueba con dos
 * personas de verdad, que es lo único que demuestra que compartir sirve.
 */
describe('vistas compartidas', () => {
  let mia: string;

  it('una vista nueva es PRIVADA: compartir es un gesto, no el estado por defecto', async () => {
    const r = await http
      .post('/v1/vistas')
      .set(auth(tokenOwner))
      .send({ nombre: 'Sin responder hoy', filtros: { sinRespuesta: 'true' } })
      .expect(201);
    mia = r.body.id;

    const propias = await http.get('/v1/vistas').set(auth(tokenOwner)).expect(200);
    expect(propias.body.find((v: { id: string }) => v.id === mia).compartida).toBe(false);

    // Y el agente no la ve.
    const delAgente = await http.get('/v1/vistas').set(auth(tokenAgente)).expect(200);
    expect(delAgente.body.find((v: { id: string }) => v.id === mia)).toBeUndefined();
  });

  it('compartida, el resto del equipo la ve —y sabe que no es suya', async () => {
    await http
      .patch(`/v1/vistas/${mia}/compartida`)
      .set(auth(tokenOwner))
      .send({ compartida: true })
      .expect(204);

    const delAgente = await http.get('/v1/vistas').set(auth(tokenAgente)).expect(200);
    const v = delAgente.body.find((x: { id: string }) => x.id === mia);
    expect(v).toBeTruthy();
    expect(v.compartida).toBe(true);
    // `mia` es lo que decide si se le enseñan los botones de tocarla.
    expect(v.mia).toBe(false);

    const delDueno = await http.get('/v1/vistas').set(auth(tokenOwner)).expect(200);
    expect(delDueno.body.find((x: { id: string }) => x.id === mia).mia).toBe(true);
  });

  it('quien no la creó NO puede dejar de compartirla ni borrarla', async () => {
    // Un 404 y no un 403: una vista ajena y una inexistente se contestan
    // igual, para no confirmar identificadores a quien los prueba.
    const r = await http
      .patch(`/v1/vistas/${mia}/compartida`)
      .set(auth(tokenAgente))
      .send({ compartida: false })
      .expect(404);
    expect(r.body.codigo).toBe('vista_no_encontrada');

    await http.delete(`/v1/vistas/${mia}`).set(auth(tokenAgente)).expect(404);

    // Y sigue compartida después del intento.
    const sigue = await http.get('/v1/vistas').set(auth(tokenAgente)).expect(200);
    expect(sigue.body.find((x: { id: string }) => x.id === mia).compartida).toBe(true);
  });

  it('dos compartidas no pueden llamarse igual: el equipo no las distinguiría', async () => {
    const suya = await http
      .post('/v1/vistas')
      .set(auth(tokenAgente))
      .send({ nombre: 'Sin responder hoy', filtros: { canal: 'whatsapp' } })
      .expect(201);

    // Privadas con el mismo nombre conviven: no se cruzan.
    const r = await http
      .patch(`/v1/vistas/${suya.body.id}/compartida`)
      .set(auth(tokenAgente))
      .send({ compartida: true })
      .expect(409);
    expect(r.body.codigo).toBe('nombre_compartido_repetido');
  });

  it('dejar de compartirla NO la borra: vuelve a ser privada de su autor', async () => {
    await http
      .patch(`/v1/vistas/${mia}/compartida`)
      .set(auth(tokenOwner))
      .send({ compartida: false })
      .expect(204);

    // Quien la usaba deja de verla...
    const delAgente = await http.get('/v1/vistas').set(auth(tokenAgente)).expect(200);
    expect(delAgente.body.find((x: { id: string }) => x.id === mia)).toBeUndefined();
    // ...y su autor la conserva entera.
    const delDueno = await http.get('/v1/vistas').set(auth(tokenOwner)).expect(200);
    expect(delDueno.body.find((x: { id: string }) => x.id === mia).filtros).toEqual({
      sinRespuesta: 'true',
    });
  });
});
