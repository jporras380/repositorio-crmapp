/**
 * Bandeja de entrada y envío (ARCH §9).
 *
 * El envío atraviesa una puerta con orden fijo: permisos → estado de la
 * suscripción → estado de la conversación → ventana de sesión → capacidades
 * del canal → cola de salida. Cada paso devuelve un error TIPADO con lo que la
 * interfaz necesita para explicarlo; un "no se puede" sin motivo es un ticket.
 *
 * La API no envía nada: valida, inserta el mensaje en `queued` y escribe el
 * evento en el outbox. El worker lo entrega. Así una caída del proveedor no
 * bloquea la petición del agente, y el mensaje queda en la base aunque el
 * proceso muera un instante después.
 */
import type { PoolClient } from 'pg';
import { estadoEfectivo, ventanaAbierta, tiempoRestante, type Suscripcion } from '@crmapp/core';
import type { ChannelAdapter } from '@crmapp/channels';
import { escribirEnOutbox } from '@crmapp/queue';
import {
  enviarPorConversacion,
  leerSuscripcion,
  type MensajeEncolado,
  type PeticionDeEnvio,
} from '@crmapp/envio';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

// La puerta de envío vive en `@crmapp/envio`: la atraviesan el agente desde
// la API y el bot desde el worker, y tiene que ser la misma o las reglas de
// ventana y suscripción acabarían divergiendo. Los tipos se reexportan porque
// el controlador y el contrato de la web los importaban de aquí.
export type { MensajeEncolado, PeticionDeEnvio };

// ---------------------------------------------------------------------------
// Tipos de entrada y salida
// ---------------------------------------------------------------------------

export interface FiltrosDeBandeja {
  canal?: string | undefined;
  /** `dm` o `comment_thread`. Sin filtro, ambos. */
  tipo?: string | undefined;
  estado?: string | undefined;
  agenteId?: string | undefined;
  etiquetaId?: string | undefined;
  /** Último mensaje es del contacto y nadie ha respondido. */
  sinRespuesta?: boolean | undefined;
  cursor?: string | undefined;
  limite?: number | undefined;
}

export interface ResumenDeConversacion {
  id: string;
  canal: string;
  estado: string;
  /** `dm` o `comment_thread`: se responden de forma distinta y se ven distinto. */
  tipo: string;
  /** Publicación de la que cuelga el hilo, cuando es de comentarios. */
  publicacionId: string | null;
  contacto: { id: string; nombre: string | null; handle: string | null };
  agenteId: string | null;
  noLeidos: number;
  ultimoEntranteEn: Date | null;
  ultimoSalienteEn: Date | null;
  /** Instante; la interfaz calcula el tiempo restante para pintarlo. */
  ventanaExpiraEn: Date | null;
  ventanaAbierta: boolean;
  etiquetas: { id: string; nombre: string; color: string | null }[];
  vistaPrevia: string | null;
}

export interface OpcionesDeBandeja {
  db: BaseDeDatos;
  canales: Map<string, Pick<ChannelAdapter, 'capacidades' | 'politicaDeVentana'>>;
  ahora?: () => Date;
}

const LIMITE_POR_DEFECTO = 30;
const LIMITE_MAXIMO = 100;

export class BandejaService {
  readonly #db: BaseDeDatos;
  readonly #canales: OpcionesDeBandeja['canales'];
  readonly #ahora: () => Date;

