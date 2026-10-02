/**
 * La precreación de particiones corre con el rol del relay, no con el dueño
 * de las tablas. Si esto pasa, el job diario puede existir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar, reintentandoSiChocaElCatalogo } from '@crmapp/db';
import { AlmacenEnMemoria } from '@crmapp/storage';
import { precrearParticiones, purgarMensajesAntiguos } from '../src/mantenimiento.js';

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
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_relay LOGIN PASSWORD 'crmapp_dev'`),
  );
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_relay`);
  await conf.end();
  relay = new Pool({ connectionString: url(DB, 'crmapp_relay', 'crmapp_dev') });
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

/**
 * Retención de mensajes (0052), desde el worker: la base decide qué se borra
 * y devuelve las claves; el worker borra esos objetos del almacén.
 */
describe('purgarMensajesAntiguos', () => {
  const sembrar = async (clave: string) => {
    const su = new Client({ connectionString: url(DB) });
    await su.connect();
    try {
      const t = (
        await su.query<{ id: string }>(
          `INSERT INTO tenants (name, slug, message_retention_months)
           VALUES ($1, $2, 12) RETURNING id`,
          [`ret-${clave}`, `ret-${clave}`],
        )
      ).rows[0]!.id;
      const ca = (
        await su.query<{ id: string }>(
          `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
           VALUES ($1, 'whatsapp', $2, 'WA') RETURNING id`,
          [t, `pn-${clave}`],
        )
      ).rows[0]!.id;
      const co = (
        await su.query<{ id: string }>(
          `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'Huésped') RETURNING id`,
          [t],
        )
      ).rows[0]!.id;
      const ci = (
        await su.query<{ id: string }>(
          `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id,
                                           external_user_id)
           VALUES ($1, $2, 'whatsapp', $3, $4) RETURNING id`,
          [t, co, ca, `wa-${clave}`],
        )
      ).rows[0]!.id;
      const cv = (
        await su.query<{ id: string }>(
          `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [t, ci, co, ca],
        )
      ).rows[0]!.id;
      const md = (
        await su.query<{ id: string }>(
          `INSERT INTO media_assets (tenant_id, kind, status, mime, storage_key)
           VALUES ($1, 'image', 'stored', 'image/jpeg', $2) RETURNING id`,
          [t, clave],
        )
      ).rows[0]!.id;
      await su.query(
        `SELECT app.ensure_partition('public.messages',
                                     date_trunc('month', now() - interval '18 months')::date)`,
      );
      await su.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type,
                               media_asset_id, created_at)
         VALUES ($1, $2, $3, 'inbound', 'image', $4, now() - interval '18 months')`,
        [t, cv, ca, md],
      );
    } finally {
      await su.end();
    }
  };

  it('borra del almacén el archivo que la base devuelve', async () => {
    const almacen = new AlmacenEnMemoria();
    await almacen.guardar('foto-vieja.jpg', Buffer.from('jpg'), 'image/jpeg');
    await sembrar('foto-vieja.jpg');

    const r = await purgarMensajesAntiguos(relay, almacen);
    expect(r).toEqual({ cuentas: 1, mensajes: 1, archivos: 1, sinBorrar: 0 });
    expect(await almacen.existe('foto-vieja.jpg')).toBe(false);
  });

  it('sin almacén configurado no falla: lo cuenta como sin borrar, para que se vea', async () => {
    await sembrar('otra-foto.jpg');
    const r = await purgarMensajesAntiguos(relay, null);
    expect(r).toEqual({ cuentas: 1, mensajes: 1, archivos: 0, sinBorrar: 1 });
  });
});
