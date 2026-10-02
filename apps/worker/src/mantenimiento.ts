/**
 * Tareas de mantenimiento (cola `maintenance`).
 *
 * Precreación de particiones: sin partición, la inserción falla y la ingesta
 * se cae (0001 no crea partición DEFAULT a propósito). Corre al arrancar el
 * worker y una vez al día; usa el pool del relay porque la función es
 * SECURITY DEFINER (0013) y ese rol tiene EXECUTE.
 *
 * Barrido de esperas de Salesbot: la red de seguridad de ADR-002. Los dos
 * usan el pool del relay porque los dos necesitan mirar por encima de RLS, y
 * ese rol es el único que puede — de forma acotada y visible en el catálogo.
 */
import type { Pool } from 'pg';
import type { Almacen } from '@crmapp/storage';
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

/**
 * Esperas de Salesbot ya vencidas, de cualquier inquilino.
 *
 * Es la red de seguridad de ADR-002: si el delayed job de una espera se
 * perdió —Redis reiniciado, cola purgada—, esta consulta la encuentra. El rol
 * del relay solo puede leer cuatro columnas de `flow_runs` (migración 0015):
 * lo justo para saber a quién despertar.
 */
export async function esperasVencidas(
  poolRelay: Pool,
  limite = 50,
): Promise<{ id: string; tenantId: string }[]> {
  const { rows } = await withSystemTransaction(poolRelay, (c) =>
    c.query<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id
         FROM flow_runs
        WHERE status = 'waiting' AND wait_until IS NOT NULL AND wait_until <= now()
        ORDER BY wait_until
        LIMIT $1`,
      [limite],
    ),
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * Purga del outbox: solo lo publicado y viejo (0047).
 *
 * Devuelve cuántas borró. Si devuelve el lote entero es que quedan más, y las
 * termina la pasada de mañana: una tabla con meses de retraso no se vacía de
 * golpe bloqueando la ingesta.
 *
 * Lo que NO borra —pendientes y cartas muertas— lo decide la función de la
 * base, no esto. Aquí no hay forma de pedirle que borre otra cosa.
 */
export async function purgarOutbox(poolRelay: Pool, dias = 30): Promise<number> {
  const { rows } = await withSystemTransaction(poolRelay, (c) =>
    c.query<{ purgar_outbox: string }>('SELECT app.purgar_outbox($1)', [dias]),
  );
  return Number(rows[0]?.purgar_outbox ?? 0);
}

/**
 * Purga de las claves de idempotencia (0047).
 *
 * La política —90 días— la escribió la migración 0004, que además creó el
 * índice para aplicarla. Lo único que faltaba era esto.
 *
 * El suelo de 90 días vive en la función: bajarlo convertiría un reenvío
 * tardío de Meta en un mensaje duplicado para un huésped, y esa no es una
 * decisión que deba poder tomarse cambiando un número aquí.
 */
export async function purgarMessageKeys(poolRelay: Pool, dias = 90): Promise<number> {
  const { rows } = await withSystemTransaction(poolRelay, (c) =>
    c.query<{ purgar_message_keys: string }>('SELECT app.purgar_message_keys($1)', [dias]),
  );
  return Number(rows[0]?.purgar_message_keys ?? 0);
}

/**
 * Mensajes más viejos que el plazo que eligió cada hotel, y sus archivos
 * (0052).
 *
 * Qué se borra lo decide la función de la base —solo las cuentas que lo
 * pidieron, nunca un archivo que otra cosa use—; aquí solo se borran del
 * almacén los objetos que ella devuelve, y DESPUÉS de que su transacción
 * confirme. Al revés, una transacción fallida dejaría filas apuntando a
 * archivos que ya no existen.
 *
 * Si el almacén falla o no está configurado, quedan objetos sueltos: cuestan
 * espacio pero no rompen nada, y se dice en el resultado para que se vea.
 */
export async function purgarMensajesAntiguos(
  poolRelay: Pool,
  almacen: Almacen | null,
  lote = 5000,
): Promise<{ cuentas: number; mensajes: number; archivos: number; sinBorrar: number }> {
  const { rows } = await withSystemTransaction(poolRelay, (c) =>
    c.query<{ inquilino: string; mensajes: string; claves: string[] }>(
      'SELECT * FROM app.purgar_mensajes_antiguos($1)',
      [lote],
    ),
  );
  let archivos = 0;
  let sinBorrar = 0;
  for (const r of rows) {
    for (const clave of r.claves) {
      if (!almacen) {
        sinBorrar++;
        continue;
      }
      try {
        await almacen.borrar(clave);
        archivos++;
      } catch {
        sinBorrar++;
      }
    }
  }
  return {
    cuentas: rows.length,
    mensajes: rows.reduce((n, r) => n + Number(r.mensajes), 0),
    archivos,
    sinBorrar,
  };
}