  constructor(opciones: OpcionesDeBandeja) {
    this.#db = opciones.db;
    this.#canales = opciones.canales;
    this.#ahora = opciones.ahora ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /**
   * Lista paginada por cursor (keyset), no por offset.
   *
   * Con offset, una conversación que sube a la primera posición mientras el
   * agente pagina hace que la página siguiente repita una fila y salte otra.
   * En una bandeja viva eso pasa constantemente. El cursor codifica la última
   * (`last_inbound_at`, `id`) vista y sigue desde ahí.
   */
  async listar(filtros: FiltrosDeBandeja): Promise<{
    items: ResumenDeConversacion[];
    siguienteCursor: string | null;
  }> {
    const ctx = this.#exigirContexto();
    const limite = Math.min(filtros.limite ?? LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
    const condiciones: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    if (filtros.canal) condiciones.push(`ca.channel = ${p(filtros.canal)}`);
    if (filtros.estado) condiciones.push(`c.status = ${p(filtros.estado)}`);
    if (filtros.agenteId) condiciones.push(`c.assignee_user_id = ${p(filtros.agenteId)}`);
    if (filtros.tipo) condiciones.push(`c.kind = ${p(filtros.tipo)}`);
    if (filtros.etiquetaId) {
      condiciones.push(
        `EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id = c.id AND ct.tag_id = ${p(filtros.etiquetaId)})`,
      );
    }
    if (filtros.sinRespuesta) {
      // "Sin respuesta" se DERIVA, no se guarda: una columna booleana habría
      // que mantenerla en cada entrante y cada saliente, y el día que un
      // camino se olvide, el filtro miente sin que nadie lo note.
      condiciones.push(
        `c.last_inbound_at > COALESCE(c.last_outbound_at, '-infinity'::timestamptz)`,
      );
    }
    if (filtros.cursor) {
      const cur = decodificarCursor(filtros.cursor);
      condiciones.push(
        `(COALESCE(c.last_inbound_at, c.created_at), c.id) < (${p(cur.t)}::timestamptz, ${p(cur.id)}::uuid)`,
      );
    }

    const ahora = this.#ahora();

    const filas = await this.#db.enTransaccion(async (c) => {
      // Visibilidad entre agentes (ADR-008). Solo restringe al rol `agent`.
      const v = await this.#visibilidad(c, ctx);
      if (v) condiciones.push(condicionDeVisibilidad(v, 'c', ctx.userId, p));
      const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

      const { rows } = await c.query<FilaResumen>(
        `SELECT c.id, ca.channel AS canal, c.status AS estado, c.assignee_user_id,
                c.kind, c.external_thread_id,
                c.unread_count, c.last_inbound_at, c.last_outbound_at,
                c.session_expires_at, c.created_at,
                co.id AS contact_id, co.display_name, ci.handle,
                COALESCE(t.etiquetas, '[]'::json) AS etiquetas,
                m.body AS vista_previa
           FROM conversations c
           JOIN channel_accounts ca ON ca.id = c.channel_account_id
           JOIN contacts co ON co.id = c.contact_id
           JOIN contact_identities ci ON ci.id = c.contact_identity_id
           LEFT JOIN LATERAL (
             SELECT json_agg(json_build_object('id', tg.id, 'nombre', tg.name, 'color', tg.color)
                             ORDER BY tg.name) AS etiquetas
               FROM conversation_tags ct JOIN tags tg ON tg.id = ct.tag_id
              WHERE ct.conversation_id = c.id
           ) t ON true
           LEFT JOIN LATERAL (
             SELECT body FROM messages
              WHERE conversation_id = c.id
              ORDER BY created_at DESC LIMIT 1
           ) m ON true
           ${where}
          ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC, c.id DESC
          LIMIT ${p(limite + 1)}`,
        params,
      );
      return rows;
    });

    const hayMas = filas.length > limite;
    const pagina = hayMas ? filas.slice(0, limite) : filas;
    const ultima = pagina[pagina.length - 1];

    return {
      items: pagina.map((f) => aResumen(f, ahora)),
      siguienteCursor:
        hayMas && ultima
          ? codificarCursor({
              t: (ultima.last_inbound_at ?? ultima.created_at).toISOString(),
              id: ultima.id,
            })
          : null,
    };
  }

