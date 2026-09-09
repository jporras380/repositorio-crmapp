/**
 * "Migraciones reversibles siempre" (regla 10) sale caro de comprobar a mano y
 * por eso normalmente no se comprueba. Aquí se aplica todo, se revierte todo y
 * se vuelve a aplicar: si una reversa está mal escrita, esto falla.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { listarMigraciones, migrar, revertir } from '../src/migrate.js';
import { urlAdmin } from './setup.js';

const DB = 'crmapp_test_migrations';
const url = urlAdmin(DB);

beforeAll(async () => {
  const admin = new Client({ connectionString: urlAdmin('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
});

afterAll(async () => {
  const admin = new Client({ connectionString: urlAdmin('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

async function tablasPublicas(): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query<{ relname: string }>(`
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     ORDER BY 1
  `);
  await client.end();
  return rows.map((r) => r.relname);
}

describe('migraciones', () => {
  it('cada .up.sql tiene su .down.sql', async () => {
    const arriba = (await listarMigraciones('up')).map((m) => m.version).sort();
    const abajo = (await listarMigraciones('down')).map((m) => m.version).sort();
    expect(abajo).toEqual(arriba);
  });

  it('aplica, revierte del todo y vuelve a aplicar', async () => {
    const aplicadas = await migrar(url);
    expect(aplicadas.length).toBeGreaterThan(0);

    const despuesDeSubir = await tablasPublicas();
    expect(despuesDeSubir).toContain('conversations');
    expect(despuesDeSubir).toContain('messages');
    expect(despuesDeSubir).toContain('message_keys');
    expect(despuesDeSubir).toContain('outbox');

    // Reversa completa.
    const revertidas = await revertir(url, { pasos: aplicadas.length });
    expect(revertidas.length).toBe(aplicadas.length);

    const despuesDeBajar = await tablasPublicas();
    // Solo queda la tabla de control del propio runner.
    expect(despuesDeBajar).toEqual(['schema_migrations']);

    // Y vuelve a subir sobre una base ya usada, que es el caso real de un
    // rollback en producción seguido de un redespliegue.
    const reaplicadas = await migrar(url);
    expect(reaplicadas.length).toBe(aplicadas.length);
    expect(await tablasPublicas()).toEqual(despuesDeSubir);
  });

  it('crea particiones desde el mes anterior y hacia delante', async () => {
    // Desde el mes anterior a propósito: un reproceso de eventos atrasados no
    // puede estrellarse contra una partición inexistente.
    const client = new Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ n: number }>(`
      SELECT count(*)::int AS n
        FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'messages'
    `);
    await client.end();
    // Mes anterior + actual + 3 por delante.
    expect(rows[0]!.n).toBe(5);
  });

  it('no hay partición DEFAULT', async () => {
    // Una DEFAULT que acumule filas impide crear después la partición del
    // rango correspondiente, y convierte un despiste del job en una migración
    // manual. Preferimos que falle ruidoso.
    const client = new Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_class c
       WHERE c.relispartition
         AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
    `);
    await client.end();
    expect(rows[0]!.n).toBe(0);
  });
});

describe('idempotencia (ADR-006)', () => {
  it('message_keys impide el duplicado, y no está particionada', async () => {
    const client = new Client({ connectionString: url });
    await client.connect();

    const { rows: p } = await client.query<{ particionada: boolean }>(`
      SELECT (relkind = 'p') AS particionada FROM pg_class WHERE relname = 'message_keys'
    `);
    // Si estuviera particionada, la unicidad quedaría confinada a cada
    // partición y un reenvío a caballo de fin de mes se duplicaría.
    expect(p[0]!.particionada).toBe(false);

    const { rows: t } = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Idem', 'idem') RETURNING id`,
    );
    const { rows: ca } = await client.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
       VALUES ($1, 'whatsapp', 'pn_idem', 'Idem') RETURNING id`,
      [t[0]!.id],
    );

    const insertar = () =>
      client.query(
        `INSERT INTO message_keys
           (tenant_id, channel_account_id, external_message_id, message_id, message_created_at)
         VALUES ($1, $2, 'wamid.REPETIDO', gen_random_uuid(), now())`,
        [t[0]!.id, ca[0]!.id],
      );

    await insertar();
    await expect(insertar()).rejects.toThrow(/duplicate key/i);

    await client.end();
  });
});
