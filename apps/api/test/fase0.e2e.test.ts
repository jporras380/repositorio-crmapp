/**
 * Criterio de salida de la fase 0: **crear cuenta e invitar usuario**.
 *
 * Este archivo ES la evidencia de ese criterio. Va por HTTP real contra
 * PostgreSQL real, sin dobles de prueba, porque lo que hay que demostrar
 * —que RLS aísla, que el alta es atómica, que la invitación viaja por el
 * outbox— no existe fuera de la base.
 */
import 'reflect-metadata';
import { codigoTotp } from '@crmapp/core';
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
const DB = 'crmapp_test_api';
const CLAVE_APP = 'crmapp_dev';
const CLAVE_AUTH = 'crmapp_dev';
const JWT = 'secreto-de-test-de-al-menos-treinta-y-dos-caracteres';

const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let app: INestApplication;
let admin: Pool;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();

  await migrar(url(DB));

  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${CLAVE_APP}'`);
  await conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD '${CLAVE_AUTH}'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_auth`);
  await conf.end();

  admin = new Pool({ connectionString: url(DB) });

  // La API corre con el rol de aplicación, que NO es superusuario ni dueño de
  // las tablas. Si corriera como superusuario, RLS se saltaría entera y estos
  // tests no probarían el aislamiento.
  app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: url(DB, 'crmapp_app', CLAVE_APP),
      authDatabaseUrl: url(DB, 'crmapp_auth', CLAVE_AUTH),
      jwtSecret: JWT,
      masterKey: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
    }),
    { logger: false },
  );
  // Con onError: un 500 silencioso en un test es un test que no sirve para
  // diagnosticar nada.
  app.useGlobalFilters(
    new FiltroDeErrores((e) => console.error('ERROR NO CONTROLADO:', (e as Error).message)),
  );
  await app.init();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

const alta = (slug: string, email: string) => ({
  nombreDeCuenta: `Cuenta ${slug}`,
  slug,
  email,
  contrasena: 'contrasena-muy-larga',
  nombreCompleto: 'Persona Titular',
});

describe('criterio de salida de fase 0', () => {
  let tokenPropietario: string;
  let tenantId: string;

  it('crear cuenta devuelve sesión y deja la suscripción en prueba', async () => {
    const r = await http.post('/v1/cuentas').send(alta('acme', 'titular@acme.test')).expect(201);

    expect(r.body.token).toBeTruthy();
    expect(r.body.rol).toBe('owner');
    tokenPropietario = r.body.token;
    tenantId = r.body.tenantId;

    // La suscripción se crea en el alta, no en un job posterior: sin fechas,
    // @crmapp/core considera la cuenta suspendida, así que una cuenta nueva
    // nacería sin poder enviar nada.
    const { rows } = await admin.query<{ status: string; trial_ends_at: Date }>(
      `SELECT status, trial_ends_at FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows[0]!.status).toBe('trialing');

    const dias = (rows[0]!.trial_ends_at.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(27);
    expect(dias).toBeLessThan(32);
  });

  it('el alta emite un evento en el outbox, en la misma transacción', async () => {
    const { rows } = await admin.query<{ event_type: string }>(
      `SELECT event_type FROM outbox WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.map((r) => r.event_type)).toContain('cuenta.creada');
  });

  it('/v1/yo informa del estado efectivo de la suscripción', async () => {
    const r = await http
      .get('/v1/yo')
      .set('Authorization', `Bearer ${tokenPropietario}`)
      .expect(200);

    expect(r.body.tenantId).toBe(tenantId);
    expect(r.body.suscripcion).toBe('prueba');
  });

  it('invitar a un usuario y que lo acepte', async () => {
    const inv = await http
      .post('/v1/invitaciones')
      .set('Authorization', `Bearer ${tokenPropietario}`)
      .send({ email: 'agente@acme.test', rol: 'agent' })
      .expect(201);

    expect(inv.body.token).toBeTruthy();

    // En la base solo queda el hash: quien lea la tabla no debe poder aceptar
    // invitaciones ajenas.
    const { rows } = await admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM invitations WHERE id = $1`,
      [inv.body.id],
    );
    expect(rows[0]!.token_hash).not.toBe(inv.body.token);

    const aceptada = await http
      .post('/v1/invitaciones/aceptar')
      .send({
        token: inv.body.token,
        contrasena: 'otra-contrasena-larga',
        nombreCompleto: 'Agente Nuevo',
      })
      .expect(200);

    expect(aceptada.body.rol).toBe('agent');
    expect(aceptada.body.tenantId).toBe(tenantId);
  });

  it('el invitado puede iniciar sesión', async () => {
    const r = await http
      .post('/v1/sesiones')
      .send({ email: 'agente@acme.test', contrasena: 'otra-contrasena-larga' })
      .expect(200);
    expect(r.body.rol).toBe('agent');
  });
});

