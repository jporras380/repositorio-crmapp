/**
 * Reparto automático de conversaciones (0026).
 *
 * Se llama en la transacción del entrante que abre o reabre una conversación.
 * Si la cuenta tiene el reparto apagado, no hace nada. Si está en
 * `least_busy`, asigna al miembro activo que acepta asignaciones y tiene
 * menos conversaciones abiertas; con empate, al azar.
 *
 * Una conversación que ya tiene responsable activo y en el reparto lo
 * conserva: quien atendió a esta persona la última vez es quien mejor la
 * conoce. Solo se reasigna si ese responsable ya no está (desactivado o fuera
 * del reparto).
 */
import type { PoolClient } from 'pg';

export async function repartirSiToca(
  c: PoolClient,
  conversationId: string,
): Promise<string | null> {
  const modo = await c.query<{ auto_assignment: string }>(
    `SELECT auto_assignment FROM tenants WHERE id = app.current_tenant_id()`,
  );
  if (modo.rows[0]?.auto_assignment !== 'least_busy') return null;

  const actual = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM conversations cv
         JOIN memberships m ON m.user_id = cv.assignee_user_id
        WHERE cv.id = $1 AND m.status = 'active' AND m.accepts_assignments
     ) AS ok`,
    [conversationId],
  );
  if (actual.rows[0]?.ok) return null;

  const elegido = await c.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM memberships m
      WHERE m.status = 'active' AND m.accepts_assignments
      ORDER BY (SELECT count(*) FROM conversations cv
                 WHERE cv.assignee_user_id = m.user_id AND cv.status <> 'closed'),
               random()
      LIMIT 1`,
  );
  const userId = elegido.rows[0]?.user_id;
  if (!userId) return null; // nadie en el reparto: se queda sin asignar, como antes

  await c.query(
    `UPDATE conversations SET assignee_user_id = $2, updated_at = now() WHERE id = $1`,
    [conversationId, userId],
  );
  // El lead abierto de esa conversación, si nadie lo lleva, va con ella: la
  // persona que atiende el chat es la que va a cerrar la reserva.
  await c.query(
    `UPDATE leads SET assignee_user_id = $2, updated_at = now()
      WHERE conversation_id = $1 AND status = 'abierto' AND assignee_user_id IS NULL`,
    [conversationId, userId],
  );
  return userId;
}
