/**
 * Aviso automático fuera del horario de atención (0027).
 *
 * Es lo único que el CRM dice **por su cuenta** sin que lo mande un bot: un
 * aviso fijo que escribe el hotel, para que nadie se quede esperando a las
 * once de la noche. Reglas:
 *
 * - Apagado salvo que el hotel lo encienda y escriba el texto.
 * - Solo si está cerrado según SU horario y SU zona horaria (`core/horario`).
 * - **Una vez cada seis horas por conversación**: sin eso, diez mensajes de
 *   madrugada son diez avisos.
 * - Sale por la MISMA puerta que todo (`@crmapp/envio`), con `origen: 'bot'`:
 *   si la ventana está cerrada o la suscripción no permite enviar, no se
 *   fuerza nada. Un fallo aquí no puede tumbar la ingesta del mensaje.
 */
import type { PoolClient } from 'pg';
import { estaAbierto, type Horario } from '@crmapp/core';
import {
  cargarConversacionParaEnvio,
  enviarPorConversacion,
  type DependenciasDeEnvio,
} from '@crmapp/envio';

/** Cada cuánto se repite el aviso en la misma conversación. */
const HORAS_ENTRE_AVISOS = 6;

export async function avisarSiEstaCerrado(
  c: PoolClient,
  deps: DependenciasDeEnvio,
  p: { tenantId: string; conversationId: string; ahora: Date },
): Promise<boolean> {
  const { rows } = await c.query<{
    timezone: string;
    schedule: Horario;
    auto_reply_text: string;
    ultimo_aviso: Date | null;
  }>(
    `SELECT h.timezone, h.schedule, h.auto_reply_text, cv.out_of_hours_reply_at AS ultimo_aviso
       FROM business_hours h
       JOIN conversations cv ON cv.id = $1
      WHERE h.team_id IS NULL AND h.auto_reply_enabled AND h.auto_reply_text <> ''`,
    [p.conversationId],
  );
  const config = rows[0];
  if (!config) return false;

  // `null` = zona horaria que no se entiende: no se avisa. Suponer que está
  // cerrado escribiría a deshora a todo el mundo.
  if (estaAbierto(p.ahora, config.schedule ?? {}, config.timezone) !== false) return false;

  if (
    config.ultimo_aviso &&
    p.ahora.getTime() - config.ultimo_aviso.getTime() < HORAS_ENTRE_AVISOS * 3_600_000
  ) {
    return false;
  }

  try {
    const conversacion = await cargarConversacionParaEnvio(c, p.conversationId, { bloquear: true });
    await enviarPorConversacion(c, deps, {
      conversacion,
      peticion: { tipo: 'text', texto: config.auto_reply_text },
      remitente: { tenantId: p.tenantId, origen: 'bot', userId: null },
    });
  } catch {
    // Fuera de ventana, suscripción suspendida, canal sin capacidad: el aviso
    // es accesorio y el mensaje del cliente ya está guardado. No se reintenta.
    return false;
  }

  await c.query(`UPDATE conversations SET out_of_hours_reply_at = $2 WHERE id = $1`, [
    p.conversationId,
    p.ahora,
  ]);
  return true;
}
