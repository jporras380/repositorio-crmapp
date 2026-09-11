/**
 * De conversación entrante a lead (migración 0018).
 *
 * La columna «Leads entrantes» de un CRM de ventas no se llena a mano: se
 * llena sola con lo que entra por los canales. Esto es lo que la llena.
 *
 * ## Cuándo se abre un lead, y cuándo NO
 *
 * Se abre cuando entra una conversación **nueva o reabierta** y ese contacto
 * no tiene ya un lead abierto en el embudo por defecto. Es la misma regla de
 * Kommo y responde al caso que manda en un negocio de repuestos: el mismo
 * número vuelve a escribir a los tres meses y eso es una venta distinta, no
 * la de marzo otra vez.
 *
 * Si ya hay uno abierto, no se crea nada — solo se le engancha la
 * conversación si le faltaba, para que desde el tablero se pueda saltar al
 * hilo. Sin esa regla, tres mensajes seguidos abrirían tres tarjetas iguales
 * y el tablero dejaría de servir en una tarde.
 *
 * ## Por qué en la misma transacción que el mensaje
 *
 * Porque la bandeja y el tablero no pueden discrepar. Con un evento en el
 * outbox habría una ventana —corta, pero real— en la que el agente ve la
 * conversación y el jefe de ventas no ve el lead. Y si el trabajo fallara,
 * no habría lead nunca y nadie se enteraría.
 */
import type { PoolClient } from 'pg';

/** Lo que cabe en el título de una tarjeta sin romper la columna. */
const LARGO_DEL_TITULO = 60;

export async function asegurarLead(
  c: PoolClient,
  entrada: {
    tenantId: string;
    contactId: string;
    conversationId: string;
    /** Primer texto del contacto: es el mejor título posible y sale gratis. */
    texto: string | null;
    nombreDelContacto: string | null;
  },
): Promise<{ creado: boolean; leadId: string | null }> {
  const { rows: destino } = await c.query<{ pipeline_id: string; stage_id: string }>(
    `SELECT s.pipeline_id, s.id AS stage_id
       FROM pipeline_stages s
       JOIN pipelines p ON p.id = s.pipeline_id
      WHERE p.tenant_id = $1 AND p.is_default
      ORDER BY s.position
      LIMIT 1`,
    [entrada.tenantId],
  );
  const sitio = destino[0];
  // Sin embudo no hay nada que llenar. No es un error: un inquilino puede
  // haber borrado el suyo, y perder mensajes por eso sería mucho peor.
  if (!sitio) return { creado: false, leadId: null };

  const titulo = tituloDeLead(entrada.texto, entrada.nombreDelContacto);
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO leads (tenant_id, pipeline_id, stage_id, contact_id, conversation_id, title)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      entrada.tenantId,
      sitio.pipeline_id,
      sitio.stage_id,
      entrada.contactId,
      entrada.conversationId,
      titulo,
    ],
  );

  const creado = rows[0];
  if (!creado) {
    // Ya tenía uno abierto: se le engancha esta conversación si no tenía
    // ninguna. Nunca se le cambia la que ya tuviera — el lead apunta a donde
    // empezó, no a lo último que pasó.
    await c.query(
      `UPDATE leads SET conversation_id = $3, updated_at = now()
        WHERE contact_id = $1 AND pipeline_id = $2
          AND status = 'abierto' AND conversation_id IS NULL`,
      [entrada.contactId, sitio.pipeline_id, entrada.conversationId],
    );
    return { creado: false, leadId: null };
  }

  await c.query(
    `INSERT INTO lead_events (tenant_id, lead_id, type, to_stage_id, meta)
     VALUES ($1, $2, 'creado', $3, $4)`,
    [entrada.tenantId, creado.id, sitio.stage_id, JSON.stringify({ origen: 'entrante' })],
  );
  return { creado: true, leadId: creado.id };
}

/**
 * El título por defecto es **lo que pidió el cliente**, no «Lead #4821».
 *
 * En una tienda de repuestos, «Par de palieres Toyota Probox» dice de un
 * vistazo lo que un número correlativo no dice nunca, y es exactamente lo que
 * el vendedor necesita leer en la tarjeta antes de abrirla.
 */
export function tituloDeLead(texto: string | null, nombre: string | null): string {
  const limpio = (texto ?? '').replace(/\s+/g, ' ').trim();
  if (limpio) {
    return limpio.length > LARGO_DEL_TITULO
      ? `${limpio.slice(0, LARGO_DEL_TITULO - 1).trimEnd()}…`
      : limpio;
  }
  // Sin texto —una foto, un audio— el nombre es lo único que hay.
  return nombre?.trim() || 'Lead sin título';
}
