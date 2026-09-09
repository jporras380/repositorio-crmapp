/**
 * Runner de migraciones.
 *
 * Deliberadamente pequeño y sin generador: el esquema necesita particionado,
 * políticas RLS y funciones PL/pgSQL, que ningún generador declarativo modela
 * (ADR-001). Las migraciones son SQL escrito a mano y este runner solo las
 * aplica en orden, cada una en su transacción.
 *
 * Corre con DATABASE_MIGRATION_URL, que es un rol distinto del de la
 * aplicación: el rol de aplicación no es owner de las tablas (ADR-005).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export type Direccion = 'up' | 'down';

export interface Migracion {
  version: string;
  nombre: string;
  archivo: string;
}

/** Lee las migraciones del disco, ordenadas por versión. */
export async function listarMigraciones(direccion: Direccion): Promise<Migracion[]> {
  const archivos = await readdir(MIGRATIONS_DIR);
  const sufijo = `.${direccion}.sql`;

  const migraciones = archivos
    .filter((f) => f.endsWith(sufijo))
    .map((archivo) => {
      const base = archivo.slice(0, -sufijo.length);
      const separador = base.indexOf('_');
      return {
        version: base.slice(0, separador),
        nombre: base.slice(separador + 1),
        archivo,
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));

  return direccion === 'up' ? migraciones : migraciones.reverse();
}

async function asegurarTablaDeControl(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      nombre     text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function versionesAplicadas(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/**
 * Aplica las migraciones pendientes. Devuelve las versiones aplicadas.
 *
 * Cada migración va en su propia transacción: si la tercera falla, las dos
 * primeras quedan aplicadas y registradas. Envolverlas todas en una sola
 * transacción sería más limpio en teoría, pero en una base grande deja un
 * bloqueo abierto durante minutos.
 */
export async function migrar(
  connectionString: string,
  opciones: { hasta?: string; log?: (mensaje: string) => void } = {},
): Promise<string[]> {
  const log = opciones.log ?? (() => {});
  const client = new Client({ connectionString });
  await client.connect();
  const aplicadas: string[] = [];

  try {
    await asegurarTablaDeControl(client);
    const ya = await versionesAplicadas(client);

    for (const m of await listarMigraciones('up')) {
      if (ya.has(m.version)) continue;
      if (opciones.hasta && m.version > opciones.hasta) break;

      const sql = await readFile(join(MIGRATIONS_DIR, m.archivo), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, nombre) VALUES ($1, $2)', [
          m.version,
          m.nombre,
        ]);
        await client.query('COMMIT');
        aplicadas.push(m.version);
        log(`aplicada  ${m.version}_${m.nombre}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migración ${m.archivo} falló: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  } finally {
    await client.end();
  }

  return aplicadas;
}

/**
 * Revierte las últimas `pasos` migraciones aplicadas.
 *
 * Existe para que "migraciones reversibles siempre" sea comprobable y no una
 * declaración de intenciones: el test de migraciones aplica todo, revierte
 * todo y vuelve a aplicar.
 */
export async function revertir(
  connectionString: string,
  opciones: { pasos?: number; log?: (mensaje: string) => void } = {},
): Promise<string[]> {
  const log = opciones.log ?? (() => {});
  const pasos = opciones.pasos ?? 1;
  const client = new Client({ connectionString });
  await client.connect();
  const revertidas: string[] = [];

  try {
    await asegurarTablaDeControl(client);
    const ya = await versionesAplicadas(client);
    let restantes = pasos;

    for (const m of await listarMigraciones('down')) {
      if (restantes <= 0) break;
      if (!ya.has(m.version)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, m.archivo), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [m.version]);
        await client.query('COMMIT');
        revertidas.push(m.version);
        restantes -= 1;
        log(`revertida ${m.version}_${m.nombre}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Reversa de ${m.archivo} falló: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  } finally {
    await client.end();
  }

  return revertidas;
}
