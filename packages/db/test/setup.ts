/**
 * Utilidades comunes de los tests. Trabajan contra una base de datos real.
 *
 * No se usan testcontainers: PostgreSQL ya está en el docker-compose de
 * desarrollo y en CI es un service container. Añadir una dependencia para
 * levantar lo que ya está levantado solo alarga la instalación.
 */
import { Client, Pool } from 'pg';
import { migrar } from '../src/migrate.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
// 55432 en local (ver docker-compose); en CI el service container usa 5432.
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SUPERUSER = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const SUPERPASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const APP_PASS = 'crmapp_test_app';

export const urlAdmin = (db: string) =>
  `postgres://${SUPERUSER}:${SUPERPASS}@${HOST}:${PORT}/${db}`;

/** URL del rol de aplicación: sin BYPASSRLS, sujeto a las políticas. */
export const urlApp = (db: string) => `postgres://crmapp_app:${APP_PASS}@${HOST}:${PORT}/${db}`;

/**
 * Recrea la base de datos de test desde cero y aplica las migraciones.
 *
 * Se recrea, no se limpia: un test que empieza sobre restos de otro es un test
 * que a veces pasa.
 */
export async function prepararBaseDeDatos(DB: string): Promise<void> {
  const admin = new Client({ connectionString: urlAdmin('postgres') });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  await migrar(urlAdmin(DB));

  // Credenciales del rol de aplicación. Fuera de la migración a propósito:
  // los roles son del clúster y una contraseña en una migración sería un
  // secreto en el repositorio.
  const conf = new Client({ connectionString: urlAdmin(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${APP_PASS}'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app`);
  await conf.end();
}

export function poolAdmin(db: string): Pool {
  return new Pool({ connectionString: urlAdmin(db) });
}

export function poolApp(db: string): Pool {
  return new Pool({ connectionString: urlApp(db) });
}

/** Crea un inquilino con contacto, identidad y conversación. Devuelve los ids. */
export async function sembrarInquilino(
  admin: Pool,
  nombre: string,
): Promise<{ tenantId: string; conversationId: string; channelAccountId: string }> {
  const client = await admin.connect();
  try {
    const { rows: t } = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [nombre, nombre.toLowerCase()],
    );
    const tenantId = t[0]!.id;

    const { rows: ca } = await client.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
       VALUES ($1, 'whatsapp', $2, $3) RETURNING id`,
      [tenantId, `pn_${nombre}`, `WhatsApp ${nombre}`],
    );
    const channelAccountId = ca[0]!.id;

    const { rows: c } = await client.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1, $2) RETURNING id`,
      [tenantId, `Contacto de ${nombre}`],
    );

    const { rows: ci } = await client.query<{ id: string }>(
      `INSERT INTO contact_identities
         (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1, $2, 'whatsapp', $3, $4) RETURNING id`,
      [tenantId, c[0]!.id, channelAccountId, `wa_${nombre}`],
    );

    const { rows: conv } = await client.query<{ id: string }>(
      `INSERT INTO conversations
         (tenant_id, contact_identity_id, contact_id, channel_account_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, ci[0]!.id, c[0]!.id, channelAccountId],
    );

    await client.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, channel_account_id, direction, type, body)
       VALUES ($1, $2, $3, 'inbound', 'text', $4)`,
      [tenantId, conv[0]!.id, channelAccountId, `Hola desde ${nombre}`],
    );

    return { tenantId, conversationId: conv[0]!.id, channelAccountId };
  } finally {
    client.release();
  }
}
