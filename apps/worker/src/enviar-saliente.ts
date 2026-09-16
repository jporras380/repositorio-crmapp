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
import { registrarUso, withTenant } from '@crmapp/db';
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
    | { tipo: 'template'; nombre: string; idioma: string; parametros: string[] }
    | { tipo: 'comment_reply'; modo: 'publica' | 'privada'; texto: string; comentarioId: string };
}

export interface DependenciasDeEnvio {
  pool: Pool;
  canales: Map<string, ChannelAdapter>;
  /**
   * Para firmar la URL de un medio propio EN EL MOMENTO del envío, no al
   * encolar: un job que espere en cola más que el TTL de la firma fallaría
   * con una URL caducada y el cliente vería "no se pudo enviar" sin motivo.
   */
  almacen?: Pick<Almacen, 'urlDeLectura' | 'leer'> | undefined;
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
    const { carga: cargaResuelta, bytes } = await resolverMedioPropio(
      deps,
      tenantId,
      carga,
      adaptador,
    );
    resultado = await entregar(adaptador, cargaResuelta, bytes);
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
    // Medición: se cuenta lo ENTREGADO al proveedor, no lo encolado. Un
    // mensaje que falla no consume.
    await registrarUso(c, {
      tenantId,
      metric: 'messages.outbound',
      dedupKey: `message:${carga.messageId}:outbound`,
      meta: { channel: carga.canal, type: carga.peticion.tipo },
    });
    if (carga.peticion.tipo === 'template') {
      await registrarUso(c, {
        tenantId,
        metric: 'templates.sent',
        dedupKey: `message:${carga.messageId}:template`,
        meta: { channel: carga.canal, nombre: carga.peticion.nombre },
      });
    }
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
/** Los bytes de un medio propio, cuando el canal los sube él mismo. */
interface BytesDeMedio {
  datos: Buffer;
  mime: string;
}

/**
 * Deja el medio propio listo para el canal, de una de dos formas.
 *
 * **Si el canal sube los bytes él mismo** (WhatsApp, que declara
 * `requiereUrlPublicaParaMedios: false`), se leen del almacén y se le pasan.
 * Meta los guarda y devuelve un id.
 *
 * **Si el canal exige una URL pública** (Instagram), se firma una de lectura.
 *
 * La capacidad estaba declarada desde PR-7 y no la miraba nadie: se mandaba
 * SIEMPRE una URL. En desarrollo, esa URL apunta a MinIO en `localhost`, donde
 * los servidores de Meta no pueden entrar, así que la imagen se aceptaba con
 * su `wamid` y fallaba después, en silencio, con «Media upload error». En
 * producción obligaba a exponer el bucket a internet sin necesidad.
 */
async function resolverMedioPropio(
  deps: DependenciasDeEnvio,
  tenantId: string,
  carga: CargaDeEnvio,
  adaptador: ChannelAdapter,
): Promise<{ carga: CargaDeEnvio; bytes: BytesDeMedio | null }> {
  const p = carga.peticion;
  if (p.tipo === 'text' || p.tipo === 'template' || p.tipo === 'comment_reply' || !p.mediaAssetId)
    return { carga, bytes: null };
  if (!deps.almacen) throw new Error('Medio propio sin almacén configurado.');
  const medio = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{
      storage_key: string | null;
      status: string;
      mime: string | null;
    }>(`SELECT storage_key, status, mime FROM media_assets WHERE id = $1`, [p.mediaAssetId]);
    const m = rows[0];
    if (!m || m.status !== 'stored' || !m.storage_key) {
      // No reintentable: el medio no va a aparecer por esperar.
      throw new ErrorDeCanal(
        'tipo_no_soportado',
        `El medio ${p.mediaAssetId} no está almacenado.`,
        false,
      );
    }
    return { clave: m.storage_key, mime: m.mime };
  });

  if (!adaptador.capacidades().requiereUrlPublicaParaMedios) {
    const { datos, mime } = await deps.almacen.leer(medio.clave);
    return {
      carga,
      bytes: { datos, mime: medio.mime ?? mime ?? 'application/octet-stream' },
    };
  }

  const url = await deps.almacen.urlDeLectura(medio.clave, 60 * 60);
  return { carga: { ...carga, peticion: { ...p, url } }, bytes: null };
}

async function entregar(
  adaptador: ChannelAdapter,
  carga: CargaDeEnvio,
  bytes: BytesDeMedio | null,
): Promise<ResultadoDeEnvio> {
  const destino = {
    externalUserId: carga.externalUserId,
    channelAccountId: carga.channelAccountId,
  };
  const p = carga.peticion;
  switch (p.tipo) {
    case 'text':
      return adaptador.sendText({ ...destino, texto: p.texto });
    case 'comment_reply':
      return adaptador.replyToComment({
        channelAccountId: carga.channelAccountId,
        comentarioId: p.comentarioId,
        texto: p.texto,
        modo: p.modo,
      });
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
        origen: bytes
          ? { tipo: 'buffer', datos: bytes.datos, mime: bytes.mime }
          : { tipo: 'url', url: p.url ?? '' },
        pieDeFoto: p.pieDeFoto,
      });
  }
}
