/**
 * Consultas de plantillas que necesita la puerta de envío.
 *
 * Viven en este paquete y no en el módulo de plantillas de la API porque la
 * puerta las usa en cada envío y la puerta ya no es de la API: también envía
 * el worker cuando corre un Salesbot. Son lecturas, no reglas — lo único que
 * deciden es de qué versión sale el texto que se manda.
 */
import type { PoolClient } from 'pg';
import { ErrorDeNegocio } from '@crmapp/core';

export interface PlantillaSugerida {
  id: string;
  nombre: string;
  idioma: string;
}

/** Plantillas aprobadas de una cuenta: lo que se sugiere fuera de ventana (ARCH §9). */
export async function plantillasAprobadas(
  c: PoolClient,
  channelAccountId: string,
): Promise<PlantillaSugerida[]> {
  const { rows } = await c.query<PlantillaSugerida>(
    `SELECT id, name AS nombre, language AS idioma
       FROM wa_templates
      WHERE channel_account_id = $1 AND status = 'aprobada'
      ORDER BY name, language`,
    [channelAccountId],
  );
  return rows;
}

/**
 * Devuelve la versión actual de una plantilla aprobada, o lanza el error
 * tipado que la interfaz necesita para explicar por qué no sale.
 */
export async function exigirPlantillaAprobada(
  c: PoolClient,
  channelAccountId: string,
  nombre: string,
  idioma: string,
): Promise<string | null> {
  const { rows } = await c.query<{
    status: string;
    rejection_reason: string | null;
    current_version_id: string | null;
  }>(
    `SELECT status, rejection_reason, current_version_id
       FROM wa_templates
      WHERE channel_account_id = $1 AND name = $2 AND language = $3`,
    [channelAccountId, nombre, idioma],
  );
  const t = rows[0];
  if (!t) {
    throw new ErrorDeNegocio(
      'plantilla_desconocida',
      `La plantilla "${nombre}" (${idioma}) no está sincronizada en esta cuenta.`,
      422,
    );
  }
  if (t.status !== 'aprobada') {
    throw new ErrorDeNegocio(
      'plantilla_no_aprobada',
      `La plantilla "${nombre}" está en estado "${t.status}".`,
      422,
      { estado: t.status, motivoDeRechazo: t.rejection_reason },
    );
  }
  return t.current_version_id;
}

export interface VersionDeRapida {
  versionId: string;
  cuerpo: string;
  mediaAssetId: string | null;
  mediaKind: string | null;
  mediaStatus: string | null;
}

/** Versión actual de una respuesta rápida activa; `null` si no existe o está archivada. */
export async function versionActualDeRapida(
  c: PoolClient,
  quickReplyId: string,
): Promise<VersionDeRapida | null> {
  const { rows } = await c.query<VersionDeRapida>(
    `SELECT v.id AS "versionId", v.body AS cuerpo, v.media_asset_id AS "mediaAssetId",
            m.kind AS "mediaKind", m.status AS "mediaStatus"
       FROM quick_replies q
       JOIN quick_reply_versions v ON v.id = q.current_version_id
       LEFT JOIN media_assets m ON m.id = v.media_asset_id
      WHERE q.id = $1 AND q.archived_at IS NULL`,
    [quickReplyId],
  );
  return rows[0] ?? null;
}
