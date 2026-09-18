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
  /** Estado de atención DEDUCIDO (0020): nueva, por_responder, … */
  atencion?: string | undefined;
  /** Busca por el contacto (nombre, @ o teléfono) y por el texto de sus mensajes. */
  q?: string | undefined;
  /** Rango sobre la última actividad, en ISO. */
  desde?: string | undefined;
  hasta?: string | undefined;
  /** Conversaciones cuyo lead está en esta etapa del embudo. */
  etapaId?: string | undefined;
  /** `dm` o `comment_thread`. Sin filtro, ambos. */
  tipo?: string | undefined;
  estado?: string | undefined;
  agenteId?: string | undefined;
  etiquetaId?: string | undefined;
  /** Espera a una persona del equipo: estado de atención `nueva` o `por_responder`. */
  sinRespuesta?: boolean | undefined;
  /** Solo las que un bot dejó pidiendo una persona (0029). */
  relevo?: boolean | undefined;
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
  contacto: {
    id: string;
    nombre: string | null;
    /** Cómo se le llama de un vistazo. Puede venir unido: «+51… · @usuario». */
    handle: string | null;
    /** El de la ficha si lo hay; si no, el que dijo el canal. */
    telefono: string | null;
    /** Sin «@»: lo pone la interfaz. `null` en canales que no lo tienen. */
    usuario: string | null;
  };
  agenteId: string | null;
  noLeidos: number;
  ultimoEntranteEn: Date | null;
  ultimoSalienteEn: Date | null;
  /** Instante; la interfaz calcula el tiempo restante para pintarlo. */
  ventanaExpiraEn: Date | null;
  /**
   * Estado de atención, calculado al leer y no guardado (migración 0020). Un
   * campo mantenido a mano por el agente miente a los dos días.
   */
  atencion: EstadoDeAtencion;
  aplazadaHasta: Date | null;
  ventanaAbierta: boolean;
  etiquetas: { id: string; nombre: string; color: string | null }[];
  vistaPrevia: string | null;
  /**
   * El bot se rindió aquí y dijo por qué. `null` mientras nadie lo pida o en
   * cuanto una persona conteste: contestar ES atender el aviso.
   */
  relevo: { motivo: string; en: Date | null } | null;
}

export interface OpcionesDeBandeja {
  db: BaseDeDatos;
  canales: Map<string, Pick<ChannelAdapter, 'capacidades' | 'politicaDeVentana'>>;
  ahora?: () => Date;
}

/**
 * Tope de un cierre en bloque.
 *
 * No es una limitación técnica: es que cerrar doscientas conversaciones de un
 * clic sin querer no tiene deshacer, y reabrirlas una a una sería peor que el
 * problema que se venía a resolver.
 */
const LIMITE_DE_CIERRE = 100;

const LIMITE_POR_DEFECTO = 30;
const LIMITE_MAXIMO = 100;

export type EstadoDeAtencion =
  'nueva' | 'por_responder' | 'esperando_cliente' | 'seguimiento' | 'cerrada';

/**
 * El estado de atención, en SQL y en UN solo sitio.
 *
 * Se usa tanto para devolverlo como para filtrar por él. Dos copias —una en
 * el SELECT y otra en el WHERE— se separarían el día que alguien ajuste una
 * de las dos, y el filtro dejaría de coincidir con lo que se ve en pantalla.
 *
 * `human_reply_at` lo pone la puerta de envío cuando escribe una PERSONA: que
 * el bot haya contestado no convierte la conversación en atendida.
 */
export const ESTADO_DE_ATENCION = `CASE
  WHEN c.status = 'closed' THEN 'cerrada'
  WHEN c.snoozed_until > now() THEN 'seguimiento'
  WHEN c.human_reply_at IS NULL THEN 'nueva'
  WHEN c.last_inbound_at > COALESCE(c.last_outbound_at, '-infinity'::timestamptz)
    THEN 'por_responder'
  ELSE 'esperando_cliente'
END`;

