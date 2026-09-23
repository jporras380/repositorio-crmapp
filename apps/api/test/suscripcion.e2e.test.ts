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
import { inicioDePeriodo, migrar, reintentandoSiChocaElCatalogo } from '@crmapp/db';
import { AppModule } from '../src/app.module.js';
import { FiltroDeErrores } from '../src/errores.js';
import { AlmacenEnMemoria } from '@crmapp/storage';

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
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD 'crmapp_dev'`),
  );
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD 'crmapp_dev'`),
  );
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_operador LOGIN PASSWORD 'crmapp_dev'`),
  );
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_soporte LOGIN PASSWORD 'crmapp_dev'`),
  );
  await conf.query(
    `GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_auth, crmapp_operador, crmapp_soporte`,
  );
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });

  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', 'crmapp_dev'),
      // Sin esto, la lectura de identidad cae al rol de inquilino y `users`
      // no devuelve nada: la política que deja leerla es del rol de
      // autenticación. Costó un rato descubrirlo porque no falla, devuelve
      // vacío.
      authDatabaseUrl: url(DB, 'crmapp_auth', 'crmapp_dev'),
      operadorDatabaseUrl: url(DB, 'crmapp_operador', 'crmapp_dev'),
      soporteDatabaseUrl: url(DB, 'crmapp_soporte', 'crmapp_dev'),
      jwtSecret: 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres',
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
      // 0044: el chat de soporte firma capturas. Sin almacen, esas rutas
      // responden 503 y no se probaria lo que se quiere probar.
      almacen: new AlmacenEnMemoria(),
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

/**
 * Factura o boleta, y el comprobante (0039).
 *
 * Lo que se prueba es lo que le cuesta dinero al hotel —una factura sin RUC la
 * rechaza SUNAT y se pierde el crédito fiscal— y lo que protege a todos: que
 * el operador de la plataforma no pueda tocar la cuenta de otro.
 */
describe('facturación y comprobantes', () => {
  const suscripcion = async () =>
    (await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200)).body;
  const guardar = (cuerpo: Record<string, unknown>) =>
    http.put('/v1/cuenta/suscripcion/facturacion').set(auth()).send(cuerpo);

  it('empieza en boleta: es lo que vale sin pedir nada', async () => {
    expect((await suscripcion()).facturacion.tipo).toBe('boleta');
  });

  it('una factura sin RUC se rechaza, y dice QUÉ falta', async () => {
    const r = await guardar({ tipo: 'factura' }).expect(422);
    expect(r.body.codigo).toBe('facturacion_incompleta');
    // Las tres cosas de una vez: de una en una serían tres intentos.
    expect(r.body.mensaje).toContain('RUC');
    expect(r.body.mensaje).toContain('razón social');
    expect(r.body.mensaje).toContain('dirección');
  });

  it('una factura con el RUC mal tecleado no pasa', async () => {
    const r = await guardar({
      tipo: 'factura',
      documento: '20100070971',
      nombre: 'Apart Hotel El Paraíso SAC',
      direccion: 'Av. Grau 100, Barranca',
    }).expect(422);
    expect(r.body.mensaje).toContain('no es válido');
  });

  it('con los tres datos buenos se guarda', async () => {
    await guardar({
      tipo: 'factura',
      documento: '20100070970',
      nombre: 'Apart Hotel El Paraíso SAC',
      direccion: 'Av. Grau 100, Barranca',
    }).expect(200);

    const f = (await suscripcion()).facturacion;
    expect(f.tipo).toBe('factura');
    expect(f.documento).toBe('20100070970');
  });

  it('volver a boleta no exige RUC', async () => {
    await guardar({ tipo: 'boleta', documento: '12345678', nombre: 'Rosa Quispe' }).expect(200);
    expect((await suscripcion()).facturacion.tipo).toBe('boleta');
  });

  it('cada pago dice el estado de su comprobante y cuándo vence el plazo', async () => {
    const pagos = (await suscripcion()).pagos;
    expect(pagos.length).toBeGreaterThan(0);
    const p = pagos[0];
    expect(p.id).toBeTruthy();
    expect(p.comprobante.medioId).toBeNull();
    // Recién registrado: pendiente, no retrasado. Son cosas distintas —lo
    // segundo es un incumplimiento nuestro.
    expect(['pendiente', 'retrasado']).toContain(p.comprobante.estado);
    expect(new Date(p.comprobante.venceEn).getTime()).toBeGreaterThan(0);
  });

  it('un pago registrado hace 3 días sin comprobante sale RETRASADO', async () => {
    await admin.query(
      `UPDATE subscription_payments SET created_at = now() - interval '3 days'
        WHERE tenant_id = $1`,
      [tenantId],
    );
    const pagos = (await suscripcion()).pagos;
    expect(
      pagos.every((p: { comprobante: { estado: string } }) => p.comprobante.estado === 'retrasado'),
    ).toBe(true);
  });
});

