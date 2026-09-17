/**
 * Clientes por HTTP.
 *
 * Lo que se prueba de verdad: que importar el mismo archivo dos veces no
 * duplique a nadie, y que borrar un cliente que ya habló con el hotel no se
 * lleve por delante sus conversaciones.
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
const DB = 'crmapp_test_contactos';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;
let token: string;
let tokenAjeno: string;
let tokenAgente: string;
let tenantId: string;

const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

async function alta(slug: string) {
  const r = await http
    .post('/v1/cuentas')
    .send({
      nombreDeCuenta: slug,
      slug,
      email: `${slug}@test.test`,
      contrasena: 'contrasena-muy-larga',
      nombreCompleto: 'Recepción',
    })
    .expect(201);
  return r.body as { token: string };
}

async function crear(datos: Record<string, unknown>) {
  const r = await http.post('/v1/contactos').set(auth()).send(datos).expect(201);
  return (r.body as { id: string }).id;
}

const listar = async (query = '') => {
  const r = await http.get(`/v1/contactos${query}`).set(auth()).expect(200);
  return r.body as { items: { id: string; nombre: string | null; telefono: string | null }[] };
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
  // El rol de solo lectura de autenticación: sin él, aceptar una invitación
  // no encuentra la fila —RLS sin inquilino puesto— y el 404 no dice por qué.
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
  tenantId = (await admin.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'paraiso'`))
    .rows[0]!.id;

  // Un agente de la misma cuenta, para probar los permisos de borrado.
  const invitacion = await http
    .post('/v1/invitaciones')
    .set(auth())
    .send({ email: 'agente@test.test', rol: 'agent' })
    .expect(201);
  const aceptada = await http
    .post('/v1/invitaciones/aceptar')
    .send({
      token: (invitacion.body as { token: string }).token,
      contrasena: 'otra-contrasena-larga',
      nombreCompleto: 'Agente',
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

describe('clientes', () => {
  it('se crea con lo mínimo y aparece en la lista', async () => {
    const id = await crear({
      nombre: 'Ana Quispe',
      telefono: '+51 999 111 222',
      ciudad: 'Lima',
      origen: 'whatsapp',
      tipoDeHuesped: 'Familia',
    });
    const { items } = await listar();
    const ana = items.find((x) => x.id === id)!;
    expect(ana.nombre).toBe('Ana Quispe');
    // El teléfono se guarda sin espacios: si no, el mismo número entra dos veces.
    expect(ana.telefono).toBe('+51999111222');
  });

  it('un cliente sin nombre, sin teléfono y sin correo no es un cliente', async () => {
    const r = await http.post('/v1/contactos').set(auth()).send({ ciudad: 'Lima' }).expect(422);
    expect(r.body.codigo).toBe('contacto_vacio');
  });

  it('dos clientes con el mismo teléfono, no', async () => {
    await crear({ nombre: 'Luis', telefono: '+51988777666' });
    const r = await http
      .post('/v1/contactos')
      .set(auth())
      .send({ nombre: 'Luis otra vez', telefono: '+51 988 777 666' })
      .expect(409);
    expect(r.body.codigo).toBe('contacto_duplicado');
  });

  it('la búsqueda mira nombre, teléfono, correo y ciudad', async () => {
    await crear({ nombre: 'Carla Mendoza', email: 'carla@ejemplo.com', ciudad: 'Barranca' });
    expect((await listar('?q=Mendoza')).items).toHaveLength(1);
    expect((await listar('?q=carla@')).items).toHaveLength(1);
    expect((await listar('?q=Barranca')).items).toHaveLength(1);
    expect((await listar('?q=nadie')).items).toHaveLength(0);
  });

  it('importa un CSV de Excel en español, con punto y coma y acentos', async () => {
    const csv = [
      'Nombre;Teléfono;Correo;Ciudad;Observaciones',
      'Rosa Díaz;999 333 111;rosa@ejemplo.com;Huacho;"Viene con niños, pide cuna"',
      'Pedro Salas;;pedro@ejemplo.com;Lima;',
      ';;;Lima;sin forma de identificarlo', // se cuenta como omitido y se sigue
      ';;;;', // línea en blanco: ni siquiera llega a ser una fila
    ].join('\r\n');

    const r = await http
      .post('/v1/contactos/importar')
      .set(auth())
      .send({ csv, prefijo: '+51' })
      .expect(201);
    expect(r.body).toMatchObject({ creados: 2, actualizados: 0, omitidos: 1, errores: [] });

    const { items } = await listar('?q=Rosa');
    // El prefijo se aplica porque lo pidió quien importa, no porque lo adivine nadie.
    expect(items[0]!.telefono).toBe('+51999333111');
  });

  it('importar dos veces el mismo archivo no duplica a nadie', async () => {
    const csv = 'nombre,telefono\nMiguel Torres,+51955444333';
    const primera = await http.post('/v1/contactos/importar').set(auth()).send({ csv }).expect(201);
    expect(primera.body.creados).toBe(1);

    const segunda = await http.post('/v1/contactos/importar').set(auth()).send({ csv }).expect(201);
    expect(segunda.body).toMatchObject({ creados: 0, actualizados: 1 });
    expect((await listar('?q=Miguel')).items).toHaveLength(1);
  });

  it('dice qué columnas ignoró, en vez de tragárselas en silencio', async () => {
    const r = await http
      .post('/v1/contactos/importar')
      .set(auth())
      .send({ csv: 'nombre,telefono,signo del zodiaco\nJulia,+51900000001,Piscis' })
      .expect(201);
    expect(r.body.columnasIgnoradas).toEqual(['signo del zodiaco']);
  });

  it('un archivo sin ninguna columna reconocible se rechaza explicando qué falta', async () => {
    const r = await http
      .post('/v1/contactos/importar')
      .set(auth())
      .send({ csv: 'columna1,columna2\na,b' })
      .expect(422);
    expect(r.body.codigo).toBe('csv_sin_columnas_utiles');
    expect(r.body.columnas).toEqual(['columna1', 'columna2']);
  });

  it('exporta lo mismo que se ve, y se puede volver a importar', async () => {
    const r = await http.get('/v1/contactos/exportar?q=Mendoza').set(auth()).expect(200);
    expect(r.body.nombreDeArchivo).toMatch(/^clientes-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(r.body.csv.split('\r\n')[0]).toContain('nombre');
    expect(r.body.csv).toContain('Carla Mendoza');

    const vuelta = await http
      .post('/v1/contactos/importar')
      .set(auth())
      .send({ csv: r.body.csv })
      .expect(201);
    expect(vuelta.body).toMatchObject({ creados: 0, actualizados: 1 });
  });

  it('borrar a quien nunca escribió lo borra de verdad', async () => {
    const id = await crear({ nombre: 'Creado por error', telefono: '+51911111111' });
    const r = await http.delete(`/v1/contactos/${id}`).set(auth()).expect(200);
    expect(r.body.accion).toBe('borrado');
    const { rows } = await admin.query(`SELECT 1 FROM contacts WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('borrar a quien ya habló lo anonimiza y NO toca sus conversaciones', async () => {
    const id = await crear({ nombre: 'Huésped con historia', telefono: '+51922222222' });
    const ca = (
      await admin.query<{ id: string }>(
        `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
         VALUES ($1,'whatsapp','pn-clientes','WA') RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    const identidad = (
      await admin.query<{ id: string }>(
        `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id, handle, phone_e164)
         VALUES ($1,$2,'whatsapp',$3,'wa-historia','+51922222222','+51922222222') RETURNING id`,
        [tenantId, id, ca],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id)
       VALUES ($1,$2,$3,$4)`,
      [tenantId, identidad, id, ca],
    );

    const r = await http.delete(`/v1/contactos/${id}`).set(auth()).expect(200);
    expect(r.body.accion).toBe('anonimizado');

    const { rows } = await admin.query<{
      display_name: string;
      phone: string | null;
      anonymized_at: Date | null;
    }>(`SELECT display_name, phone, anonymized_at FROM contacts WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({ display_name: 'Cliente eliminado', phone: null });
    expect(rows[0]!.anonymized_at).not.toBeNull();

    // La conversación sigue ahí: los mensajes son del negocio.
    const conv = await admin.query(`SELECT 1 FROM conversations WHERE contact_id = $1`, [id]);
    expect(conv.rows).toHaveLength(1);
    // Y el rastro personal de la identidad se fue con la persona.
    const ident = await admin.query<{ handle: string | null; phone_e164: string | null }>(
      `SELECT handle, phone_e164 FROM contact_identities WHERE contact_id = $1`,
      [id],
    );
    expect(ident.rows[0]).toMatchObject({ handle: null, phone_e164: null });

    // Y desaparece de la lista, que es lo que el usuario esperaba al borrar.
    expect((await listar('?q=historia')).items).toHaveLength(0);
  });

  it('un agente no borra clientes', async () => {
    const id = await crear({ nombre: 'Intocable', telefono: '+51933333333' });
    const r = await http.delete(`/v1/contactos/${id}`).set(auth(tokenAgente)).expect(403);
    expect(r.body.codigo).toBe('permiso_insuficiente');
  });

  it('la ficha trae identidades, conversaciones y el historial de reservas', async () => {
    const id = await crear({ nombre: 'Con ficha', telefono: '+51944444444' });
    const r = await http.get(`/v1/contactos/${id}`).set(auth()).expect(200);
    expect(r.body).toMatchObject({ nombre: 'Con ficha', identidades: [], conversaciones: [] });
    expect(Array.isArray(r.body.reservas)).toBe(true);
  });

  it('el cliente del hotel de al lado no existe', async () => {
    const id = await crear({ nombre: 'Solo nuestro', telefono: '+51900000009' });
    await http.get(`/v1/contactos/${id}`).set(auth(tokenAjeno)).expect(404);
    expect((await http.get('/v1/contactos').set(auth(tokenAjeno)).expect(200)).body.items).toEqual(
      [],
    );
  });

  it('sin sesión no hay clientes', async () => {
    await http.get('/v1/contactos').expect(401);
  });
});

describe('fusionar duplicados (P-08)', () => {
  /** Una ficha con conversación, etiqueta y lead: lo que hay que mover. */
  async function conHistoria(nombre: string, extra: Record<string, unknown> = {}) {
    const id = await crear({ nombre, ...extra });
    const ca = (
      await admin.query<{ id: string }>(
        `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
         VALUES ($1, 'whatsapp', $2, 'WA') RETURNING id`,
        [tenantId, `pn-${nombre}`],
      )
    ).rows[0]!.id;
    const ci = (
      await admin.query<{ id: string }>(
        `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
         VALUES ($1, $2, 'whatsapp', $3, $4) RETURNING id`,
        [tenantId, id, ca, `u-${nombre}`],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, status)
       VALUES ($1, $2, $3, $4, 'open')`,
      [tenantId, ci, id, ca],
    );
    return id;
  }

  const cuentaDe = async (tabla: string, contactId: string) =>
    Number(
      (
        await admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${tabla} WHERE contact_id = $1`,
          [contactId],
        )
      ).rows[0]!.n,
    );

  it('mueve conversaciones e identidades, y el absorbido desaparece del listado', async () => {
    const destino = await conHistoria('Rosa Destino');
    const origen = await conHistoria('Rosa Origen');

    const r = await http
      .post(`/v1/contactos/${destino}/fusionar`)
      .set(auth())
      .send({ origenId: origen, motivo: 'mismo huésped, dos números' })
      .expect(200);
    expect(r.body.movidas).toBeGreaterThanOrEqual(2);

    expect(await cuentaDe('conversations', destino)).toBe(2);
    expect(await cuentaDe('conversations', origen)).toBe(0);
    expect(await cuentaDe('contact_identities', destino)).toBe(2);

    const lista = await listar();
    expect(lista.items.map((i) => i.id)).toContain(destino);
    expect(lista.items.map((i) => i.id)).not.toContain(origen);
  });

  it('rellena los huecos del destino pero NO pisa lo que ya tenía escrito', async () => {
    const destino = await crear({ nombre: 'Con teléfono', telefono: '+51977000001' });
    const origen = await crear({
      nombre: 'Con correo',
      telefono: '+51977000002',
      email: 'huesped-fusion@ejemplo.test',
      ciudad: 'Barranca',
    });

    await http
      .post(`/v1/contactos/${destino}/fusionar`)
      .set(auth())
      .send({ origenId: origen })
      .expect(200);

    const ficha = await http.get(`/v1/contactos/${destino}`).set(auth()).expect(200);
    // El teléfono del destino manda; el correo y la ciudad se rellenan.
    expect(ficha.body.telefono).toBe('+51977000001');
    expect(ficha.body.email).toBe('huesped-fusion@ejemplo.test');
    expect(ficha.body.ciudad).toBe('Barranca');
  });

  it('deshacer devuelve cada cosa a su sitio, incluidos los huecos rellenados', async () => {
    const destino = await conHistoria('Vuelve Destino');
    const origen = await conHistoria('Vuelve Origen', { ciudad: 'Lima' });

    await http
      .post(`/v1/contactos/${destino}/fusionar`)
      .set(auth())
      .send({ origenId: origen })
      .expect(200);
    await http.post(`/v1/contactos/${origen}/deshacer-fusion`).set(auth()).expect(204);

    expect(await cuentaDe('conversations', destino)).toBe(1);
    expect(await cuentaDe('conversations', origen)).toBe(1);
    // La ciudad que se rellenó vuelve a estar vacía en el destino.
    const ficha = await http.get(`/v1/contactos/${destino}`).set(auth()).expect(200);
    expect(ficha.body.ciudad).toBeNull();
    // Y el absorbido vuelve al listado.
    expect((await listar()).items.map((i) => i.id)).toContain(origen);
  });

  it('no se fusiona consigo mismo ni dos veces en cadena', async () => {
    const a = await crear({ nombre: 'Cadena A' });
    const b = await crear({ nombre: 'Cadena B' });
    const c = await crear({ nombre: 'Cadena C' });

    await http.post(`/v1/contactos/${a}/fusionar`).set(auth()).send({ origenId: a }).expect(422);

    await http.post(`/v1/contactos/${a}/fusionar`).set(auth()).send({ origenId: b }).expect(200);
    // `b` ya está absorbido: encadenar dejaría sus cosas repartidas entre tres.
    const r = await http
      .post(`/v1/contactos/${c}/fusionar`)
      .set(auth())
      .send({ origenId: b })
      .expect(409);
    expect(r.body.codigo).toBe('ya_fusionado');
  });

  it('propone duplicados por nombre, que es el único que puede repetirse', async () => {
    // Por teléfono o correo no puede haber duplicados: la base tiene índice
    // único en los dos. Una sugerencia que nunca sugiere nada no sirve.
    const uno = await crear({ nombre: 'Ana García', telefono: '+51977000003' });
    const dos = await crear({ nombre: 'ana garcia', telefono: '+51977000004' });
    await crear({ nombre: 'Otra Persona', telefono: '+51977000005' });

    const r = await http.get(`/v1/contactos/${uno}/duplicados`).set(auth()).expect(200);
    const filas = r.body as { id: string; porque: string }[];
    // Sin acentos ni mayúsculas: lo escribieron dos agentes distintos.
    expect(filas.map((d) => d.id)).toEqual([dos]);
    expect(filas[0]!.porque).toBe('mismo nombre');
  });

  it('un contacto ya fusionado no se propone: su ficha vive en otra', async () => {
    const vive = await crear({ nombre: 'Repetido Vivo' });
    const absorbido = await crear({ nombre: 'Repetido Vivo' });
    const tercero = await crear({ nombre: 'Repetido Vivo' });
    await http
      .post(`/v1/contactos/${vive}/fusionar`)
      .set(auth())
      .send({ origenId: absorbido })
      .expect(200);

    const r = await http.get(`/v1/contactos/${tercero}/duplicados`).set(auth()).expect(200);
    expect((r.body as { id: string }[]).map((d) => d.id)).toEqual([vive]);
  });

  it('queda registrado quién fusionó y por qué', async () => {
    const destino = await crear({ nombre: 'Auditado' });
    const origen = await crear({ nombre: 'Auditado viejo' });
    await http
      .post(`/v1/contactos/${destino}/fusionar`)
      .set(auth())
      .send({ origenId: origen, motivo: 'escribió desde otro número' })
      .expect(200);

    const { rows } = await admin.query<{
      reason: string;
      merged_by: string | null;
      moved: { nota?: string };
    }>(`SELECT reason, merged_by, moved FROM contact_merges WHERE source_contact_id = $1`, [
      origen,
    ]);
    // `reason` distingue la fusión manual de la automática; lo que escribió el
    // agente va aparte, para no ensanchar esa distinción.
    expect(rows[0]!.reason).toBe('manual');
    expect(rows[0]!.moved.nota).toBe('escribió desde otro número');
    expect(rows[0]!.merged_by).not.toBeNull();
  });
});
