/**
 * Secretos de canal: ida y vuelta cifrada, y los resolvers que usan el rol de
 * solo lectura para cruzar inquilinos.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { Cifrador, generarClaveMaestra, parsearClaveMaestra } from '@crmapp/crypto';
import { withTenant } from '../src/client.js';
import {
  CanalNoConectado,
  crearResolverDeCredencialesWhatsapp,
  crearResolverDeCuenta,
  guardarSecretoDeCanal,
  leerSecretoDeCanal,
} from '../src/secretos.js';
import { poolAdmin, prepararBaseDeDatos, urlAdmin } from './setup.js';

const DB = 'crmapp_test_secretos';
const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';

let admin: Pool;
let app: Pool;
let auth: Pool;
let tenantId: string;
let cuentaId: string;
const cifrador = new Cifrador({
  versionActual: 1,
  claves: { 1: parsearClaveMaestra(generarClaveMaestra()) },
});

beforeAll(async () => {
  await prepararBaseDeDatos(DB);
  admin = poolAdmin(DB);
  const conf = new Client({ connectionString: urlAdmin(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_auth LOGIN PASSWORD 'crmapp_test_auth'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_auth`);
  tenantId = (
    await conf.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('S','s') RETURNING id`,
    )
  ).rows[0]!.id;
  cuentaId = (
    await conf.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, provider_account_id, display_name, status)
       VALUES ($1,'whatsapp','PN1','WABA1','WA','connected') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  await conf.end();
  app = new Pool({
    connectionString: `postgres://crmapp_app:crmapp_test_app@${HOST}:${PORT}/${DB}`,
  });
  auth = new Pool({
    connectionString: `postgres://crmapp_auth:crmapp_test_auth@${HOST}:${PORT}/${DB}`,
  });
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end(), auth?.end()]);
});

describe('guardar y leer', () => {
  it('ida y vuelta, cifrado en reposo', async () => {
    await withTenant(app, tenantId, (c) =>
      guardarSecretoDeCanal(c, cifrador, {
        tenantId,
        channelAccountId: cuentaId,
        kind: 'access_token',
        valor: 'EAAG-secreto',
      }),
    );
    const leido = await withTenant(app, tenantId, (c) =>
      leerSecretoDeCanal(c, cifrador, cuentaId, 'access_token'),
    );
    expect(leido).toBe('EAAG-secreto');
    const { rows } = await admin.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM channel_secrets WHERE channel_account_id = $1`,
      [cuentaId],
    );
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain('EAAG');
  });

  it('volver a guardar reemplaza y rota', async () => {
    await withTenant(app, tenantId, (c) =>
      guardarSecretoDeCanal(c, cifrador, {
        tenantId,
        channelAccountId: cuentaId,
        kind: 'access_token',
        valor: 'EAAG-nuevo',
      }),
    );
    expect(
      await withTenant(app, tenantId, (c) =>
        leerSecretoDeCanal(c, cifrador, cuentaId, 'access_token'),
      ),
    ).toBe('EAAG-nuevo');
    const { rows } = await admin.query<{ n: number; rotado: boolean }>(
      `SELECT count(*)::int AS n, bool_and(rotated_at IS NOT NULL) AS rotado FROM channel_secrets WHERE channel_account_id = $1 AND kind = 'access_token'`,
      [cuentaId],
    );
    expect(rows[0]).toEqual({ n: 1, rotado: true });
  });

  it('otra clave maestra no lee el secreto', async () => {
    const otro = new Cifrador({
      versionActual: 1,
      claves: { 1: parsearClaveMaestra(generarClaveMaestra()) },
    });
    await expect(
      withTenant(app, tenantId, (c) => leerSecretoDeCanal(c, otro, cuentaId, 'access_token')),
    ).rejects.toThrow();
  });
});

describe('resolvers con el rol de solo lectura', () => {
  it('resuelven cuenta y credenciales sin inquilino', async () => {
    await withTenant(app, tenantId, (c) =>
      guardarSecretoDeCanal(c, cifrador, {
        tenantId,
        channelAccountId: cuentaId,
        kind: 'app_secret',
        valor: 'el-app-secret',
      }),
    );
    const cuenta = await crearResolverDeCuenta(auth, cifrador)('whatsapp', 'PN1');
    expect(cuenta).toEqual({ channelAccountId: cuentaId, tenantId, secreto: 'el-app-secret' });
    const cred = await crearResolverDeCredencialesWhatsapp(auth, cifrador)(cuentaId);
    expect(cred).toEqual({ phoneNumberId: 'PN1', wabaId: 'WABA1', accessToken: 'EAAG-nuevo' });
  });

  it('el pool de aplicación NO sirve para resolver: RLS no deja ver nada', async () => {
    // Es el motivo de que exista crmapp_auth. Con el pool de aplicación y sin
    // inquilino, la consulta devuelve cero filas y el resolver dice null.
    expect(await crearResolverDeCuenta(app, cifrador)('whatsapp', 'PN1')).toBeNull();
  });

  it('cuenta desconocida → null; desconectada → CanalNoConectado', async () => {
    expect(await crearResolverDeCuenta(auth, cifrador)('whatsapp', 'NADIE')).toBeNull();
    await admin.query(`UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`, [
      cuentaId,
    ]);
    await expect(
      crearResolverDeCredencialesWhatsapp(auth, cifrador)(cuentaId),
    ).rejects.toBeInstanceOf(CanalNoConectado);
    expect(await crearResolverDeCuenta(auth, cifrador)('whatsapp', 'PN1')).toBeNull();
  });
});