  async mensajes(
    conversationId: string,
    opciones: { cursor?: string | undefined; limite?: number | undefined } = {},
  ): Promise<{ items: MensajeDeConversacion[]; siguienteCursor: string | null }> {
    const limite = Math.min(opciones.limite ?? 50, LIMITE_MAXIMO);
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      const params: unknown[] = [conversationId, limite + 1];
      let condicionCursor = '';
      if (opciones.cursor) {
        const cur = decodificarCursor(opciones.cursor);
        params.push(cur.t, cur.id);
        condicionCursor = `AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)`;
      }
      const { rows } = await c.query<MensajeDeConversacion>(
        `SELECT m.id, m.direction AS direccion, m.type AS tipo, m.body AS texto, m.status AS estado,
                m.sent_by AS origen, m.ai_generated AS generado_por_ia, m.created_at AS creado_en,
                m.error, m.media_asset_id AS medio_id, ma.status AS medio_estado
           FROM messages m
           LEFT JOIN media_assets ma ON ma.id = m.media_asset_id
          WHERE m.conversation_id = $1 ${condicionCursor}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $2`,
        params,
      );
      const hayMas = rows.length > limite;
      const pagina = hayMas ? rows.slice(0, limite) : rows;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina,
        siguienteCursor:
          hayMas && ultima
            ? codificarCursor({ t: new Date(ultima.creado_en).toISOString(), id: ultima.id })
            : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Envío: la puerta del ARCH §9
  // -------------------------------------------------------------------------

  /**
   * Encola un mensaje del agente.
   *
   * Aquí solo quedan las dos cosas que son de la API: comprobar que este
   * usuario puede ver esta conversación (ADR-008 — un bot no tiene a quién
   * comprobárselo) y abrir la transacción. La puerta —suscripción, estado,
   * ventana, capacidades, outbox— vive en `@crmapp/envio`.
   */
  async enviar(conversationId: string, peticion: PeticionDeEnvio): Promise<MensajeEncolado> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const conv = await this.#exigirConversacion(c, conversationId, { bloquear: true });
      return enviarPorConversacion(
        c,
        { canales: this.#canales, ahora: this.#ahora },
        {
          conversacion: conv,
          peticion,
          remitente: { tenantId: ctx.tenantId, origen: 'human', userId: ctx.userId },
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Acciones sobre la conversación
  // -------------------------------------------------------------------------

  async asignar(conversationId: string, agenteId: string | null): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      if (agenteId) {
        const { rows } = await c.query(
          `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
          [ctx.tenantId, agenteId],
        );
        if (rows.length === 0)
          throw new ErrorDeNegocio('agente_invalido', 'Ese usuario no pertenece a la cuenta.', 422);
      }
      await c.query(
        `UPDATE conversations SET assignee_user_id = $2, updated_at = now() WHERE id = $1`,
        [conversationId, agenteId],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'conversacion.asignada', 'conversation', $3, $4)`,
        [ctx.tenantId, ctx.userId, conversationId, JSON.stringify({ agenteId })],
      );
    });
  }

  async cambiarEstado(
    conversationId: string,
    estado: 'open' | 'pending' | 'snoozed' | 'closed',
  ): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      await c.query(
        `UPDATE conversations
            SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [conversationId, estado],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'conversacion.estado', 'conversation', $3, $4)`,
        [ctx.tenantId, ctx.userId, conversationId, JSON.stringify({ estado })],
      );
    });
  }

  /** Etiquetas con color, al estilo Zenvia: son el filtro de primer nivel. */
  async etiquetar(conversationId: string, tagId: string, poner: boolean): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      if (poner) {
        await c.query(
          `INSERT INTO conversation_tags (tenant_id, conversation_id, tag_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [ctx.tenantId, conversationId, tagId],
        );
      } else {
        await c.query(`DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2`, [
          conversationId,
          tagId,
        ]);
      }
    });
  }

  /** Etiquetas de la cuenta, para el filtro de primer nivel de la bandeja (Zenvia). */
  async listarEtiquetas(): Promise<{ id: string; nombre: string; color: string | null }[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string; nombre: string; color: string | null }>(
        `SELECT id, name AS nombre, color FROM tags ORDER BY name`,
      );
      return rows;
    });
  }

  async crearEtiqueta(nombre: string, color: string | null): Promise<{ id: string }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(`INSERT INTO tags (id, tenant_id, name, color) VALUES ($1, $2, $3, $4)`, [
          id,
          ctx.tenantId,
          nombre,
          color,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'etiqueta_repetida',
            'Ya existe una etiqueta con ese nombre.',
            409,
          );
        }
        throw error;
      }
      return { id };
    });
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  /**
   * Restricción de visibilidad del agente actual, o `null` si ve todo.
   *
   * Propietario, administrador y supervisor ven siempre todo: su trabajo es
   * precisamente ver lo que los agentes no atienden.
   */
  async #visibilidad(
    c: PoolClient,
    ctx: { tenantId: string; userId: string; rol: string },
  ): Promise<Visibilidad | null> {
    if (ctx.rol !== 'agent') return null;
    const { rows } = await c.query<{ modo: 'all' | 'team' | 'assigned' }>(
      `SELECT conversation_visibility AS modo FROM tenants WHERE id = $1`,
      [ctx.tenantId],
    );
    const modo = rows[0]?.modo ?? 'all';
    if (modo === 'all') return null;
    const equipos =
      modo === 'team'
        ? (
            await c.query<{ team_id: string }>(
              `SELECT tm.team_id FROM team_members tm
                 JOIN memberships m ON m.id = tm.membership_id
                WHERE m.user_id = $1 AND m.tenant_id = $2`,
              [ctx.userId, ctx.tenantId],
            )
          ).rows.map((r) => r.team_id)
        : [];
    return { modo, equipos };
  }

  /** Solo propietario o administrador cambian la política de la cuenta. */
  async cambiarVisibilidad(modo: 'all' | 'team' | 'assigned'): Promise<void> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden cambiarlo.',
        403,
      );
    }
    await this.#db.enTransaccion(async (c) => {
      await c.query(
        `UPDATE tenants SET conversation_visibility = $2, updated_at = now() WHERE id = $1`,
        [ctx.tenantId, modo],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'cuenta.visibilidad', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify({ modo })],
      );
    });
  }

  async #exigirConversacion(
    c: PoolClient,
    id: string,
    opciones: { bloquear?: boolean } = {},
  ): Promise<FilaConversacion> {
    const { rows } = await c.query<FilaConversacion>(
      `SELECT c.id, c.status, c.session_expires_at, c.channel_account_id, ca.channel,
              ci.external_user_id, c.assignee_user_id, c.team_id
         FROM conversations c
         JOIN channel_accounts ca ON ca.id = c.channel_account_id
         JOIN contact_identities ci ON ci.id = c.contact_identity_id
        WHERE c.id = $1 ${opciones.bloquear ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
    const fila = rows[0];
    // RLS ya filtra por inquilino: una conversación ajena simplemente no
    // existe desde aquí, y se responde igual que a una inexistente. Distinguir
    // "no existe" de "no es tuya" diría a un atacante que el id es válido.
    if (!fila) {
      throw new ErrorDeNegocio('conversacion_no_encontrada', 'La conversación no existe.', 404);
    }

    // Misma respuesta si el agente no debe verla: el filtro de la lista y el
    // acceso por id tienen que coincidir, o la lista es decorativa.
    const ctx = this.#exigirContexto();
    const v = await this.#visibilidad(c, ctx);
    if (v && !visible(v, fila, ctx.userId)) {
      throw new ErrorDeNegocio('conversacion_no_encontrada', 'La conversación no existe.', 404);
    }
    return fila;
  }
}

// ---------------------------------------------------------------------------

interface Visibilidad {
  modo: 'team' | 'assigned';
  equipos: string[];
}

/** Cláusula SQL del filtro de visibilidad para el alias dado. */
function condicionDeVisibilidad(
  v: Visibilidad,
  alias: string,
  userId: string,
  p: (valor: unknown) => string,
): string {
  if (v.modo === 'assigned') return `${alias}.assignee_user_id = ${p(userId)}`;
  // En `team` las SIN ASIGNAR siempre se ven: ocultarlas reproduce el fallo
  // que más cuesta —una conversación nueva que nadie atiende.
  return (
    `(${alias}.assignee_user_id = ${p(userId)} OR ${alias}.assignee_user_id IS NULL ` +
    `OR ${alias}.team_id = ANY(${p(v.equipos)}::uuid[]))`
  );
}

/** Misma regla que la cláusula SQL, aplicada a una fila ya leída. */
function visible(
  v: Visibilidad,
  fila: { assignee_user_id: string | null; team_id: string | null },
  userId: string,
): boolean {
  if (fila.assignee_user_id === userId) return true;
  if (v.modo === 'assigned') return false;
  if (fila.assignee_user_id === null) return true;
  return fila.team_id !== null && v.equipos.includes(fila.team_id);
}

interface FilaConversacion {
  id: string;
  assignee_user_id: string | null;
  team_id: string | null;
  status: string;
  session_expires_at: Date | null;
  channel_account_id: string;
  channel: string;
  external_user_id: string;
}

interface FilaResumen {
  id: string;
  canal: string;
  estado: string;
  kind: string;
  external_thread_id: string | null;
  assignee_user_id: string | null;
  unread_count: number;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  session_expires_at: Date | null;
  created_at: Date;
  contact_id: string;
  display_name: string | null;
  handle: string | null;
  etiquetas: { id: string; nombre: string; color: string | null }[];
  vista_previa: string | null;
}

export interface MensajeDeConversacion {
  id: string;
  direccion: 'inbound' | 'outbound';
  tipo: string;
  texto: string | null;
  estado: string;
  origen: string;
  generado_por_ia: boolean;
  creado_en: Date;
  error: unknown;
  /** Medio propio; la URL se pide aparte en GET /v1/medios/:id/url. */
  medio_id: string | null;
  medio_estado: string | null;
}

function aResumen(f: FilaResumen, ahora: Date): ResumenDeConversacion {
  return {
    id: f.id,
    canal: f.canal,
    estado: f.estado,
    tipo: f.kind,
    publicacionId: f.external_thread_id,
    contacto: { id: f.contact_id, nombre: f.display_name, handle: f.handle },
    agenteId: f.assignee_user_id,
    noLeidos: f.unread_count,
    ultimoEntranteEn: f.last_inbound_at,
    ultimoSalienteEn: f.last_outbound_at,
    ventanaExpiraEn: f.session_expires_at,
    ventanaAbierta:
      ventanaAbierta(f.session_expires_at, ahora) &&
      tiempoRestante(f.session_expires_at, ahora) !== 0,
    etiquetas: f.etiquetas,
    vistaPrevia: f.vista_previa,
  };
}

function codificarCursor(c: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodificarCursor(cursor: string): { t: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof c.t !== 'string' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new ErrorDeNegocio('cursor_invalido', 'El cursor de paginación no es válido.', 400);
  }
}

// `estadoEfectivo` se reexporta para que el controlador informe del estado en
// la respuesta de la bandeja sin duplicar la lectura.
export { estadoEfectivo };