describe('el operador de la plataforma', () => {
  it('quien NO es operador recibe 404, no 403', async () => {
    // 403 le confirmaría que la ruta existe a quien la está buscando.
    const r = await http
      .post('/v1/operador/pagos/01a00000-0000-7000-8000-000000000000/comprobante')
      .set(auth())
      .send({
        tenantId: '01a00000-0000-7000-8000-000000000001',
        mediaAssetId: '01a00000-0000-7000-8000-000000000002',
      });
    expect(r.status).toBe(404);
    expect(r.body.codigo).toBe('no_encontrado');
  });

  it('siendo operador, adjunta el comprobante y el hotel lo ve', async () => {
    // Se marca a la dueña como personal de la plataforma. En la realidad esto
    // se hace por consola y nunca desde la aplicación, que es justo el punto.
    //
    // Hace falta el contexto de inquilino: `users` lleva RLS **forzada**, así
    // que ni el dueño de la tabla la salta. Sin esto, el UPDATE no toca
    // ninguna fila y no se queja — que es como se perdió un rato aquí.
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      // `SET LOCAL` no admite parámetros; `set_config(..., true)` es su
      // equivalente que sí, y evita concatenar un id en el SQL.
      await cliente.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await cliente.query(
        `UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`,
      );
      expect(r.rowCount).toBe(1);
      await cliente.query('COMMIT');
    } finally {
      cliente.release();
    }

    // Un medio subido dentro de la cuenta del hotel.
    const { rows: medio } = await admin.query<{ id: string }>(
      `INSERT INTO media_assets (id, tenant_id, kind, status, mime, bytes, storage_key)
       VALUES (uuidv7(), $1, 'document', 'stored', 'application/pdf', 1000, 'k/1')
       RETURNING id`,
      [tenantId],
    );
    const { rows: pago } = await admin.query<{ id: string }>(
      `SELECT id FROM subscription_payments WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    await http
      .post(`/v1/operador/pagos/${pago[0]!.id}/comprobante`)
      .set(auth())
      .send({ tenantId, mediaAssetId: medio[0]!.id, numero: 'F001-00000123' })
      .expect(201);

    const p = (await http.get('/v1/cuenta/suscripcion').set(auth()).expect(200)).body.pagos.find(
      (x: { id: string }) => x.id === pago[0]!.id,
    );
    expect(p.comprobante.estado).toBe('disponible');
    expect(p.comprobante.numero).toBe('F001-00000123');
    expect(p.comprobante.medioId).toBe(medio[0]!.id);
  });

  it('queda en la auditoría DEL HOTEL quién lo hizo', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE tenant_id = $1 AND action = 'suscripcion.comprobante_subido'`,
      [tenantId],
    );
    // El hotel tiene derecho a ver quién tocó su cuenta desde fuera.
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('el operador NO puede adjuntar un medio de otra cuenta', async () => {
    const { rows: otro } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Otro Hotel', 'otro-hotel-0039') RETURNING id`,
    );
    const { rows: medioAjeno } = await admin.query<{ id: string }>(
      `INSERT INTO media_assets (id, tenant_id, kind, status, mime, bytes, storage_key)
       VALUES (uuidv7(), $1, 'document', 'stored', 'application/pdf', 1000, 'k/2')
       RETURNING id`,
      [otro[0]!.id],
    );
    const { rows: pago } = await admin.query<{ id: string }>(
      `SELECT id FROM subscription_payments WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    // El medio existe, pero no en esta cuenta: la RLS del inquilino de destino
    // no lo encuentra, así que no hace falta comprobarlo a mano.
    const r = await http
      .post(`/v1/operador/pagos/${pago[0]!.id}/comprobante`)
      .set(auth())
      .send({ tenantId, mediaAssetId: medioAjeno[0]!.id });
    expect(r.status).toBe(404);
  });
});

/**
 * La consola del operador (0040).
 *
 * El test que más importa no es el que comprueba que se ven las cuentas: es el
 * que comprueba que **no** se ven las conversaciones. El rol del operador
 * atraviesa el aislamiento que sostiene el producto, y lo único que hace eso
 * aceptable es que la lista de lo que puede leer sea corta y esté probada.
 */
describe('consola del operador', () => {
  it('sin ser operador, la consola no existe', async () => {
    await admin.query(`UPDATE users SET is_operator = false WHERE email = 'jefe@acme.test'`);
    const r = await http.get('/v1/operador/cuentas').set(auth());
    expect(r.status).toBe(404);
  });

  it('siendo operador, ve TODAS las cuentas, no solo la suya', async () => {
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
    const r = await http.get('/v1/operador/cuentas').set(auth()).expect(200);

    const slugs = r.body.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('acme');
    // `otro-hotel-0039` lo creó el bloque de arriba: es de otro inquilino, y
    // verlo es justo lo que distingue a la consola de la pantalla del hotel.
    expect(slugs).toContain('otro-hotel-0039');
  });

  it('trae lo que hace falta para cobrar', async () => {
    const r = await http.get('/v1/operador/cuentas').set(auth()).expect(200);
    const acme = r.body.find((c: { slug: string }) => c.slug === 'acme');

    expect(acme.plan).toBe('Starter');
    expect(acme.asientos).toBeGreaterThan(0);
    // El mismo cálculo que ve el hotel: si aquí saliera otro, uno miente.
    expect(acme.importeMensualCentimos).toBe(2500 * acme.asientos);
    expect(acme.moneda).toBe('USD');
  });

  it('pone primero a quien le debemos un comprobante', async () => {
    const r = await http.get('/v1/operador/cuentas').set(auth()).expect(200);
    const pendientes = r.body.map(
      (c: { comprobantesPendientes: number }) => c.comprobantesPendientes,
    );
    // Orden descendente: lo que hay que atender antes, arriba.
    expect([...pendientes].sort((a: number, b: number) => b - a)).toEqual(pendientes);
  });

  it('devuelve EXACTAMENTE estos campos y ninguno más', async () => {
    const r = await http.get('/v1/operador/cuentas').set(auth()).expect(200);

    // Lista blanca y no lista negra: buscar palabras prohibidas en el JSON es
    // burdo —`mensajesDelMes` es un contador y contiene «mensaje»— y además
    // no protege de un campo nuevo con otro nombre. Fijar los campos sí: el
    // día que alguien añada uno, este test lo para y hay que justificarlo.
    const esperados = [
      'tenantId',
      'nombre',
      'slug',
      'altaEn',
      'plan',
      'estado',
      'pruebaHasta',
      'periodoHasta',
      'diasDeGracia',
      'asientos',
      'importeMensualCentimos',
      'moneda',
      'comprobantesPendientes',
      'comprobanteMasViejoEn',
      'canales',
      'canalesConProblema',
      'ultimoEventoEn',
      'mensajesDelMes',
      // Añadido en 0043: cuántos mensajes de soporte de ESTE cliente están
      // sin leer. Es un contador, no contenido.
      'soporteSinLeer',
    ].sort();
    for (const cuenta of r.body) {
      expect(Object.keys(cuenta).sort()).toEqual(esperados);
    }
    // Todo lo que sale son cifras y fechas; nada es texto escrito por nadie.
    expect(r.body[0].mensajesDelMes).toBeTypeOf('number');
  });

  it('el rol del operador NO puede leer conversaciones ni contactos', async () => {
    // Se comprueba en la base, no en la API: si mañana alguien escribe una
    // consulta nueva en la consola, esto sigue siendo verdad o falla aquí.
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('SET LOCAL ROLE crmapp_operador');
      for (const tabla of ['conversations', 'messages', 'contacts']) {
        await expect(cliente.query(`SELECT 1 FROM ${tabla} LIMIT 1`)).rejects.toThrow(
          /permission denied/i,
        );
        await cliente.query('ROLLBACK');
        await cliente.query('BEGIN');
        await cliente.query('SET LOCAL ROLE crmapp_operador');
      }
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  });

  it('el rol del operador tampoco puede ESCRIBIR lo que sí lee', async () => {
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('SET LOCAL ROLE crmapp_operador');
      // Solo lectura: si se encadenara una inyección hasta este rol, podría
      // contar cuentas ajenas, no tocarlas.
      await expect(cliente.query(`UPDATE subscriptions SET status = 'active'`)).rejects.toThrow(
        /permission denied/i,
      );
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  });
});

/**
 * Modo soporte (0042).
 *
 * El test que sostiene todo lo demás es el que comprueba que **el operador no
 * puede abrirse la puerta él solo**. Si eso fallara, las otras tres
 * condiciones —plazo, solo lectura, auditoría— serían decoración.
 */
describe('modo soporte', () => {
  let solicitud: string;

  beforeAll(async () => {
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
  });

  it('el operador pide entrar, y tiene que decir para qué', async () => {
    const corto = await http
      .post('/v1/operador/soporte')
      .set(auth())
      .send({ tenantId, motivo: 'ayuda' })
      .expect(400);
    expect(corto.body.codigo).toBe('datos_invalidos');

    const r = await http
      .post('/v1/operador/soporte')
      .set(auth())
      .send({ tenantId, motivo: 'Dicen que no les llegan los mensajes de WhatsApp desde ayer.' })
      .expect(201);
    solicitud = r.body.id;
    expect(solicitud).toBeTruthy();
  });

  it('pedir NO da acceso: hasta que el cliente abre, no se entra', async () => {
    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/conversaciones`)
      .set(auth())
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso_de_soporte');
  });

  it('el rol del operador NO puede aprobarse a sí mismo la solicitud', async () => {
    // La condición que sostiene el resto, comprobada en la BASE: aunque
    // mañana alguien escriba un endpoint nuevo, el permiso lo para.
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('SET LOCAL ROLE crmapp_operador');
      await expect(cliente.query(`UPDATE support_grants SET approved_at = now()`)).rejects.toThrow(
        /permission denied/i,
      );
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  });

  it('el cliente ve quién pide entrar y por qué', async () => {
    const r = await http.get('/v1/cuenta/soporte').set(auth()).expect(200);
    const p = r.body.find((x: { id: string }) => x.id === solicitud);
    expect(p.estado).toBe('pendiente');
    expect(p.motivo).toContain('no les llegan');
    // Con nombre: «alguien» pidiendo entrar no se puede valorar.
    expect(p.pedidoPor).toBeTruthy();
  });

  it('un plazo absurdo se rechaza', async () => {
    await http
      .post(`/v1/cuenta/soporte/${solicitud}/aprobar`)
      .set(auth())
      .send({ horas: 720 })
      .expect(422);
  });

  it('el cliente abre la puerta y el operador entra', async () => {
    await http
      .post(`/v1/cuenta/soporte/${solicitud}/aprobar`)
      .set(auth())
      .send({ horas: 2 })
      .expect(200);

    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/conversaciones`)
      .set(auth())
      .expect(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('lo que se ve es diagnóstico, no lo que la gente se dice', async () => {
    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/conversaciones`)
      .set(auth())
      .expect(200);
    const campos = [
      'id',
      'canal',
      'estado',
      'ultimoEntranteEn',
      'ultimoSalienteEn',
      'mensajesFallidos',
      'ultimoError',
    ].sort();
    for (const conv of r.body) expect(Object.keys(conv).sort()).toEqual(campos);
  });

  it('el rol de soporte NO puede escribir nada, aunque haya permiso', async () => {
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('SET LOCAL ROLE crmapp_soporte');
      // Un soporte que puede escribir puede romper, y entonces nadie sabe si
      // el fallo era del cliente o de quien fue a ayudarle.
      await expect(cliente.query(`UPDATE conversations SET status = 'closed'`)).rejects.toThrow(
        /permission denied/i,
      );
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  });

  it('entrar con permiso a UNA cuenta no abre las demás', async () => {
    const cliente = await admin.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('SET LOCAL ROLE crmapp_soporte');
      // Sin inquilino en el contexto, la política de aislamiento no deja ver
      // nada. No hace falta ninguna comprobación escrita a mano.
      const { rows } = await cliente.query(`SELECT 1 FROM conversations LIMIT 1`);
      expect(rows).toHaveLength(0);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
  });

  it('revocar cierra la puerta al momento', async () => {
    await http.post(`/v1/cuenta/soporte/${solicitud}/revocar`).set(auth()).expect(200);

    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/conversaciones`)
      .set(auth())
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso_de_soporte');
  });

  it('todo queda en la auditoría DEL CLIENTE', async () => {
    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE tenant_id = $1 AND action LIKE 'soporte.%' ORDER BY created_at`,
      [tenantId],
    );
    // Quién pidió, quién abrió y quién cerró: el cliente lo mira sin
    // preguntarle a nadie.
    expect(rows.map((r) => r.action)).toEqual([
      'soporte.solicitado',
      'soporte.aprobado',
      'soporte.revocado',
    ]);
  });
});