describe('aislamiento entre cuentas', () => {
  it('el token de una cuenta no ve la otra', async () => {
    const a = await http.post('/v1/cuentas').send(alta('alfa', 'a@alfa.test')).expect(201);
    const b = await http.post('/v1/cuentas').send(alta('beta', 'b@beta.test')).expect(201);

    const yoA = await http.get('/v1/yo').set('Authorization', `Bearer ${a.body.token}`).expect(200);

    expect(yoA.body.tenantId).toBe(a.body.tenantId);
    expect(yoA.body.tenantId).not.toBe(b.body.tenantId);
  });
});

describe('validación y errores', () => {
  it('rechaza un slug con mayúsculas y dice por qué', async () => {
    const r = await http
      .post('/v1/cuentas')
      .send({ ...alta('MAYUSCULAS', 'x@x.test'), slug: 'MAYUSCULAS' })
      .expect(400);
    expect(r.body.codigo).toBe('datos_invalidos');
    expect(r.body.mensaje).toMatch(/slug/);
  });

  it('rechaza contraseñas cortas', async () => {
    await http
      .post('/v1/cuentas')
      .send({ ...alta('corta', 'corta@x.test'), contrasena: 'corta' })
      .expect(400);
  });

  it('un slug repetido da 409, no un 500 con detalles de PostgreSQL', async () => {
    // Un mensaje de la base devuelto tal cual filtra nombres de tabla y de
    // restricción.
    await http.post('/v1/cuentas').send(alta('repetida', 'uno@rep.test')).expect(201);
    const r = await http.post('/v1/cuentas').send(alta('repetida', 'dos@rep.test')).expect(409);
    expect(r.body.codigo).toBe('slug_ocupado');
    expect(JSON.stringify(r.body)).not.toMatch(/tenants_slug|duplicate key|pg/i);
  });

  it('sin cabecera Authorization no se entra', async () => {
    const r = await http.get('/v1/yo').expect(401);
    expect(r.body.codigo).toBe('sin_sesion');
  });

  it('un token manipulado no se acepta', async () => {
    const bueno = await http.post('/v1/cuentas').send(alta('firma', 'f@f.test')).expect(201);
    const roto = bueno.body.token.slice(0, -3) + 'aaa';
    await http.get('/v1/yo').set('Authorization', `Bearer ${roto}`).expect(401);
  });

  it('credenciales incorrectas no distinguen entre correo inexistente y contraseña mala', async () => {
    // Mensajes distintos permiten enumerar qué correos están registrados.
    const inexistente = await http
      .post('/v1/sesiones')
      .send({ email: 'nadie@ninguna.test', contrasena: 'lo-que-sea-largo' })
      .expect(401);
    const malaContrasena = await http
      .post('/v1/sesiones')
      .send({ email: 'titular@acme.test', contrasena: 'incorrecta-larga' })
      .expect(401);

    expect(inexistente.body).toEqual(malaContrasena.body);
  });
});

