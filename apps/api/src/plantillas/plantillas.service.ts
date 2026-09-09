/**
 * Plantillas (ARCH §5.6): respuestas rápidas del CRM y plantillas HSM de
 * WhatsApp. Dos entidades, nunca un campo `tipo`.
 *
 * Lo que decide todo el módulo: **el estado de una HSM lo fija Meta**. Aquí
 * no se aprueba nada; se sincroniza (`syncTemplates`) y se refleja lo que
 * llega por webhook. Si la base dice `aprobada`, es porque Meta lo dijo.
 */
import type { PoolClient } from 'pg';
import { ErrorDeCanal, type ChannelAdapter, type PlantillaSincronizada } from '@crmapp/channels';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface OpcionesDePlantillas {
  db: BaseDeDatos;
  canales: Map<string, Pick<ChannelAdapter, 'syncTemplates'>>;
  ahora?: () => Date;
}

export interface PlantillaDeWhatsapp {
  id: string;
  nombre: string;
  idioma: string;
  estado: string;
  categoriaDeclarada: string | null;
  categoriaEfectiva: string | null;
  calidad: string | null;
  motivoDeRechazo: string | null;
  metaTemplateId: string | null;
  ultimaSincronizacion: Date | null;
}

export interface ResultadoDeSincronizacion {
  total: number;
  nuevas: number;
  actualizadas: number;
}

export interface RespuestaRapida {
  id: string;
  atajo: string;
  titulo: string;
  cuerpo: string;
  medioId: string | null;
  version: number;
  actualizadoEn: Date;
}

export interface DatosDeRapida {
  atajo: string;
  titulo: string;
  cuerpo: string;
  mediaAssetId?: string | undefined;
}

const KINDS_ADJUNTABLES = new Set(['image', 'video', 'audio', 'document']);

export class PlantillasService {
  readonly #db: BaseDeDatos;
  readonly #canales: OpcionesDePlantillas['canales'];
  readonly #ahora: () => Date;

