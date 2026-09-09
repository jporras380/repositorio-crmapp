/**
 * Tareas de mantenimiento (cola `maintenance`).
 *
 * Precreación de particiones: sin partición, la inserción falla y la ingesta
 * se cae (0001 no crea partición DEFAULT a propósito). Corre al arrancar el
 * worker y una vez al día; usa el pool del relay porque la función es
 * SECURITY DEFINER (0013) y ese rol tiene EXECUTE.
 */
import type { Pool } from 'pg';
import { withSystemTransaction } from '@crmapp/db';

/** Inquilino ficticio para trabajos del sistema: el tipo exige uno y el semáforo no aplica. */
export const INQUILINO_SISTEMA = '00000000-0000-0000-0000-000000000000';

/** Asegura particiones desde el mes pasado hasta `meses` por delante. Devuelve sus nombres. */
export async function precrearParticiones(poolRelay: Pool, meses = 3): Promise<string[]> {
  const { rows } = await withSystemTransaction(poolRelay, (c) =>
    c.query<{ ensure_partitions_ahead: string }>('SELECT app.ensure_partitions_ahead($1)', [meses]),
  );
  return rows.map((r) => r.ensure_partitions_ahead);
}
