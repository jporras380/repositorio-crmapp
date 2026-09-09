/**
 * La precreación de particiones corre con el rol del relay, no con el dueño
 * de las tablas. Si esto pasa, el job diario puede existir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar } from '@crmapp/db';
import { precrearParticiones } from '../src/mantenimiento.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_mantenimiento';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let relay: Pool;

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();
  await migrar(url(DB));
  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_relay LOGIN PASSWORD 'crmapp_test_relay'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_relay`);
  await conf.end();
  relay = new Pool({ connectionString: url(DB, 'crmapp_relay', 'crmapp_test_relay') });
});

afterAll(async () => {
  await relay?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('precrearParticiones', () => {
  it('crea (o confirma) particiones de las cuatro tablas para los meses pedidos', async () => {
    const nombres = await precrearParticiones(relay, 5);
    // −1..5 = 7 meses × 4 tablas.
    expect(nombres).toHaveLength(28);
    for (const tabla of ['messages', 'audit_log', 'inbound_events', 'usage_events']) {
      expect(nombres.filter((n) => n.startsWith(`${tabla}_`))).toHaveLength(7);
    }
    // Idempotente: la segunda vez devuelve los mismos nombres sin fallar.
    expect(await precrearParticiones(relay, 5)).toEqual(nombres);
  });
});
