/**
 * Medición de uso contra PostgreSQL real: idempotencia por clave, agregado
 * mensual en la misma transacción, aislamiento por RLS, y la precreación de
 * particiones ejecutable por el rol del worker (SECURITY DEFINER).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { poolAdmin, prepararBaseDeDatos, urlApp } from './setup.js';
import { withSystemTransaction, withTenant } from '../src/client.js';
import { etiquetaDePeriodo, inicioDePeriodo, leerUsoDelPeriodo, registrarUso } from '../src/uso.js';

const DB = 'crmapp_test_uso';
const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';

let admin: Pool;
let app: Pool;
let relay: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  await prepararBaseDeDatos(DB);
  admin = poolAdmin(DB);
  app = new Pool({ connectionString: urlApp(DB) });
  await admin.query(`ALTER ROLE crmapp_relay LOGIN PASSWORD 'crmapp_test_relay'`);
  await admin.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_relay`);
  relay = new Pool({
    connectionString: `postgres://crmapp_relay:crmapp_test_relay@${HOST}:${PORT}/${DB}`,
  });
  const t = await admin.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ('A','a'), ('B','b') RETURNING id`,
  );
  tenantA = t.rows[0]!.id;
  tenantB = t.rows[1]!.id;
});

afterAll(async () => {
  await app?.end();
  await relay?.end();
  await admin?.end();
  const su = new Client({ connectionString: poolAdmin('postgres').options.connectionString });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('registrarUso', () => {
  it('escribe evento, clave y agregado en la misma transacción', async () => {
    const ok = await withTenant(app, tenantA, (c) =>
      registrarUso(c, {
        tenantId: tenantA,
        metric: 'messages.inbound',
        dedupKey: 'message:m1:inbound',
      }),
    );
    expect(ok).toBe(true);
    const ev = await admin.query(`SELECT metric, quantity FROM usage_events WHERE tenant_id = $1`, [
      tenantA,
    ]);
    expect(ev.rows).toEqual([{ metric: 'messages.inbound', quantity: '1' }]);
    const roll = await admin.query<{ quantity: string }>(
      `SELECT quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = 'messages.inbound'`,
      [tenantA],
    );
    expect(roll.rows[0]!.quantity).toBe('1');
  });

  it('la misma clave no se cuenta dos veces', async () => {
    const otra = await withTenant(app, tenantA, (c) =>
      registrarUso(c, {
        tenantId: tenantA,
        metric: 'messages.inbound',
        dedupKey: 'message:m1:inbound',
      }),
    );
    expect(otra).toBe(false);
    const roll = await admin.query<{ quantity: string }>(
      `SELECT quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = 'messages.inbound'`,
      [tenantA],
    );
    expect(roll.rows[0]!.quantity).toBe('1');
  });

  it('las cantidades se suman en el agregado del mes y se leen con todas las métricas', async () => {
    await withTenant(app, tenantA, async (c) => {
      await registrarUso(c, {
        tenantId: tenantA,
        metric: 'media.stored_bytes',
        quantity: 1000,
        dedupKey: 'media:x:stored',
      });
      await registrarUso(c, {
        tenantId: tenantA,
        metric: 'media.stored_bytes',
        quantity: 500,
        dedupKey: 'media:y:stored',
      });
    });
    const uso = await withTenant(app, tenantA, (c) => leerUsoDelPeriodo(c, tenantA, new Date()));
    expect(uso).toMatchObject({
      'messages.inbound': 1,
      'media.stored_bytes': 1500,
      'messages.outbound': 0,
      'conversations.opened': 0,
      'templates.sent': 0,
    });
  });

  it('un evento de otro mes va a otro agregado (periodo en UTC)', async () => {
    const mesAnterior = new Date(inicioDePeriodo(new Date()).getTime() - 24 * 3_600_000);
    await withTenant(app, tenantA, (c) =>
      registrarUso(c, {
        tenantId: tenantA,
        metric: 'messages.outbound',
        dedupKey: 'message:viejo:outbound',
        occurredAt: mesAnterior,
      }),
    );
    const actual = await withTenant(app, tenantA, (c) => leerUsoDelPeriodo(c, tenantA, new Date()));
    expect(actual['messages.outbound']).toBe(0);
    const previo = await withTenant(app, tenantA, (c) =>
      leerUsoDelPeriodo(c, tenantA, mesAnterior),
    );
    expect(previo['messages.outbound']).toBe(1);
    expect(etiquetaDePeriodo(new Date('2026-09-15T23:00:00Z'))).toBe('2026-09');
  });

  it('el otro inquilino no ve nada (RLS en eventos, claves y agregados)', async () => {
    const uso = await withTenant(app, tenantB, (c) => leerUsoDelPeriodo(c, tenantB, new Date()));
    expect(uso['messages.inbound']).toBe(0);
    const n = await withTenant(app, tenantB, async (c) =>
      Promise.all([
        c.query('SELECT count(*)::int AS n FROM usage_events'),
        c.query('SELECT count(*)::int AS n FROM usage_event_keys'),
        c.query('SELECT count(*)::int AS n FROM usage_rollups'),
      ]),
    );
    expect(n.map((r) => r.rows[0].n)).toEqual([0, 0, 0]);
  });
});

describe('particiones', () => {
  it('usage_events tiene particiones alrededor de hoy, con RLS', async () => {
    const { rows } = await admin.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT c.relname, c.relrowsecurity
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'public.usage_events'::regclass`);
    const mes = etiquetaDePeriodo(new Date()).replace('-', '_');
    expect(rows.map((r) => r.relname)).toContain(`usage_events_${mes}`);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('el rol del worker (crmapp_relay) puede precrearlas: SECURITY DEFINER', async () => {
    const { rows } = await withSystemTransaction(relay, (c) =>
      c.query<{ ensure_partitions_ahead: string }>('SELECT app.ensure_partitions_ahead(4)'),
    );
    // 6 meses (−1..4) × 4 tablas.
    expect(rows).toHaveLength(24);
    expect(rows.some((r) => r.ensure_partitions_ahead.startsWith('usage_events_'))).toBe(true);
  });

  it('pero crmapp_relay no puede crear tablas por su cuenta', async () => {
    await expect(
      withSystemTransaction(relay, (c) => c.query('CREATE TABLE intrusa (id int)')),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});