/**
 * Chat con soporte técnico (0043).
 *
 * Hoy un cliente con un problema escribe a un número personal por WhatsApp:
 * el historial se pierde, nadie sabe qué se respondió, y quien atiende no
 * tiene delante ni el plan ni el estado de sus canales. Esto lo mete donde ya
 * está trabajando.
 */
describe('chat con soporte', () => {
  beforeAll(async () => {
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
  });

  it('el hilo empieza vacío', async () => {
    const r = await http.get('/v1/cuenta/soporte/mensajes').set(auth()).expect(200);
    expect(r.body).toEqual([]);
  });

  it('el cliente escribe y su mensaje queda en el hilo, con su nombre', async () => {
    const r = await http
      .post('/v1/cuenta/soporte/mensajes')
      .set(auth())
      .send({ cuerpo: 'No me llegan los mensajes de WhatsApp desde ayer por la tarde.' })
      .expect(201);

    expect(r.body).toHaveLength(1);
    expect(r.body[0].deLaPlataforma).toBe(false);
    expect(r.body[0].autor).toBeTruthy();
    expect(r.body[0].cuerpo).toContain('No me llegan');
  });

  it('un mensaje vacío no se guarda', async () => {
    await http.post('/v1/cuenta/soporte/mensajes').set(auth()).send({ cuerpo: '   ' }).expect(422);
  });

  it('la consola del operador avisa de quién está esperando', async () => {
    const r = await http.get('/v1/operador/cuentas').set(auth()).expect(200);
    const acme = r.body.find((c: { slug: string }) => c.slug === 'acme');
    expect(acme.soporteSinLeer).toBe(1);
    // Y va primero: un cliente escribiendo está parado, y eso es más urgente
    // que un comprobante pendiente.
    expect(r.body[0].slug).toBe('acme');
  });

  it('el operador lee el hilo, y con eso deja de estar sin leer', async () => {
    const r = await http.get(`/v1/operador/soporte/${tenantId}/mensajes`).set(auth()).expect(200);
    expect(r.body).toHaveLength(1);

    const consola = await http.get('/v1/operador/cuentas').set(auth()).expect(200);
    expect(consola.body.find((c: { slug: string }) => c.slug === 'acme').soporteSinLeer).toBe(0);
  });

  it('el operador responde, y la respuesta queda DENTRO de la cuenta del cliente', async () => {
    await http
      .post(`/v1/operador/soporte/${tenantId}/mensajes`)
      .set(auth())
      .send({ cuerpo: 'Lo miramos ahora. ¿Puedes darnos acceso para ver la bandeja?' })
      .expect(201);

    // El cliente la ve en SU hilo, sin que nadie se la reenvíe.
    const r = await http.get('/v1/cuenta/soporte/mensajes').set(auth()).expect(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[1].deLaPlataforma).toBe(true);
    expect(r.body[1].cuerpo).toContain('Lo miramos');
  });

  it('el hilo sale en orden: lo primero arriba', async () => {
    const r = await http.get('/v1/cuenta/soporte/mensajes').set(auth()).expect(200);
    const fechas = r.body.map((m: { creadoEn: string }) => m.creadoEn);
    expect([...fechas].sort()).toEqual(fechas);
  });

  it('responder NO exige permiso de soporte: contestar no es entrar', async () => {
    // No hay ningún permiso vivo en este punto, y la respuesta de arriba pasó.
    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/conversaciones`)
      .set(auth())
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso_de_soporte');
  });

  it('el chat NO ensucia las conversaciones del hotel', async () => {
    // Si viviera en `conversations`, contaría para los topes del plan y un bot
    // podría acabar respondiéndole a soporte.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM conversations WHERE tenant_id = $1`,
      [tenantId],
    );
    const antes = Number(rows[0]!.n);
    await http
      .post('/v1/cuenta/soporte/mensajes')
      .set(auth())
      .send({ cuerpo: 'Otra consulta distinta para comprobar que no cuenta como conversación.' })
      .expect(201);
    const { rows: despues } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM conversations WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(Number(despues[0]!.n)).toBe(antes);
  });

  it('quien no es operador no puede leer el hilo de otra cuenta', async () => {
    await admin.query(`UPDATE users SET is_operator = false WHERE email = 'jefe@acme.test'`);
    await http.get(`/v1/operador/soporte/${tenantId}/mensajes`).set(auth()).expect(404);
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
  });
});