describe('permisos e invitaciones', () => {
  let tokenAgente: string;

  beforeAll(async () => {
    const cuenta = await http
      .post('/v1/cuentas')
      .send(alta('permisos', 'own@perm.test'))
      .expect(201);
    const inv = await http
      .post('/v1/invitaciones')
      .set('Authorization', `Bearer ${cuenta.body.token}`)
      .send({ email: 'ag@perm.test', rol: 'agent' })
      .expect(201);
    const aceptada = await http
      .post('/v1/invitaciones/aceptar')
      .send({ token: inv.body.token, contrasena: 'agente-contrasena', nombreCompleto: 'Ag' })
      .expect(200);
    tokenAgente = aceptada.body.token;
  });

  it('un agente no puede invitar', async () => {
    const r = await http
      .post('/v1/invitaciones')
      .set('Authorization', `Bearer ${tokenAgente}`)
      .send({ email: 'otro@perm.test', rol: 'agent' })
      .expect(403);
    expect(r.body.codigo).toBe('sin_permiso');
  });

  it('una invitación no se puede usar dos veces', async () => {
    const cuenta = await http.post('/v1/cuentas').send(alta('doble', 'own@doble.test')).expect(201);
    const inv = await http
      .post('/v1/invitaciones')
      .set('Authorization', `Bearer ${cuenta.body.token}`)
      .send({ email: 'dos@doble.test', rol: 'supervisor' })
      .expect(201);

    const cuerpo = {
      token: inv.body.token,
      contrasena: 'contrasena-larga-2',
      nombreCompleto: 'Dos',
    };
    await http.post('/v1/invitaciones/aceptar').send(cuerpo).expect(200);
    const segunda = await http.post('/v1/invitaciones/aceptar').send(cuerpo).expect(409);
    expect(segunda.body.codigo).toBe('invitacion_usada');
  });

  it('un token de invitación inventado no sirve', async () => {
    await http
      .post('/v1/invitaciones/aceptar')
      .send({
        token: 'inventado-completamente-de-la-nada',
        contrasena: 'contrasena-larga-3',
        nombreCompleto: 'Nadie',
      })
      .expect(404);
  });
});

describe('auditoría', () => {
  it('el alta y la invitación quedan registradas', async () => {
    const { rows } = await admin.query<{ action: string }>(`SELECT DISTINCT action FROM audit_log`);
    const acciones = rows.map((r) => r.action);
    expect(acciones).toContain('cuenta.creada');
    expect(acciones).toContain('invitacion.creada');
    expect(acciones).toContain('invitacion.aceptada');
  });
});

describe('sesiones que se pueden cerrar (0033)', () => {
  const CUENTA = alta('sesiones', 'duena@sesiones.test');

  beforeAll(async () => {
    await http.post('/v1/cuentas').send(CUENTA).expect(201);
  });

  /**
   * Los nombres van sin acentos a propósito: una cabecera HTTP no es UTF-8, y
   * un `user-agent` con tildes llega mangleado. Los navegadores reales mandan
   * ASCII, así que el caso no existe fuera del test.
   */
  const entrar = async (agente: string) => {
    const r = await http
      .post('/v1/sesiones')
      .set('user-agent', agente)
      .set('x-forwarded-for', '190.12.3.4, 10.0.0.1')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena })
      .expect(200);
    return r.body.token as string;
  };

  const cabecera = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('cada inicio de sesión queda listado, con su IP y su dispositivo', async () => {
    const t = await entrar('Firefox en Android');
    const r = await http.get('/v1/sesiones').set(cabecera(t)).expect(200);
    const actual = (r.body as { esLaActual: boolean; ip: string; dispositivo: string }[]).find(
      (s) => s.esLaActual,
    );
    // De `x-forwarded-for` se queda la primera: el cliente. El resto son proxies.
    expect(actual?.ip).toBe('190.12.3.4');
    expect(actual?.dispositivo).toBe('Firefox en Android');
  });

  it('cerrar una sesión deja su token SIN valor, aunque la firma siga siendo buena', async () => {
    const viejo = await entrar('PC de recepcion');
    const nuevo = await entrar('Mi portátil');

    const lista = await http.get('/v1/sesiones').set(cabecera(nuevo));
    const otra = (lista.body as { id: string; dispositivo: string }[]).find(
      (s) => s.dispositivo === 'PC de recepcion',
    )!;
    await http.delete(`/v1/sesiones/${otra.id}`).set(cabecera(nuevo)).expect(200);

    // Esto es lo que antes era imposible: el token sigue firmado y ya no sirve.
    const r = await http.get('/v1/yo').set(cabecera(viejo)).expect(401);
    expect(r.body.codigo).toBe('sesion_cerrada');
    await http.get('/v1/yo').set(cabecera(nuevo)).expect(200);
  });

  it('«cerrar las otras» no se cierra a sí misma', async () => {
    await entrar('Uno');
    await entrar('Dos');
    const mia = await entrar('La mia');

    const r = await http.delete('/v1/sesiones/otras').set(cabecera(mia)).expect(200);
    expect(r.body.cerradas).toBeGreaterThanOrEqual(2);

    await http.get('/v1/yo').set(cabecera(mia)).expect(200);
    expect(await http.get('/v1/sesiones').set(cabecera(mia))).toMatchObject({
      body: expect.objectContaining({ length: 1 }),
    });
  });
});

