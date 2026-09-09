/**
 * Descarga de medios entrantes: idempotencia ante reintentos, deduplicación
 * por sha256 dentro del inquilino y destino del fallo no reintentable. Contra
 * PostgreSQL real; el almacén es el de memoria (solo packages/storage habla
 * con MinIO).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar, withTenant } from '@crmapp/db';
import { AdaptadorSandbox } from '@crmapp/channels';
import { AlmacenEnMemoria } from '@crmapp/storage';
import { descargarMedia, type CargaDeMedia } from '../src/descargar-media.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_media';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let admin: Pool;
let app: Pool;
let tenantId: string;
let otroTenantId: string;
let channelAccountId: string;
let sandbox: AdaptadorSandbox;
let almacen: AlmacenEnMemoria;

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
  const t = await conf.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ('A','a'), ('B','b') RETURNING id`,
  );
  tenantId = t.rows[0]!.id;
  otroTenantId = t.rows[1]!.id;
  channelAccountId = (
    await conf.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name) VALUES ($1,'whatsapp','pn','WA') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });
  app = new Pool({ connectionString: url(DB, 'crmapp_app', 'crmapp_dev') });
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

beforeEach(async () => {
  sandbox = new AdaptadorSandbox({ canal: 'whatsapp' });
  almacen = new AlmacenEnMemoria();
  await admin.query(
    'TRUNCATE media_assets, outbox, usage_events, usage_event_keys, usage_rollups CASCADE',
  );
});

const deps = () => ({ pool: app, canales: new Map([['whatsapp', sandbox]]), almacen });

/** Crea el media_asset `pending` como lo hace procesar-entrante. */
async function pendiente(tenant: string, mediaId = 'media-1'): Promise<CargaDeMedia> {
  return withTenant(app, tenant, async (c) => {
    const id = (await c.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    await c.query(
      `INSERT INTO media_assets (id, tenant_id, kind, status) VALUES ($1, $2, 'image', 'pending')`,
      [id, tenant],
    );
    return { mediaAssetId: id, messageId: id, channelAccountId, canal: 'whatsapp', mediaId };
  });
}

const fila = async (id: string) =>
  (
    await admin.query<{
      status: string;
      storage_key: string | null;
      sha256: string | null;
      bytes: string | null;
    }>(`SELECT status, storage_key, sha256, bytes FROM media_assets WHERE id = $1`, [id])
  ).rows[0]!;

describe('descarga', () => {
  it('guarda en el almacén bajo la clave del inquilino y marca stored', async () => {
    const carga = await pendiente(tenantId);
    expect(await descargarMedia(deps(), tenantId, carga)).toBe('guardado');

    const m = await fila(carga.mediaAssetId);
    expect(m.status).toBe('stored');
    expect(m.storage_key).toBe(`tenants/${tenantId}/media/${carga.mediaAssetId}.bin`);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(almacen.objetos.has(m.storage_key!)).toBe(true);

    const { rows } = await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox`);
    expect(rows.map((r) => r.event_type)).toEqual(['media.lista']);
  });

  it('el reintento de un medio ya guardado es un no-op', async () => {
    const carga = await pendiente(tenantId);
    await descargarMedia(deps(), tenantId, carga);
    expect(await descargarMedia(deps(), tenantId, carga)).toBe('ya_procesado');
    expect(almacen.objetos.size).toBe(1);
  });

  it('deduplica por contenido dentro del inquilino, no entre inquilinos', async () => {
    // El sandbox genera los mismos bytes para el mismo mediaId.
    const a = await pendiente(tenantId, 'catalogo');
    const b = await pendiente(tenantId, 'catalogo');
    expect(await descargarMedia(deps(), tenantId, a)).toBe('guardado');
    expect(await descargarMedia(deps(), tenantId, b)).toBe('reutilizado');
    expect((await fila(b.mediaAssetId)).storage_key).toBe((await fila(a.mediaAssetId)).storage_key);
    expect(almacen.objetos.size).toBe(1);
    // Medición: los bytes reutilizados no se cuentan dos veces.
    const bytes = await admin.query<{ quantity: string }>(
      `SELECT quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = 'media.stored_bytes'`,
      [tenantId],
    );
    expect(Number(bytes.rows[0]!.quantity)).toBe(Number((await fila(a.mediaAssetId)).bytes));

    // Otro inquilino con bytes idénticos: copia propia. Compartir claves entre
    // inquilinos haría que el borrado por prefijo de uno rompiera al otro.
    const ajeno = await pendiente(otroTenantId, 'catalogo');
    expect(await descargarMedia(deps(), otroTenantId, ajeno)).toBe('guardado');
    expect(almacen.objetos.size).toBe(2);
  });

  it('fallo no reintentable del proveedor → failed, sin tocar el almacén', async () => {
    const carga = await pendiente(tenantId);
    sandbox.programarFallo({ tipo: 'rechazado_por_proveedor', reintentable: false });
    expect(await descargarMedia(deps(), tenantId, carga)).toBe('fallido');
    expect((await fila(carga.mediaAssetId)).status).toBe('failed');
    expect(almacen.objetos.size).toBe(0);
  });

  it('fallo reintentable del proveedor → lanza y deja pending para que BullMQ reintente', async () => {
    const carga = await pendiente(tenantId);
    sandbox.programarFallo({ tipo: 'proveedor_no_disponible', reintentable: true });
    await expect(descargarMedia(deps(), tenantId, carga)).rejects.toThrow();
    expect((await fila(carga.mediaAssetId)).status).toBe('pending');
  });

  it('un medio de otro inquilino no existe desde este (RLS)', async () => {
    const ajeno = await pendiente(otroTenantId);
    await expect(descargarMedia(deps(), tenantId, ajeno)).rejects.toThrow(/no existe/);
  });
});