  constructor(o: OpcionesDePlantillas) {
    this.#db = o.db;
    this.#canales = o.canales;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // WhatsApp (HSM)
  // -------------------------------------------------------------------------

  /**
   * Trae el estado real de Meta y lo refleja. La llamada de red va FUERA de
   * la transacción: no se retienen bloqueos mientras Meta responde.
   *
   * No se deshabilitan las que Meta ya no devuelve: el adaptador pagina de
   * 100 en 100 y una cuenta grande haría parecer borradas plantillas vivas.
   */
  async sincronizar(channelAccountId: string): Promise<ResultadoDeSincronizacion> {
    const ctx = this.#exigirGestor();

    const cuenta = await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ channel: string; status: string }>(
        `SELECT channel, status FROM channel_accounts WHERE id = $1`,
        [channelAccountId],
      );
      return rows[0] ?? null;
    });
    if (!cuenta)
      throw new ErrorDeNegocio('canal_no_encontrado', 'La cuenta de canal no existe.', 404);
    if (cuenta.status === 'disconnected') {
      throw new ErrorDeNegocio('canal_desconectado', 'La cuenta está desconectada.', 409);
    }
    const adaptador = this.#canales.get(cuenta.channel);
    if (!adaptador) {
      throw new ErrorDeNegocio(
        'canal_no_disponible',
        `Canal "${cuenta.channel}" no disponible.`,
        503,
      );
    }

    let remotas: PlantillaSincronizada[];
    try {
      remotas = await adaptador.syncTemplates(channelAccountId);
    } catch (error) {
      if (error instanceof ErrorDeCanal) {
        throw new ErrorDeNegocio(`proveedor_${error.tipo}`, error.message, 502);
      }
      throw error;
    }

    const ahora = this.#ahora();
    return this.#db.enTransaccion(async (c) => {
      let nuevas = 0;
      let actualizadas = 0;
      for (const p of remotas) {
        const existente = await c.query<{ id: string; current_version_id: string | null }>(
          `SELECT id, current_version_id FROM wa_templates
            WHERE channel_account_id = $1 AND name = $2 AND language = $3`,
          [channelAccountId, p.nombre, p.idioma],
        );
        const fila = existente.rows[0];
        if (!fila) {
          await this.#crearDesdeMeta(c, ctx.tenantId, channelAccountId, p, ahora);
          nuevas += 1;
          continue;
        }
        const r = await c.query(
          `UPDATE wa_templates
              SET status = $2, category_effective = $3, quality_score = $4,
                  rejection_reason = $5, meta_template_id = $6, last_synced_at = $7, updated_at = now()
            WHERE id = $1
              AND (status IS DISTINCT FROM $2 OR category_effective IS DISTINCT FROM $3
                   OR quality_score IS DISTINCT FROM $4 OR rejection_reason IS DISTINCT FROM $5)`,
          [
            fila.id,
            p.estado,
            p.categoriaEfectiva,
            p.calidad,
            p.motivoDeRechazo,
            p.externalId,
            ahora,
          ],
        );
        // Aunque nada cambie, la fecha de sincronización sí.
        await c.query(`UPDATE wa_templates SET last_synced_at = $2 WHERE id = $1`, [
          fila.id,
          ahora,
        ]);
        if ((r.rowCount ?? 0) > 0) {
          actualizadas += 1;
          if (fila.current_version_id) {
            await c.query(
              `UPDATE wa_template_versions SET status = $2, rejection_reason = $3, reviewed_at = $4 WHERE id = $1`,
              [fila.current_version_id, p.estado, p.motivoDeRechazo, ahora],
            );
          }
        }
      }
      return { total: remotas.length, nuevas, actualizadas };
    });
  }

  async listarWhatsapp(channelAccountId: string): Promise<PlantillaDeWhatsapp[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const cuenta = await c.query(`SELECT 1 FROM channel_accounts WHERE id = $1`, [
        channelAccountId,
      ]);
      if (cuenta.rows.length === 0) {
        throw new ErrorDeNegocio('canal_no_encontrado', 'La cuenta de canal no existe.', 404);
      }
      const { rows } = await c.query<PlantillaDeWhatsapp>(
        `SELECT id, name AS nombre, language AS idioma, status AS estado,
                category_declared AS "categoriaDeclarada", category_effective AS "categoriaEfectiva",
                quality_score AS calidad, rejection_reason AS "motivoDeRechazo",
                meta_template_id AS "metaTemplateId", last_synced_at AS "ultimaSincronizacion"
           FROM wa_templates
          WHERE channel_account_id = $1
          ORDER BY name, language`,
        [channelAccountId],
      );
      return rows;
    });
  }

  async #crearDesdeMeta(
    c: PoolClient,
    tenantId: string,
    channelAccountId: string,
    p: PlantillaSincronizada,
    ahora: Date,
  ): Promise<void> {
    const id = await this.#db.nuevoId(c);
    const versionId = await this.#db.nuevoId(c);
    await c.query(
      `INSERT INTO wa_templates
         (id, tenant_id, channel_account_id, name, language, category_effective, status,
          meta_template_id, quality_score, rejection_reason, last_synced_at, current_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        tenantId,
        channelAccountId,
        p.nombre,
        p.idioma,
        p.categoriaEfectiva,
        p.estado,
        p.externalId,
        p.calidad,
        p.motivoDeRechazo,
        ahora,
        versionId,
      ],
    );
    await c.query(
      `INSERT INTO wa_template_versions
         (id, tenant_id, template_id, version, status, meta_template_id, rejection_reason, reviewed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
      [versionId, tenantId, id, p.estado, p.externalId, p.motivoDeRechazo, ahora],
    );
  }

  // -------------------------------------------------------------------------
  // Respuestas rápidas
  // -------------------------------------------------------------------------

  async listarRapidas(): Promise<RespuestaRapida[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<RespuestaRapida>(
        `SELECT q.id, q.shortcut AS atajo, q.title AS titulo, v.body AS cuerpo,
                v.media_asset_id AS "medioId", v.version, q.updated_at AS "actualizadoEn"
           FROM quick_replies q
           JOIN quick_reply_versions v ON v.id = q.current_version_id
          WHERE q.archived_at IS NULL
          ORDER BY q.shortcut`,
      );
      return rows;
    });
  }

  async crearRapida(datos: DatosDeRapida): Promise<RespuestaRapida> {
    const ctx = this.#exigirGestor();
    this.#exigirContenido(datos.cuerpo, datos.mediaAssetId);
    return this.#db.enTransaccion(async (c) => {
      if (datos.mediaAssetId) await this.#exigirMedioAdjuntable(c, datos.mediaAssetId);
      const id = await this.#db.nuevoId(c);
      await this.#sinAtajoRepetido(() =>
        c.query(
          `INSERT INTO quick_replies (id, tenant_id, shortcut, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [id, ctx.tenantId, datos.atajo, datos.titulo, ctx.userId],
        ),
      );
      await this.#nuevaVersion(c, ctx, id, 1, datos.cuerpo, datos.mediaAssetId ?? null);
      return this.#leerRapida(c, id);
    });
  }

  /**
   * Editar crea una versión nueva si cambia el contenido; título y atajo se
   * actualizan en sitio. Los mensajes ya enviados siguen apuntando a la
   * versión con la que salieron.
   */
  async editarRapida(id: string, cambios: Partial<DatosDeRapida>): Promise<RespuestaRapida> {
    const ctx = this.#exigirGestor();
    return this.#db.enTransaccion(async (c) => {
      const actual = await c.query<{
        shortcut: string;
        title: string;
        version: number;
        body: string;
        media_asset_id: string | null;
      }>(
        `SELECT q.shortcut, q.title, v.version, v.body, v.media_asset_id
           FROM quick_replies q JOIN quick_reply_versions v ON v.id = q.current_version_id
          WHERE q.id = $1 AND q.archived_at IS NULL
          FOR UPDATE OF q`,
        [id],
      );
      const a = actual.rows[0];
      if (!a)
        throw new ErrorDeNegocio(
          'respuesta_rapida_no_encontrada',
          'La respuesta rápida no existe.',
          404,
        );

      const cuerpo = cambios.cuerpo ?? a.body;
      const medio = cambios.mediaAssetId === undefined ? a.media_asset_id : cambios.mediaAssetId;
      this.#exigirContenido(cuerpo, medio ?? undefined);
      if (medio && medio !== a.media_asset_id) await this.#exigirMedioAdjuntable(c, medio);

      if (cuerpo !== a.body || medio !== a.media_asset_id) {
        await this.#nuevaVersion(c, ctx, id, a.version + 1, cuerpo, medio);
      }
      await this.#sinAtajoRepetido(() =>
        c.query(
          `UPDATE quick_replies SET shortcut = $2, title = $3, updated_at = now() WHERE id = $1`,
          [id, cambios.atajo ?? a.shortcut, cambios.titulo ?? a.title],
        ),
      );
      return this.#leerRapida(c, id);
    });
  }

  async archivarRapida(id: string): Promise<void> {
    this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      const r = await c.query(
        `UPDATE quick_replies SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL`,
        [id],
      );
      if ((r.rowCount ?? 0) === 0) {
        throw new ErrorDeNegocio(
          'respuesta_rapida_no_encontrada',
          'La respuesta rápida no existe.',
          404,
        );
      }
    });
  }

  async #nuevaVersion(
    c: PoolClient,
    ctx: { tenantId: string; userId: string },
    quickReplyId: string,
    version: number,
    cuerpo: string,
    mediaAssetId: string | null,
  ): Promise<void> {
    const versionId = await this.#db.nuevoId(c);
    await c.query(
      `INSERT INTO quick_reply_versions (id, tenant_id, quick_reply_id, version, body, media_asset_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [versionId, ctx.tenantId, quickReplyId, version, cuerpo, mediaAssetId, ctx.userId],
    );
    await c.query(
      `UPDATE quick_replies SET current_version_id = $2, updated_at = now() WHERE id = $1`,
      [quickReplyId, versionId],
    );
  }

  async #leerRapida(c: PoolClient, id: string): Promise<RespuestaRapida> {
    const { rows } = await c.query<RespuestaRapida>(
      `SELECT q.id, q.shortcut AS atajo, q.title AS titulo, v.body AS cuerpo,
              v.media_asset_id AS "medioId", v.version, q.updated_at AS "actualizadoEn"
         FROM quick_replies q JOIN quick_reply_versions v ON v.id = q.current_version_id
        WHERE q.id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async #exigirMedioAdjuntable(c: PoolClient, mediaAssetId: string): Promise<void> {
    const { rows } = await c.query<{ kind: string; status: string }>(
      `SELECT kind, status FROM media_assets WHERE id = $1`,
      [mediaAssetId],
    );
    const m = rows[0];
    if (!m) throw new ErrorDeNegocio('medio_no_encontrado', 'El medio no existe.', 404);
    if (m.status !== 'stored') {
      throw new ErrorDeNegocio('medio_no_disponible', 'El medio todavía no está almacenado.', 409);
    }
    if (!KINDS_ADJUNTABLES.has(m.kind)) {
      throw new ErrorDeNegocio(
        'tipo_no_permitido',
        `No se puede adjuntar un medio de tipo "${m.kind}".`,
        415,
      );
    }
  }

  #exigirContenido(cuerpo: string, mediaAssetId: string | undefined): void {
    if (!cuerpo.trim() && !mediaAssetId) {
      throw new ErrorDeNegocio(
        'contenido_requerido',
        'Una respuesta rápida necesita texto o un adjunto.',
        400,
      );
    }
  }

  async #sinAtajoRepetido<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ErrorDeNegocio(
          'atajo_repetido',
          'Ya existe una respuesta rápida con ese atajo.',
          409,
        );
      }
      throw error;
    }
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  /** Gestionar plantillas: propietario, administrador o supervisor. Usarlas: cualquiera. */
  #exigirGestor() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin' && ctx.rol !== 'supervisor') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario, administrador o supervisor gestionan plantillas.',
        403,
      );
    }
    return ctx;
  }
}