describe('perfil de quien ha entrado (0034)', () => {
  const CUENTA = alta('perfiles', 'duena@perfiles.test');
  let token: string;

  const cabecera = (t = token) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const r = await http.post('/v1/cuentas').send(CUENTA).expect(201);
    token = r.body.token;
  });

  it('devuelve lo que se puede cambiar de uno mismo', async () => {
    const r = await http.get('/v1/perfil').set(cabecera()).expect(200);
    expect(r.body).toMatchObject({
      nombre: 'Persona Titular',
      email: CUENTA.email,
      fotoId: null,
      dobleFactor: false,
    });
  });

  it('el nombre se cambia sin pedir nada más: no es una llave', async () => {
    await http.patch('/v1/perfil').set(cabecera()).send({ nombre: 'Rosa Jefa' }).expect(204);
    expect((await http.get('/v1/perfil').set(cabecera())).body.nombre).toBe('Rosa Jefa');
  });

  it('una foto que no existe no se guarda en silencio', async () => {
    const r = await http
      .patch('/v1/perfil')
      .set(cabecera())
      .send({ fotoId: '01a00000-0000-7000-8000-000000000000' })
      .expect(404);
    expect(r.body.codigo).toBe('medio_no_encontrado');
  });

  it('cambiar el correo exige la contraseña de ahora', async () => {
    await http
      .post('/v1/perfil/acceso')
      .set(cabecera())
      .send({ contrasenaActual: 'me-la-invento', email: 'otra@perfiles.test' })
      .expect(403);

    await http
      .post('/v1/perfil/acceso')
      .set(cabecera())
      .send({ contrasenaActual: CUENTA.contrasena, email: 'otra@perfiles.test' })
      .expect(200);
    expect((await http.get('/v1/perfil').set(cabecera())).body.email).toBe('otra@perfiles.test');
  });

  it('cambiar la contraseña CIERRA las demás sesiones, que es lo que se espera', async () => {
    // Una segunda sesión, como la del ordenador de recepción que se quedó abierta.
    const otra = (
      await http
        .post('/v1/sesiones')
        .send({ email: 'otra@perfiles.test', contrasena: CUENTA.contrasena })
        .expect(200)
    ).body.token as string;
    await http.get('/v1/yo').set(cabecera(otra)).expect(200);

    const r = await http
      .post('/v1/perfil/acceso')
      .set(cabecera())
      .send({ contrasenaActual: CUENTA.contrasena, contrasenaNueva: 'una-contrasena-nueva-larga' })
      .expect(200);
    expect(r.body.sesionesCerradas).toBeGreaterThanOrEqual(1);

    // La otra queda fuera; la que hizo el cambio sigue dentro.
    expect((await http.get('/v1/yo').set(cabecera(otra)).expect(401)).body.codigo).toBe(
      'sesion_cerrada',
    );
    await http.get('/v1/yo').set(cabecera()).expect(200);

    // Y la contraseña nueva es la que vale.
    await http
      .post('/v1/sesiones')
      .send({ email: 'otra@perfiles.test', contrasena: 'una-contrasena-nueva-larga' })
      .expect(200);
  });

  it('un correo ya usado por otra cuenta se rechaza con su motivo', async () => {
    const r = await http
      .post('/v1/perfil/acceso')
      .set(cabecera())
      .send({ contrasenaActual: 'una-contrasena-nueva-larga', email: 'duena@sesiones.test' })
      .expect(409);
    expect(r.body.codigo).toBe('email_en_uso');
  });
});

