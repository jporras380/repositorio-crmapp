/**
 * Descarga de medios entrantes (ARCH §12).
 *
 * WhatsApp entrega un `media_id` cuya URL firmada caduca pronto. Por eso esto
 * corre como job propio en cuanto el mensaje queda persistido, en vez de
 * esperar a que alguien abra la conversación: para entonces la URL ya no
 * serviría y el medio se habría perdido.
 *
 * Idempotente ante reintentos: si el medio ya está `stored`, no se vuelve a
 * descargar. Y deduplicado por contenido: si otro mensaje del mismo inquilino
 * trajo bytes idénticos (mismo sha256), se reutiliza su clave en vez de
 * guardarlo dos veces — un cliente que reenvía el mismo catálogo a 500
 * contactos lo almacena una vez.
 */
import type { Pool } from 'pg';
import { withTenant } from '@crmapp/db';
import { ErrorDeCanal, type ChannelAdapter } from '@crmapp/channels';
import { claveDeMedio, sha256De, type Almacen } from '@crmapp/storage';
import { escribirEnOutbox } from '@crmapp/queue';

export interface CargaDeMedia {
  mediaAssetId: string;
  messageId: string;
  channelAccountId: string;
  canal: string;
  /** Identificador del medio en el proveedor. */
  mediaId: string;
}

export interface DependenciasDeMedia {
  pool: Pool;
  canales: Map<string, Pick<ChannelAdapter, 'fetchMedia'>>;
  almacen: Almacen;
}

export type ResultadoDeMedia = 'guardado' | 'reutilizado' | 'ya_procesado' | 'fallido';

export async function descargarMedia(
  deps: DependenciasDeMedia,
  tenantId: string,
  carga: CargaDeMedia,
): Promise<ResultadoDeMedia> {
  const adaptador = deps.canales.get(carga.canal);
  if (!adaptador) throw new Error(`Sin adaptador para "${carga.canal}".`);

  // 1. Comprobar estado. Si ya está guardado, el reintento es un no-op.
  const estado = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{ status: string }>(
      `SELECT status FROM media_assets WHERE id = $1`,
      [carga.mediaAssetId],
    );
    return rows[0]?.status ?? null;
  });
  if (estado === null) throw new Error(`media_asset ${carga.mediaAssetId} no existe.`);
  if (estado === 'stored') return 'ya_procesado';

  // 2. Descargar FUERA de cualquier transacción: es una llamada de red.
  let descarga;
  try {
    descarga = await adaptador.fetchMedia(carga.mediaId, carga.channelAccountId);
  } catch (error) {
    if (error instanceof ErrorDeCanal && !error.reintentable) {
      await withTenant(deps.pool, tenantId, async (c) => {
        await c.query(
          `UPDATE media_assets SET status = 'failed', updated_at = now() WHERE id = $1`,
          [carga.mediaAssetId],
        );
      });
      return 'fallido';
    }
    throw error;
  }

  const sha = sha256De(descarga.datos);

  // 3. ¿Ya tenemos estos bytes? Reutilizar la clave.
  const existente = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{ storage_key: string }>(
      `SELECT storage_key FROM media_assets
        WHERE tenant_id = $1 AND sha256 = $2 AND status = 'stored' AND storage_key IS NOT NULL
        LIMIT 1`,
      [tenantId, sha],
    );
    return rows[0]?.storage_key ?? null;
  });

  const clave = existente ?? claveDeMedio(tenantId, carga.mediaAssetId, descarga.mime);
  if (!existente) await deps.almacen.guardar(clave, descarga.datos, descarga.mime);

  // 4. Registrar. Solo si sigue sin estar `stored`: dos jobs simultáneos del
  //    mismo medio podrían haber descargado los dos; el UPDATE condicional
  //    hace que solo uno "gane" y el otro reporte ya_procesado.
  const gano = await withTenant(deps.pool, tenantId, async (c) => {
    const r = await c.query(
      `UPDATE media_assets
          SET status = 'stored', storage_key = $2, mime = $3, bytes = $4, sha256 = $5, updated_at = now()
        WHERE id = $1 AND status <> 'stored'`,
      [carga.mediaAssetId, clave, descarga.mime, descarga.bytes, sha],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await escribirEnOutbox(c, {
      tenantId,
      aggregateType: 'media_asset',
      aggregateId: carga.mediaAssetId,
      eventType: 'media.lista',
      payload: { messageId: carga.messageId, bytes: descarga.bytes, mime: descarga.mime },
    });
    return true;
  });

  if (!gano) return 'ya_procesado';
  return existente ? 'reutilizado' : 'guardado';
}