/**
 * «Sin responder» = lo que todavía espera a una PERSONA: `nueva` (nadie del
 * equipo ha escrito nunca, aunque haya contestado el bot) o `por_responder`.
 * Lo usan el filtro de la bandeja y la tarjeta del panel, para que la cifra
 * que se pulsa sea la lista que se abre.
 *
 * Exige que el contacto haya escrito: una conversación que abrió el bot con
 * una plantilla y nadie contestó es `nueva`, pero no espera respuesta de nadie.
 */
export const SIN_RESPONDER = `(c.last_inbound_at IS NOT NULL
  AND (${ESTADO_DE_ATENCION}) IN ('nueva', 'por_responder'))`;

export interface VistaDeBandeja {
  id: string;
  nombre: string;
  filtros: Record<string, string>;
  posicion: number;
}

export interface NotaInterna {
  id: string;
  cuerpo: string;
  autorId: string | null;
  autor: string | null;
  creadaEn: Date;
}

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
    if (filtros.atencion) condiciones.push(`(${ESTADO_DE_ATENCION}) = ${p(filtros.atencion)}`);
    if (filtros.q) {
      // Dos búsquedas en una: por quién es (nombre, @ o teléfono) y por lo que
      // se dijo. El texto de los mensajes usa el índice de 0028; sin él, un
      // ILIKE sobre una tabla particionada recorrería meses enteros.
      const termino = filtros.q.trim();
      const i = p(`%${termino}%`);
      const t = p(termino);
      condiciones.push(
        `(co.display_name ILIKE ${i} OR ci.handle ILIKE ${i} OR co.phone ILIKE ${i}
          OR EXISTS (
            SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id
               AND m.search @@ websearch_to_tsquery('spanish', ${t})
          ))`,
      );
    }
    if (filtros.desde) {
      condiciones.push(
        `COALESCE(c.last_inbound_at, c.created_at) >= ${p(filtros.desde)}::timestamptz`,
      );
    }
    if (filtros.hasta) {
      condiciones.push(
        `COALESCE(c.last_inbound_at, c.created_at) < ${p(filtros.hasta)}::timestamptz`,
      );
    }
    if (filtros.etapaId) {
      condiciones.push(
        `EXISTS (SELECT 1 FROM leads l WHERE l.conversation_id = c.id AND l.stage_id = ${p(filtros.etapaId)})`,
      );
    }
    if (filtros.estado) condiciones.push(`c.status = ${p(filtros.estado)}`);
    if (filtros.agenteId) condiciones.push(`c.assignee_user_id = ${p(filtros.agenteId)}`);
    if (filtros.tipo) condiciones.push(`c.kind = ${p(filtros.tipo)}`);
    if (filtros.relevo) condiciones.push(`c.handoff_reason IS NOT NULL`);
    if (filtros.etiquetaId) {
      condiciones.push(
        `EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.conversation_id = c.id AND ct.tag_id = ${p(filtros.etiquetaId)})`,
      );
    }
    if (filtros.sinRespuesta) {
      // "Sin respuesta" se DERIVA, no se guarda: una columna booleana habría
      // que mantenerla en cada entrante y cada saliente, y el día que un
      // camino se olvide, el filtro miente sin que nadie lo note. Y se deriva
      // del estado de atención: antes contaba la respuesta del bot como
      // atendida y daba otra cifra que el panel.
      condiciones.push(SIN_RESPONDER);
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
                c.kind, c.external_thread_id, c.snoozed_until,
                ${ESTADO_DE_ATENCION} AS atencion,
                c.unread_count, c.last_inbound_at, c.last_outbound_at,
                c.session_expires_at, c.created_at,
                c.handoff_reason, c.handoff_at,
                co.id AS contact_id, co.display_name, ci.handle,
                -- Separados, no en una cadena ya unida: la interfaz los pinta
                -- en dos líneas y ofrece copiar cada uno. Unirlos aquí obliga
                -- a partir texto allí, que es adivinar.
                COALESCE(co.phone, ci.phone_e164) AS telefono,
                ci.username AS usuario,
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
                m.error, m.media_asset_id AS medio_id, ma.status AS medio_estado,
                ma.filename AS medio_nombre,
                -- Solo lo tienen las respuestas a comentarios: distingue la
                -- pública de la privada, que es de un solo uso.
                m.payload -> 'comentario' ->> 'modo' AS modo_comentario,
                m.sent_by_user_id AS autor_id, u.full_name AS autor,
                u.avatar_media_id AS autor_foto_id
           FROM messages m
           LEFT JOIN media_assets ma ON ma.id = m.media_asset_id
           -- Quién lo escribió. Se une por fuera porque lo entrante y lo que
           -- manda un bot no tienen persona detrás, y porque alguien que ya no
           -- está en el equipo no debe borrar su mensaje del hilo.
           LEFT JOIN users u ON u.id = m.sent_by_user_id
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

  /**
   * Aplaza una conversación hasta una fecha. Es el único estado de atención
   * que se guarda, porque es el único que no está en los datos: nada en la
   * conversación dice «vuelve a acordarte de esto el jueves».
   *
   * Con `null` se despierta ya. No hace falta un trabajo que las despierte:
   * el estado se calcula al listar, así que a su hora reaparece sola.
   */
  async aplazar(conversationId: string, hasta: Date | null): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      if (hasta && hasta.getTime() <= this.#ahora().getTime()) {
        throw new ErrorDeNegocio(
          'fecha_pasada',
          'Aplazar hacia atrás no aplaza nada: elige una fecha futura.',
          422,
        );
      }
      await c.query(
        `UPDATE conversations SET snoozed_until = $2, updated_at = now() WHERE id = $1`,
        [conversationId, hasta],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'conversacion.aplazada', 'conversation', $3, $4)`,
        [ctx.tenantId, ctx.userId, conversationId, JSON.stringify({ hasta })],
      );
    });
  }

  // -------------------------------------------------------------------------
  // Notas internas
  // -------------------------------------------------------------------------

  /**
   * Las notas NO son mensajes: no salen al canal, no cuentan para la ventana
   * de 24 h y no las ve el cliente. Por eso viven en su propia tabla y no en
   * `messages` con una bandera — una bandera mal leída en la puerta de envío
   * mandaría al cliente lo que el equipo dijo de él.
   */
  async notas(conversationId: string): Promise<NotaInterna[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      const { rows } = await c.query<{
        id: string;
        body: string;
        user_id: string | null;
        autor: string | null;
        created_at: Date;
      }>(
        `SELECT n.id, n.body, n.user_id, u.full_name AS autor, n.created_at
           FROM internal_notes n
           LEFT JOIN users u ON u.id = n.user_id
          WHERE n.conversation_id = $1
          ORDER BY n.created_at DESC
          LIMIT 100`,
        [conversationId],
      );
      return rows.map((r) => ({
        id: r.id,
        cuerpo: r.body,
        autorId: r.user_id,
        autor: r.autor,
        creadaEn: r.created_at,
      }));
    });
  }

  async anotar(conversationId: string, cuerpo: string): Promise<{ id: string }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirConversacion(c, conversationId);
      const id = await this.#db.nuevoId(c);
      await c.query(
        `INSERT INTO internal_notes (id, tenant_id, conversation_id, user_id, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.tenantId, conversationId, ctx.userId, cuerpo.trim()],
      );
      return { id };
    });
  }

  /** Solo el autor borra su nota; lo demás es reescribir lo que dijo otro. */
  async borrarNota(notaId: string): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(
        `DELETE FROM internal_notes WHERE id = $1 AND user_id = $2`,
        [notaId, ctx.userId],
      );
      if (rowCount === 0) {
        throw new ErrorDeNegocio('nota_no_encontrada', 'Esa nota no existe o no es tuya.', 404);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Vistas guardadas
  // -------------------------------------------------------------------------

  async vistas(): Promise<VistaDeBandeja[]> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        name: string;
        filters: Record<string, string>;
        position: number;
      }>(
        `SELECT id, name, filters, position FROM inbox_views
          WHERE user_id = $1 ORDER BY position, created_at`,
        [ctx.userId],
      );
      return rows.map((r) => ({
        id: r.id,
        nombre: r.name,
        filtros: r.filters,
        posicion: r.position,
      }));
    });
  }

  async guardarVista(nombre: string, filtros: Record<string, string>): Promise<{ id: string }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO inbox_views (id, tenant_id, user_id, name, filters, position)
           VALUES ($1, $2, $3, $4, $5,
                   COALESCE((SELECT max(position) + 1 FROM inbox_views WHERE user_id = $3), 0))
           ON CONFLICT (user_id, lower(name))
             DO UPDATE SET filters = EXCLUDED.filters, updated_at = now()
           RETURNING id`,
        [id, ctx.tenantId, ctx.userId, nombre.trim(), JSON.stringify(filtros)],
      );
      // Guardar dos veces con el mismo nombre ACTUALIZA la vista. Es lo que
      // espera quien ajusta un filtro y vuelve a pulsar «Guardar»; un error de
      // nombre repetido ahí solo obligaría a borrar y repetir.
      return { id: rows[0]?.id ?? id };
    });
  }

  async borrarVista(vistaId: string): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM inbox_views WHERE id = $1 AND user_id = $2`, [
        vistaId,
        ctx.userId,
      ]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('vista_no_encontrada', 'Esa vista no existe.', 404);
      }
    });
  }

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
            SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
                -- Cerrar devuelve el turno a los bots: el hilo ya no lo lleva
                -- nadie, y el siguiente mensaje del contacto es una consulta
                -- nueva (ver relevo.ts en packages/envio).
                human_reply_at = CASE WHEN $2 = 'closed' THEN NULL ELSE human_reply_at END,
                updated_at = now()
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

  /**
   * Cierra varias conversaciones de una vez.
   *
   * El caso real: la bandeja acumula consultas viejas que ya no van a
   * responderse —el que preguntó un precio en marzo, el que nunca contestó— y
   * cada una cuenta como «sin responder» en el panel. Cerrarlas de una en una
   * son cincuenta clics, así que no se hace, y el panel deja de significar
   * nada.
   *
   * **Todo en una transacción**: o se cierran las que se pidieron, o ninguna.
   * Media tanda cerrada obliga a adivinar por dónde iba.
   *
   * Las que ya estaban cerradas se ignoran sin ruido: quien marca cincuenta
   * filas no tiene por qué haber mirado el estado de cada una.
   */
  async cerrarVarias(ids: string[]): Promise<{ cerradas: number }> {
    const ctx = this.#exigirContexto();
    if (ids.length === 0) return { cerradas: 0 };
    if (ids.length > LIMITE_DE_CIERRE) {
      throw new ErrorDeNegocio(
        'demasiadas',
        `Se pueden cerrar hasta ${LIMITE_DE_CIERRE} a la vez.`,
        422,
      );
    }
    return this.#db.enTransaccion(async (c) => {
      // RLS filtra las de otra cuenta: lo que no se ve, no se cierra.
      const { rows } = await c.query<{ id: string }>(
        `UPDATE conversations
            SET status = 'closed', closed_at = now(),
                -- Cerrar devuelve el turno a los bots, igual que cerrar una
                -- sola: el siguiente mensaje es una consulta nueva.
                human_reply_at = NULL,
                updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status <> 'closed'
        RETURNING id`,
        [ids],
      );
      if (rows.length > 0) {
        await c.query(
          `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
           VALUES ($1, $2, 'conversacion.cerrada_en_bloque', 'conversation', NULL, $3)`,
          [ctx.tenantId, ctx.userId, JSON.stringify({ ids: rows.map((r) => r.id) })],
        );
      }
      return { cerradas: rows.length };
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

  /**
   * Etiquetas con cuánto se usan, para el apartado donde se administran.
   * Dice dónde está puesta cada una ANTES de renombrarla o borrarla: borrar
   * «VIP» sin saber que la llevan 40 huéspedes es perder información.
   */
  async etiquetasConUso(): Promise<EtiquetaConUso[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        nombre: string;
        color: string | null;
        conversaciones: string;
        clientes: string;
        leads: string;
      }>(
        `SELECT t.id, t.name AS nombre, t.color,
                (SELECT count(*) FROM conversation_tags x WHERE x.tag_id = t.id) AS conversaciones,
                (SELECT count(*) FROM contact_tags x WHERE x.tag_id = t.id) AS clientes,
                (SELECT count(*) FROM lead_tags x WHERE x.tag_id = t.id) AS leads
           FROM tags t ORDER BY lower(t.name)`,
      );
      const bots = await botsQueUsanEtiquetas(c);
      return rows.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        color: r.color,
        usos: {
          conversaciones: Number(r.conversaciones),
          clientes: Number(r.clientes),
          leads: Number(r.leads),
        },
        bots: bots.get(r.id) ?? [],
      }));
    });
  }

  /** Renombrar o recolorear: la etiqueta es la misma, así que la ven igual conversaciones, clientes y leads. */
  async editarEtiqueta(
    id: string,
    cambios: { nombre?: string | undefined; color?: string | null | undefined },
  ): Promise<void> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      try {
        const r = await c.query(
          `UPDATE tags
              SET name = COALESCE($2, name),
                  color = CASE WHEN $3::boolean THEN $4 ELSE color END
            WHERE id = $1`,
          [id, cambios.nombre ?? null, cambios.color !== undefined, cambios.color ?? null],
        );
        if (r.rowCount === 0) {
          throw new ErrorDeNegocio('etiqueta_no_encontrada', 'La etiqueta no existe.', 404);
        }
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
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'etiqueta.editada', 'tag', $3, $4)`,
        [ctx.tenantId, ctx.userId, id, JSON.stringify(cambios)],
      );
    });
  }

  /**
   * Borrar quita la etiqueta de todo lo que la lleva (las FK son CASCADE).
   * NO se deja borrar la que usa un bot en su versión vigente: el paso
   * «etiquetar» quedaría apuntando a nada. Se dice qué bots, para arreglarlo.
   */
  async borrarEtiqueta(id: string): Promise<void> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      const bots = (await botsQueUsanEtiquetas(c)).get(id) ?? [];
      if (bots.length > 0) {
        throw new ErrorDeNegocio(
          'etiqueta_en_uso_por_bot',
          `La usa ${bots.length === 1 ? 'el bot' : 'los bots'} ${bots.map((b) => `«${b}»`).join(', ')}. Quítala de ${bots.length === 1 ? 'ese bot' : 'esos bots'} antes de borrarla.`,
          409,
          { bots },
        );
      }
      const r = await c.query<{ name: string }>(`DELETE FROM tags WHERE id = $1 RETURNING name`, [
        id,
      ]);
      if (r.rowCount === 0) {
        throw new ErrorDeNegocio('etiqueta_no_encontrada', 'La etiqueta no existe.', 404);
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'etiqueta.borrada', 'tag', $3, $4)`,
        [ctx.tenantId, ctx.userId, id, JSON.stringify({ nombre: r.rows[0]!.name })],
      );
    });
  }

  #exigirGestor() {
    const ctx = this.#exigirContexto();
    if (!['owner', 'admin', 'supervisor'].includes(ctx.rol)) {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo un supervisor o administrador puede editar o borrar etiquetas.',
        403,
      );
    }
    return ctx;
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

  /**
   * Reparto automático (0026): el modo de la cuenta y quién entra. Lo pueden
   * leer todos (un agente ve si recibe); cambiarlo, propietario o administrador.
   */
  async reparto(): Promise<ConfiguracionDeReparto> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const t = await c.query<{ auto_assignment: 'off' | 'least_busy' }>(
        `SELECT auto_assignment FROM tenants WHERE id = app.current_tenant_id()`,
      );
      const { rows } = await c.query<{
        user_id: string;
        full_name: string;
        email: string;
        role: string;
        accepts_assignments: boolean;
        abiertas: string;
      }>(
        `SELECT m.user_id, u.full_name, u.email, m.role, m.accepts_assignments,
                (SELECT count(*) FROM conversations cv
                  WHERE cv.assignee_user_id = m.user_id AND cv.status <> 'closed') AS abiertas
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.status = 'active'
          ORDER BY u.full_name`,
      );
      return {
        modo: t.rows[0]?.auto_assignment ?? 'off',
        miembros: rows.map((r) => ({
          userId: r.user_id,
          nombre: r.full_name,
          email: r.email,
          rol: r.role,
          recibe: r.accepts_assignments,
          abiertas: Number(r.abiertas),
        })),
      };
    });
  }

  async guardarReparto(cambios: {
    modo?: 'off' | 'least_busy' | undefined;
    miembros?: { userId: string; recibe: boolean }[] | undefined;
  }): Promise<ConfiguracionDeReparto> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden cambiar el reparto.',
        403,
      );
    }
    await this.#db.enTransaccion(async (c) => {
      if (cambios.modo) {
        await c.query(`UPDATE tenants SET auto_assignment = $2, updated_at = now() WHERE id = $1`, [
          ctx.tenantId,
          cambios.modo,
        ]);
      }
      for (const m of cambios.miembros ?? []) {
        await c.query(
          `UPDATE memberships SET accepts_assignments = $2, updated_at = now() WHERE user_id = $1`,
          [m.userId, m.recibe],
        );
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'cuenta.reparto', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify(cambios)],
      );
    });
    return this.reparto();
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
  telefono: string | null;
  usuario: string | null;
  etiquetas: { id: string; nombre: string; color: string | null }[];
  vista_previa: string | null;
  atencion: EstadoDeAtencion;
  snoozed_until: Date | null;
  handoff_reason: string | null;
  handoff_at: Date | null;
}