describe('verificación en dos pasos (0035)', () => {
  const CUENTA = alta('dospasos', 'duena@dospasos.test');
  let token: string;
  let secreto: string;
  let recuperacion: string[];

  const cabecera = (t = token) => ({ Authorization: `Bearer ${t}` });
  /** El código de AHORA, igual que lo daría el móvil. */
  const codigoAhora = () => codigoTotp(secreto, new Date());

  beforeAll(async () => {
    const r = await http.post('/v1/cuentas').send(CUENTA).expect(201);
    token = r.body.token;
  });

  it('preparar da un secreto y un enlace, pero NO lo activa todavía', async () => {
    const r = await http.post('/v1/perfil/dos-pasos').set(cabecera()).expect(200);
    secreto = r.body.secreto;
    expect(r.body.enlace.startsWith('otpauth://totp/')).toBe(true);

    // Sin confirmar no protege nada: entrar sigue funcionando sin código.
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena })
      .expect(200);
    expect((await http.get('/v1/perfil').set(cabecera())).body.dobleFactor).toBe(false);
  });

  it('un código inventado no lo activa', async () => {
    const r = await http
      .post('/v1/perfil/dos-pasos/confirmar')
      .set(cabecera())
      .send({ codigo: '000000' })
      .expect(403);
    expect(r.body.codigo).toBe('codigo_invalido');
  });

  it('con el código del autenticador se activa y entrega los de recuperación', async () => {
    const r = await http
      .post('/v1/perfil/dos-pasos/confirmar')
      .set(cabecera())
      .send({ codigo: codigoAhora() })
      .expect(200);
    recuperacion = r.body.codigosDeRecuperacion;
    // Ocho, porque un móvil se pierde más de una vez en la vida de una cuenta.
    expect(recuperacion).toHaveLength(8);
    expect((await http.get('/v1/perfil').set(cabecera())).body.dobleFactor).toBe(true);
  });

  it('a partir de ahí, la contraseña sola NO entra', async () => {
    const r = await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena })
      .expect(401);
    expect(r.body.codigo).toBe('codigo_requerido');
  });

  it('con el código del móvil entra', async () => {
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena, codigo: codigoAhora() })
      .expect(200);
  });

  it('un código de recuperación entra UNA vez y luego ya no', async () => {
    const uno = recuperacion[0]!;
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena, codigo: uno })
      .expect(200);

    // Quien lo apuntó en un papel y lo perdió no deja una llave viva.
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena, codigo: uno })
      .expect(403);
  });

  it('el código sin la contraseña buena tampoco entra', async () => {
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: 'me-la-invento', codigo: codigoAhora() })
      .expect(401);
  });

  it('quitarlo exige la contraseña: una sesión olvidada no lo desactiva', async () => {
    await http
      .delete('/v1/perfil/dos-pasos')
      .set(cabecera())
      .send({ contrasenaActual: 'me-la-invento' })
      .expect(403);

    await http
      .delete('/v1/perfil/dos-pasos')
      .set(cabecera())
      .send({ contrasenaActual: CUENTA.contrasena })
      .expect(204);

    // Y se vuelve a entrar solo con contraseña.
    await http
      .post('/v1/sesiones')
      .send({ email: CUENTA.email, contrasena: CUENTA.contrasena })
      .expect(200);
  });
});
