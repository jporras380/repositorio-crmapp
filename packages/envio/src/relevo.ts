/**
 * El relevo: cuando habla una persona, el bot se calla.
 *
 * Es el comportamiento que más se nota en un CRM con bots y el que más
 * enfada cuando falta: un agente entra a rescatar una conversación, escribe
 * dos frases, y el bot —que seguía dormido esperando su turno— suelta encima
 * «¿Sigues ahí?». Para el contacto son dos personas que no se hablan entre
 * ellas.
 *
 * ## Por qué vive en la puerta de envío y no en el motor de flujos
 *
 * Porque la puerta es el ÚNICO sitio por el que sale un mensaje (ARCH §9), y
 * por tanto el único sitio que puede ver «ha hablado un humano» sin que nadie
 * se acuerde de avisar. Ponerlo en `BandejaService` habría funcionado hoy y
 * habría fallado el día que envíe la app móvil o la API pública: cada camino
 * nuevo tendría que recordar apagar los bots, y el que lo olvide no falla
 * ruidosamente, falla hablando encima de un agente delante de un cliente.
 *
 * El costo de ponerlo aquí es real y hay que decirlo: `@crmapp/envio` pasa a
 * saber que existe `flow_runs`. Es una dependencia de una tabla, no de un
 * paquete, y en la misma transacción que el mensaje — o se apagan los bots y
 * sale el mensaje, o no pasa ninguna de las dos cosas.
 */
import type { PoolClient } from 'pg';

/**
 * Apaga las ejecuciones vivas de la conversación y deja dicho por qué.
 *
 * No cancela nada si no hay bots vivos, que es el caso normal: una consulta
 * por índice parcial y fuera.
 *
 * El despertador de Redis de una ejecución cancelada seguirá sonando a su
 * hora; no hay que borrarlo. Cuando suene, el motor buscará la ejecución en
 * estado `waiting` y no la encontrará: se retira sin hacer nada. Borrar jobs
 * de BullMQ desde una transacción de PostgreSQL sería, además, prometer algo
 * que no se puede deshacer si la transacción revierte.
 *
 * La marca `conversations.human_reply_at` —la que impide que entre otro bot
 * después— no se pone aquí sino en el UPDATE que la puerta ya hace sobre la
 * conversación: es la misma fila y el mismo instante, y escribirla dos veces
 * en el camino más caliente del producto no compra nada.
 */
export async function cederElTurnoAlHumano(
  c: PoolClient,
  entrada: { tenantId: string; conversationId: string },
): Promise<number> {
  const { rows } = await c.query<{ id: string; current_node_id: string | null }>(
    `UPDATE flow_runs
        SET status = 'cancelled',
            error = 'humano_tomo_el_control',
            wait_until = NULL,
            wait_for = NULL,
            ended_at = now(),
            updated_at = now()
      WHERE conversation_id = $1
        AND status IN ('running', 'waiting')
      RETURNING id, current_node_id`,
    [entrada.conversationId],
  );

  // El log paso a paso es lo que después contesta «¿por qué el bot dejó de
  // hablar?». Sin esta fila, la ejecución aparecería cortada a mitad y sin
  // motivo visible en la auditoría del flujo.
  for (const fila of rows) {
    await c.query(
      `INSERT INTO flow_run_steps (tenant_id, flow_run_id, node_id, kind, output)
       VALUES ($1, $2, $3, 'relevo', $4)`,
      [
        entrada.tenantId,
        fila.id,
        fila.current_node_id ?? 'desconocido',
        JSON.stringify({ cancelada: true, motivo: 'humano_tomo_el_control' }),
      ],
    );
  }

  return rows.length;
}

/**
 * ¿Puede arrancar un bot en esta conversación?
 *
 * No, si una persona ya respondió en ella. La regla es deliberadamente de la
 * CONVERSACIÓN y no de una ventana de tiempo: mientras el hilo lo lleve
 * alguien, es suyo. **Cerrar la conversación** —el gesto que el agente ya hace
 * cuando termina— es lo que devuelve el turno a los bots, y así no hay ningún
 * plazo mágico que explicar ni que afinar después.
 *
 * El costo: un bot de palabra clave no volverá a saltar en un hilo abierto que
 * un humano atendió, aunque hayan pasado semanas. Se arregla cerrando la
 * conversación, que es lo que debería haber pasado.
 */
export async function bloqueadaPorHumano(c: PoolClient, conversationId: string): Promise<boolean> {
  const { rows } = await c.query<{ human_reply_at: Date | null }>(
    `SELECT human_reply_at FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0]?.human_reply_at != null;
}
