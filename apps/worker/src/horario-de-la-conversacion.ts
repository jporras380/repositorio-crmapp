/**
 * El horario que rige una conversación (PR-110).
 *
 * El de su equipo si lo tiene y si no, el general. Lo usan el aviso fuera de
 * horario y los bots con horario: si cada uno eligiera por su cuenta, una
 * conversación de «Reservas» podría recibir el aviso de cerrado mientras el
 * bot la atiende como si estuviera abierto.
 *
 * El horario del equipo sustituye al general **entero**, aviso incluido: si
 * «Reservas» tiene horario propio con el aviso apagado, no se avisa aunque el
 * general lo tenga encendido. Mezclar dos filas daría un aviso que nadie
 * escribió para ese horario.
 */
import type { PoolClient } from 'pg';
import type { Horario } from '@crmapp/core';

export interface HorarioAplicable {
  timezone: string;
  schedule: Horario;
  auto_reply_enabled: boolean;
  auto_reply_text: string;
  /** `null` si es el general. */
  team_id: string | null;
}

export async function horarioDeLaConversacion(
  c: PoolClient,
  conversationId: string,
): Promise<HorarioAplicable | null> {
  const { rows } = await c.query<HorarioAplicable>(
    `SELECT h.timezone, h.schedule, h.auto_reply_enabled, h.auto_reply_text, h.team_id
       FROM conversations cv
       JOIN business_hours h ON h.team_id = cv.team_id OR h.team_id IS NULL
      WHERE cv.id = $1
      ORDER BY h.team_id NULLS LAST
      LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}