export interface MensajeDeConversacion {
  id: string;
  direccion: 'inbound' | 'outbound';
  tipo: string;
  texto: string | null;
  estado: string;
  origen: string;
  generado_por_ia: boolean;
  /** Quién lo escribió, si fue una persona. `null` para entrantes y bots. */
  autor_id: string | null;
  autor: string | null;
  /** Foto del agente que lo escribió, para reconocerlo de un vistazo. */
  autor_foto_id: string | null;
  creado_en: Date;
  error: unknown;
  /** Medio propio; la URL se pide aparte en GET /v1/medios/:id/url. */
  medio_id: string | null;
  medio_estado: string | null;
  /** Cómo se llama el fichero. Solo los documentos suelen traerlo. */
  medio_nombre: string | null;
  /** `publica` o `privada` en una respuesta a comentario; `null` en el resto. */
  modo_comentario: string | null;
}

function aResumen(f: FilaResumen, ahora: Date): ResumenDeConversacion {
  return {
    id: f.id,
    canal: f.canal,
    estado: f.estado,
    tipo: f.kind,
    publicacionId: f.external_thread_id,
    contacto: {
      id: f.contact_id,
      nombre: f.display_name,
      handle: f.handle,
      telefono: f.telefono,
      usuario: f.usuario,
    },
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
    atencion: f.atencion,
    aplazadaHasta: f.snoozed_until,
    relevo: f.handoff_reason ? { motivo: f.handoff_reason, en: f.handoff_at } : null,
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

export interface EtiquetaConUso {
  id: string;
  nombre: string;
  color: string | null;
  usos: { conversaciones: number; clientes: number; leads: number };
  /** Bots cuya versión vigente tiene un paso «etiquetar» con esta etiqueta. */
  bots: string[];
}

/** Etiqueta → nombres de los bots que la usan en su versión vigente. */
async function botsQueUsanEtiquetas(c: PoolClient): Promise<Map<string, string[]>> {
  const { rows } = await c.query<{ tag_id: string; name: string }>(
    `SELECT DISTINCT n ->> 'etiquetaId' AS tag_id, f.name
       FROM flows f
       JOIN flow_versions v ON v.id = f.current_version_id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.graph -> 'nodos', '[]'::jsonb)) AS n
      WHERE n ->> 'tipo' = 'etiquetar'`,
  );
  const mapa = new Map<string, string[]>();
  for (const r of rows) mapa.set(r.tag_id, [...(mapa.get(r.tag_id) ?? []), r.name]);
  return mapa;
}

export interface ConfiguracionDeReparto {
  modo: 'off' | 'least_busy';
  miembros: {
    userId: string;
    nombre: string;
    email: string;
    rol: string;
    /** Entra en el reparto automático. */
    recibe: boolean;
    /** Conversaciones abiertas asignadas ahora: lo que decide a quién le toca. */
    abiertas: number;
  }[];
}
