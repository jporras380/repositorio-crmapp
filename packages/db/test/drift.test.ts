/**
 * El esquema Drizzle duplica el SQL de las migraciones. Este test es lo que
 * impide que esa duplicación se convierta en mentira.
 *
 * Compara NOMBRES de tabla y de columna, no tipos. Comparar tipos a través de
 * la frontera TS/SQL produce ruido —citext contra text, timestamptz contra
 * timestamp with time zone— sin atrapar nada que importe. Lo que sí importa,
 * y lo que este test atrapa, es la columna que se añadió en una migración y
 * nadie reflejó en el esquema, o al revés.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { poolAdmin, prepararBaseDeDatos } from './setup.js';

const DB = 'crmapp_test_drift';
import * as esquema from '../src/schema/index.js';

let admin: Pool;

beforeAll(async () => {
  await prepararBaseDeDatos(DB);
  admin = poolAdmin(DB);
});

afterAll(async () => {
  await admin?.end();
});

function tablasDeclaradas(): Map<string, Set<string>> {
  const mapa = new Map<string, Set<string>>();
  for (const valor of Object.values(esquema)) {
    // Solo los objetos que Drizzle reconoce como tabla.
    if (typeof valor !== 'object' || valor === null) continue;
    let config;
    try {
      config = getTableConfig(valor as PgTable);
    } catch {
      continue;
    }
    mapa.set(config.name, new Set(config.columns.map((c) => c.name)));
  }
  return mapa;
}

describe('deriva entre el esquema Drizzle y la base de datos', () => {
  it('toda tabla declarada existe en la base', async () => {
    const { rows } = await admin.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
    `);
    const reales = new Set(rows.map((r) => r.relname));

    const faltan = [...tablasDeclaradas().keys()].filter((t) => !reales.has(t));
    expect(faltan, 'declaradas en Drizzle pero inexistentes en la base').toEqual([]);
  });

  it('toda tabla de la base está declarada', async () => {
    // Este es el lado que de verdad se olvida: alguien añade una tabla en una
    // migración y nadie la refleja en el esquema.
    const IGNORAR = new Set(['schema_migrations']);

    const { rows } = await admin.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
    `);

    const declaradas = tablasDeclaradas();
    const sinDeclarar = rows
      .map((r) => r.relname)
      .filter((t) => !IGNORAR.has(t) && !declaradas.has(t));

    expect(sinDeclarar, 'existen en la base pero no en el esquema Drizzle').toEqual([]);
  });

  it('las columnas coinciden tabla por tabla', async () => {
    const { rows } = await admin.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
    `);

    const realesPorTabla = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!realesPorTabla.has(r.table_name)) realesPorTabla.set(r.table_name, new Set());
      realesPorTabla.get(r.table_name)!.add(r.column_name);
    }

    const problemas: string[] = [];
    for (const [tabla, columnas] of tablasDeclaradas()) {
      const reales = realesPorTabla.get(tabla);
      if (!reales) continue; // lo cubre el primer test

      for (const c of columnas) {
        if (!reales.has(c)) problemas.push(`${tabla}.${c} declarada pero no existe`);
      }
      for (const c of reales) {
        if (!columnas.has(c)) problemas.push(`${tabla}.${c} existe pero no está declarada`);
      }
    }

    expect(problemas).toEqual([]);
  });
});