/**
 * Capturas en el chat de soporte (0044).
 *
 * «No me sale el boton» y una imagen del boton que no sale son la misma
 * frase, pero solo una se entiende a la primera.
 *
 * El test que sostiene todo lo demas es el ultimo: que el operador **no
 * pueda firmar un medio que no cuelgue de este hilo**. Sin esa condicion,
 * esta ruta seria un lector universal de medios para la plataforma -una foto
 * de un huesped incluida- y se caeria la promesa entera de la consola.
 */
describe('capturas en el chat de soporte', () => {
  /** Un medio ya subido de la cuenta del hotel, como el que deja `MediosService`. */
  async function medioDelHotel(nombre: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO media_assets (tenant_id, kind, status, mime, bytes, storage_key, filename)
       VALUES ($1, 'image', 'stored', 'image/png', 1024, $2, $3) RETURNING id`,
      [tenantId, `${tenantId}/${nombre}.png`, `${nombre}.png`],
    );
    return rows[0]!.id;
  }

  let medioId: string;

  beforeAll(async () => {
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
    medioId = await medioDelHotel('pantalla');
  });

  it('el cliente manda una captura SIN texto, y el hilo la lleva', async () => {
    const r = await http
      .post('/v1/cuenta/soporte/mensajes')
      .set(auth())
      .send({ cuerpo: '', mediaAssetId: medioId })
      .expect(201);

    const ultimo = r.body[r.body.length - 1];
    expect(ultimo.medioId).toBe(medioId);
    expect(ultimo.medioMime).toBe('image/png');
    expect(ultimo.medioNombre).toBe('pantalla.png');
    // Obligar a escribir algo junto a la captura solo produce mensajes que
    // dicen «.».
    expect(ultimo.cuerpo).toBe('');
  });

  it('un mensaje sin texto NI captura sigue sin poder enviarse', async () => {
    await http.post('/v1/cuenta/soporte/mensajes').set(auth()).send({ cuerpo: '  ' }).expect(422);
  });

  it('una captura que no existe no cuela', async () => {
    const r = await http
      .post('/v1/cuenta/soporte/mensajes')
      .set(auth())
      .send({ cuerpo: 'mira', mediaAssetId: '01a00000-0000-7000-8000-00000000dead' })
      .expect(409);
    expect(r.body.codigo).toBe('adjunto_no_valido');
  });

  it('una captura a medio subir tampoco: se veria un hueco roto', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO media_assets (tenant_id, kind, status, mime, bytes, storage_key)
       VALUES ($1, 'image', 'pending', 'image/png', 10, $2) RETURNING id`,
      [tenantId, `${tenantId}/a-medias.png`],
    );
    const r = await http
      .post('/v1/cuenta/soporte/mensajes')
      .set(auth())
      .send({ cuerpo: 'mira', mediaAssetId: rows[0]!.id })
      .expect(409);
    expect(r.body.codigo).toBe('adjunto_no_valido');
  });

  it('el operador ve la captura en el hilo y obtiene una URL firmada', async () => {
    const hilo = await http
      .get(`/v1/operador/soporte/${tenantId}/mensajes`)
      .set(auth())
      .expect(200);
    const conMedio = hilo.body.find((m: { medioId: string | null }) => m.medioId === medioId);
    expect(conMedio).toBeTruthy();

    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/adjuntos/${medioId}`)
      .set(auth())
      .expect(200);
    expect(r.body.url).toContain(tenantId);
    // Vida corta: una URL de adjunto que no caduca es un adjunto publico.
    expect(r.body.expiraEnSegundos).toBeLessThanOrEqual(300);
  });

  it('el operador NO puede firmar un medio que no cuelga del hilo', async () => {
    // Un medio de la MISMA cuenta, pero de la bandeja: la foto de un huesped.
    const deLaBandeja = await medioDelHotel('foto-de-un-huesped');
    const r = await http
      .get(`/v1/operador/soporte/${tenantId}/adjuntos/${deLaBandeja}`)
      .set(auth())
      .expect(404);
    // Misma respuesta que inexistente: quien pregunta no averigua si el
    // identificador existe en otra parte.
    expect(r.body.codigo).toBe('medio_no_encontrado');
  });

  it('quien no es operador no firma nada', async () => {
    await admin.query(`UPDATE users SET is_operator = false WHERE email = 'jefe@acme.test'`);
    await http.get(`/v1/operador/soporte/${tenantId}/adjuntos/${medioId}`).set(auth()).expect(404);
    await admin.query(`UPDATE users SET is_operator = true WHERE email = 'jefe@acme.test'`);
  });
});
