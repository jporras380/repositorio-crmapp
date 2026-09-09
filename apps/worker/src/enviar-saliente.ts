/**
 * Entrega de un mensaje saliente a través del adaptador del canal.
 *
 * La API dejó el mensaje en `queued` y un evento `mensaje.enviar` en el
 * outbox. Aquí se llama al proveedor y se actualiza el resultado. Dos
 * propiedades importan:
 *
 * - **Idempotencia ante reintentos.** BullMQ puede ejecutar el job dos veces.
 *   Si el mensaje ya no está en `queued`, no se vuelve a enviar: el segundo
 *   intento es un no-op. Sin esto, un reintento tras un timeout de red
 *   mandaría el mismo WhatsApp dos veces al cliente.
 * - **`reintentable` decide el destino.** Un error reintentable se relanza
 *   para que BullMQ aplique backoff; uno no reintentable marca el mensaje como
 *   `failed` con su motivo y NO se relanza, porque cinco intentos con un token
 *   inválido siguen siendo un token inválido.
 */
import type { Pool } from 'pg';
import { withTenant } from '@crmapp/db';
import { ErrorDeCanal, type ChannelAdapter, type ResultadoDeEnvio } from '@crmapp/channels';
import { escribirEnOutbox } from '@crmapp/queue';
import type { Almacen } from '@crmapp/storage';

export interface CargaDeEnvio {
  messageId: string;
  createdAt: string;
  conversationId: string;
  channelAccountId: string;
  canal: string;
  externalUserId: string;
  peticion:
    | { tipo: 'text'; texto: string }
    | {
        tipo: 'image' | 'video' | 'audio' | 'document';
        /** URL externa, o `null` cuando el medio es nuestro (`mediaAssetId`). */
        url: string | null;
        mediaAssetId?: string | null | undefined;
        pieDeFoto?: string | undefined;
      }
    | { tipo: 'template'; nombre: string; idioma: string; parametros: string[] };
}

export interface DependenciasDeEnvio {
  pool: Pool;
  canales: Map<string, ChannelAdapter>;
  /**
   * Para firmar la URL de un medio propio EN EL MOMENTO del envío, no al
   * encolar: un job que espere en cola más que el TTL de la firma fallaría
   * con una URL caducada y el cliente vería "no se pudo enviar" sin motivo.
   */
  almacen?: Pick<Almacen, 'urlDeLectura'> | undefined;
}

export type ResultadoDeEntrega = 'enviado' | 'ya_procesado' | 'fallido';

export async function enviarMensajeSaliente(
  deps: DependenciasDeEnvio,
  tenantId: string,
  carga: CargaDeEnvio,
): Promise<ResultadoDeEntrega> {
  const adaptador = deps.canales.get(carga.canal);
  if (!adaptador) throw new Error(`Sin adaptador de envío para "${carga.canal}".`);

  const createdAt = new Date(carga.createdAt);

  // 1. Reservar: solo se envía si sigue en `queued`. El UPDATE condicional es
  //    lo que hace el job idempotente ante reintentos.
  const reservado = await withTenant(deps.pool, tenantId, async (c) => {
    const r = await c.query(
      `UPDATE messages SET status = 'sent', error = NULL
        WHERE created_at = $1 AND id = $2 AND status = 'queued'`,
      [createdAt, carga.messageId],
    );
    return (r.rowCount ?? 0) === 1;
  });
  if (!reservado) return 'ya_procesado';

  // 2. Llamar al proveedor FUERA de la transacción: una llamada de red dentro
  //    de una transacción abierta retiene la conexión y los bloqueos durante
  //    todo el tiempo que tarde Meta.
  let resultado: ResultadoDeEnvio;
  try {
    const cargaResuelta = await resolverMedioPropio(deps, tenantId, carga);
    resultado = await entregar(adaptador, cargaResuelta);
  } catch (error) {
    if (error instanceof ErrorDeCanal && !error.reintentable) {
      await withTenant(deps.pool, tenantId, async (c) => {
        await c.query(
          `UPDATE messages SET status = 'failed', error = $3 WHERE created_at = $1 AND id = $2`,
          [
            createdAt,
            carga.messageId,
            JSON.stringify({ tipo: error.tipo, mensaje: error.message }),
          ],
        );
        await escribirEnOutbox(c, {
          tenantId,
          aggregateType: 'message',
          aggregateId: carga.messageId,
          eventType: 'mensaje.fallido',
          payload: { conversationId: carga.conversationId, tipo: error.tipo },
        });
      });
      return 'fallido';
    }
    // Reintentable (límite de tasa, proveedor caído): se devuelve a `queued`
    // para que el próximo intento pase la reserva, y se relanza para que
    // BullMQ aplique backoff.
    await withTenant(deps.pool, tenantId, async (c) => {
      await c.query(`UPDATE messages SET status = 'queued' WHERE created_at = $1 AND id = $2`, [
        createdAt,
        carga.messageId,
      ]);
    });
    throw error;
  }

  // 3. Registrar el identificador del proveedor. La clave en message_keys es
  //    lo que permite que los webhooks de estado (delivered, read) encuentren
  //    este mensaje después.
  await withTenant(deps.pool, tenantId, async (c) => {
    await c.query(
      `UPDATE messages SET external_message_id = $3 WHERE created_at = $1 AND id = $2`,
      [createdAt, carga.messageId, resultado.externalMessageId],
    );
    await c.query(
      `INSERT INTO message_keys
         (tenant_id, channel_account_id, external_message_id, message_id, message_created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_account_id, external_message_id) DO NOTHING`,
      [tenantId, carga.channelAccountId, resultado.externalMessageId, carga.messageId, createdAt],
    );
    await escribirEnOutbox(c, {
      tenantId,
      aggregateType: 'message',
      aggregateId: carga.messageId,
      eventType: 'mensaje.enviado',
      payload: {
        conversationId: carga.conversationId,
        externalMessageId: resultado.externalMessageId,
      },
    });
  });

  return 'enviado';
}

/** Sustituye `mediaAssetId` por una URL firmada fresca. Sin medio propio, no toca nada. */
async function resolverMedioPropio(
  deps: DependenciasDeEnvio,
  tenantId: string,
  carga: CargaDeEnvio,
): Promise<CargaDeEnvio> {
  const p = carga.peticion;
  if (p.tipo === 'text' || p.tipo === 'template' || !p.mediaAssetId) return carga;
  if (!deps.almacen) throw new Error('Medio propio sin almacén configurado.');
  const clave = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{ storage_key: string | null; status: string }>(
      `SELECT storage_key, status FROM media_assets WHERE id = $1`,
      [p.mediaAssetId],
    );
    const m = rows[0];
    if (!m || m.status !== 'stored' || !m.storage_key) {
      // No reintentable: el medio no va a aparecer por esperar.
      throw new ErrorDeCanal(
        'tipo_no_soportado',
        `El medio ${p.mediaAssetId} no está almacenado.`,
        false,
      );
    }
    return m.storage_key;
  });
  const url = await deps.almacen.urlDeLectura(clave, 60 * 60);
  return { ...carga, peticion: { ...p, url } };
}

async function entregar(adaptador: ChannelAdapter, carga: CargaDeEnvio): Promise<ResultadoDeEnvio> {
  const destino = {
    externalUserId: carga.externalUserId,
    channelAccountId: carga.channelAccountId,
  };
  const p = carga.peticion;
  switch (p.tipo) {
    case 'text':
      return adaptador.sendText({ ...destino, texto: p.texto });
    case 'template':
      return adaptador.sendTemplate({
        ...destino,
        nombre: p.nombre,
        idioma: p.idioma,
        parametros: p.parametros,
      });
    default:
      return adaptador.sendMedia({
        ...destino,
        tipo: p.tipo,
        origen: { tipo: 'url', url: p.url ?? '' },
        pieDeFoto: p.pieDeFoto,
      });
  }
}
