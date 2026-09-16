/**
 * Procesamiento de un webhook ya persistido.
 *
 * El camino HTTP (apps/api) solo valida, guarda el crudo y encola. Todo lo que
 * cuesta —deduplicar, resolver contacto, abrir conversación, recalcular la
 * ventana— ocurre aquí, en el worker, donde una consulta lenta no provoca
 * reintentos de Meta.
 *
 * Toda la función corre en UNA transacción bajo el inquilino del evento. Si
 * algo falla a mitad, no queda un mensaje sin conversación ni una identidad
 * sin contacto: o entra todo o no entra nada, y el evento queda marcado como
 * fallido con su error para reintentarlo.
 */
import type { Pool, PoolClient } from 'pg';
import { registrarUso, withTenant } from '@crmapp/db';
import { asegurarLead } from './leads.js';
import { repartirSiToca } from './reparto.js';
import { avisarSiEstaCerrado } from './fuera-de-horario.js';
import {
  capacidades,
  expiracionTrasMensaje,
  type PoliticaDeVentana,
  type Suscripcion,
} from '@crmapp/core';
import type {
  AdaptadorDeIngesta,
  ChannelAdapter,
  EventoDeComentario,
  EventoDeEstado,
  EventoDeMensaje,
  EventoDePlantilla,
  EventoEntrante,
} from '@crmapp/channels';
import { escribirEnOutbox } from '@crmapp/queue';

export interface Dependencias {
  pool: Pool;
  ingesta: Map<string, AdaptadorDeIngesta>;
  /**
   * Para la política de ventana y, en el aviso de fuera de horario, para las
   * capacidades del canal. Se pregunta, no se asume (ARCH §8).
   */
  canales: Map<string, Pick<ChannelAdapter, 'politicaDeVentana' | 'capacidades'>>;
  ahora?: () => Date;
}

export interface ResultadoDeProcesamiento {
  mensajesNuevos: number;
  /** Comentarios públicos nuevos (Instagram): abren o continúan un hilo `comment_thread`. */
  comentariosNuevos: number;
  duplicados: number;
  /** Avisos automáticos de «estamos cerrados» enviados (0027). */
  avisosFueraDeHorario: number;
  estadosAplicados: number;
  /** Cambios de estado de plantillas HSM reflejados desde Meta. */
  plantillasActualizadas: number;
  ignorados: number;
  /** `true` si la cuenta está suspendida y el crudo se guardó sin mostrarse. */
  omitidoPorSuspension: boolean;
}

interface FilaEntrante {
  id: string;
  tenant_id: string;
  channel: string;
  channel_account_id: string;
  raw: unknown;
  status: string;
  attempts: number;
}

/** Orden de los estados de entrega. Un estado nunca retrocede. */
const ORDEN_ESTADO: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

export async function procesarEventoEntrante(
  deps: Dependencias,
  tenantId: string,
  inboundEventId: string,
): Promise<ResultadoDeProcesamiento> {
  const ahora = deps.ahora ?? (() => new Date());

  return withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<FilaEntrante>(
      `SELECT id, tenant_id, channel, channel_account_id, raw, status, attempts
         FROM inbound_events
        WHERE id = $1
        FOR UPDATE`,
      [inboundEventId],
    );
    const fila = rows[0];
    if (!fila)
      throw new Error(`inbound_event ${inboundEventId} no existe o no pertenece al inquilino.`);

    const resultado: ResultadoDeProcesamiento = {
      mensajesNuevos: 0,
      comentariosNuevos: 0,
      duplicados: 0,
      estadosAplicados: 0,
      plantillasActualizadas: 0,
      avisosFueraDeHorario: 0,
      ignorados: 0,
      omitidoPorSuspension: false,
    };

    // Reprocesar un evento ya procesado es un no-op. Ocurre: el relay entrega
    // al menos una vez, y un job puede correr dos veces.
    if (fila.status === 'processed') return resultado;

    // Si algo de aqui abajo lanza, withTenant hace ROLLBACK y no queda nada a
    // medias. La marca de fallo NO puede escribirse dentro de esta transaccion
    // —el rollback se la llevaria—, por eso existe `marcarFallo` aparte.

    // ---------------------------------------------------------------------
    // Suspensión: el crudo ya está guardado; no se muestra nada.
    // ---------------------------------------------------------------------
    const suscripcion = await leerSuscripcion(c, tenantId);
    if (suscripcion && !capacidades(suscripcion, ahora()).muestraEntrantes) {
      await marcar(c, fila.id, 'processed', { motivo: 'cuenta_suspendida' });
      resultado.omitidoPorSuspension = true;
      return resultado;
    }

    const ingesta = deps.ingesta.get(fila.channel);
    const canal = deps.canales.get(fila.channel);
    if (!ingesta || !canal) throw new Error(`Sin adaptador para el canal "${fila.channel}".`);

    const eventos = ingesta.parsearEventos(fila.raw);
    const politica = canal.politicaDeVentana();

    for (const evento of eventos) {
      if (evento.clase === 'mensaje') {
        const nuevo = await procesarMensaje(c, fila, evento, politica, ahora());
        if (nuevo) {
          resultado.mensajesNuevos += 1;
          // Aviso de «estamos cerrados», si el hotel lo tiene encendido. Va
          // después de guardar el mensaje: primero se registra lo del cliente.
          const avisado = await avisarSiEstaCerrado(
            c,
            { canales: deps.canales, ...(deps.ahora ? { ahora: deps.ahora } : {}) },
            { tenantId, conversationId: nuevo.conversationId, ahora: ahora() },
          );
          if (avisado) resultado.avisosFueraDeHorario += 1;
        } else resultado.duplicados += 1;
      } else if (evento.clase === 'estado') {
        const aplicado = await procesarEstado(c, fila, evento);
        if (aplicado) resultado.estadosAplicados += 1;
        else resultado.ignorados += 1;
      } else if (evento.clase === 'plantilla') {
        await procesarPlantilla(c, fila, evento, ahora());
        resultado.plantillasActualizadas += 1;
      } else if (evento.clase === 'comentario') {
        const nuevo = await procesarComentario(c, fila, evento, ahora());
        if (nuevo) resultado.comentariosNuevos += 1;
        else resultado.duplicados += 1;
      } else {
        resultado.ignorados += 1;
      }
    }

    await marcar(c, fila.id, 'processed', null);
    return resultado;
  });
}

/** Marca el evento como fallido en una transacción propia, tras un rollback. */
export async function marcarFallo(
  pool: Pool,
  tenantId: string,
  inboundEventId: string,
  error: unknown,
): Promise<void> {
  await withTenant(pool, tenantId, async (c) => {
    await c.query(
      `UPDATE inbound_events
          SET status = 'failed', attempts = attempts + 1, error = $2
        WHERE id = $1`,
      [inboundEventId, JSON.stringify({ mensaje: (error as Error).message?.slice(0, 1000) })],
    );
  });
}

// ---------------------------------------------------------------------------

async function leerSuscripcion(c: PoolClient, tenantId: string): Promise<Suscripcion | null> {
  const { rows } = await c.query<{
    status: Suscripcion['estadoDeclarado'];
    trial_ends_at: Date | null;
    current_period_ends_at: Date | null;
    grace_days: number;
  }>(
    `SELECT status, trial_ends_at, current_period_ends_at, grace_days
       FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  const s = rows[0];
  if (!s) return null;
  return {
    estadoDeclarado: s.status,
    pruebaHasta: s.trial_ends_at,
    periodoHasta: s.current_period_ends_at,
    diasDeGracia: s.grace_days,
  };
}

async function marcar(
  c: PoolClient,
  id: string,
  status: 'processed' | 'failed' | 'anomaly',
  detalle: unknown,
): Promise<void> {
  await c.query(
    `UPDATE inbound_events SET status = $2, processed_at = now(), error = $3 WHERE id = $1`,
    [id, status, detalle === null ? null : JSON.stringify(detalle)],
  );
}

async function nuevoId(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>('SELECT uuidv7() AS id');
  return rows[0]!.id;
}

/**
 * Procesa un mensaje entrante. Devuelve `false` si era un duplicado.
 *
 * El orden importa: la clave de idempotencia se reserva ANTES de crear nada.
 * Si se creara el mensaje primero y la clave después, dos entregas simultáneas
 * del mismo webhook pasarían las dos el `SELECT` y crearían dos mensajes.
 */
async function procesarMensaje(
  c: PoolClient,
  fila: FilaEntrante,
  evento: EventoDeMensaje,
  politica: PoliticaDeVentana,
  ahora: Date,
): Promise<{ conversationId: string } | null> {
  const messageId = await nuevoId(c);

  // `created_at` es el momento de RECEPCIÓN, no el del proveedor. El
  // particionado va por created_at y solo existen particiones alrededor de
  // hoy; un timestamp del proveedor de hace dos meses —pasa con reprocesos y
  // con relojes mal puestos— caería fuera y la inserción fallaría. La fecha
  // del proveedor se conserva en el payload.
  const createdAt = ahora;

  const reserva = await c.query(
    `INSERT INTO message_keys
       (tenant_id, channel_account_id, external_message_id, message_id, message_created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_account_id, external_message_id) DO NOTHING`,
    [fila.tenant_id, fila.channel_account_id, evento.externalMessageId, messageId, createdAt],
  );
  if (reserva.rowCount === 0) return null; // duplicado: gana el primero (ARCH §7)

  const contacto = await resolverIdentidad(c, fila, evento);
  const conversacion = await resolverConversacion(c, fila, contacto);

  // Medio entrante: se registra `pending` en la misma transacción que el
  // mensaje y la descarga va por el outbox (ARCH §12). La URL de WhatsApp
  // caduca pronto; esperar a que alguien abra la conversación es perderla.
  const mediaAssetId = evento.mediaId && esTipoDeMedio(evento.tipo) ? await nuevoId(c) : null;
  if (mediaAssetId) {
    await c.query(
      `INSERT INTO media_assets (id, tenant_id, kind, status) VALUES ($1, $2, $3, 'pending')`,
      [mediaAssetId, fila.tenant_id, evento.tipo],
    );
  }

  await c.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, channel_account_id, direction, type, body, payload,
        external_message_id, status, sent_by, created_at, media_asset_id)
     VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, $8, 'delivered', 'human', $9, $10)`,
    [
      messageId,
      fila.tenant_id,
      conversacion.id,
      fila.channel_account_id,
      evento.tipo,
      evento.texto ?? null,
      JSON.stringify({
        proveedor: { ocurridoEn: evento.ocurridoEn.toISOString(), mediaId: evento.mediaId ?? null },
        entradaGratuita: evento.entradaGratuita ?? false,
        respondeA: evento.respondeA ?? null,
      }),
      evento.externalMessageId,
      createdAt,
      mediaAssetId,
    ],
  );

  // Medición (ARCH §5.9): en la misma transacción que el hecho. Una
  // conversación cuenta como abierta cuando se crea o cuando un entrante la
  // reabre desde `closed`; un contacto que sigue escribiendo no suma.
  await registrarUso(c, {
    tenantId: fila.tenant_id,
    metric: 'messages.inbound',
    dedupKey: `message:${messageId}:inbound`,
    occurredAt: createdAt,
    meta: { channel: fila.channel, type: evento.tipo },
  });
  if (conversacion.status === 'nueva' || conversacion.status === 'closed') {
    await registrarUso(c, {
      tenantId: fila.tenant_id,
      metric: 'conversations.opened',
      dedupKey: `conversation:${conversacion.id}:opened:${messageId}`,
      occurredAt: createdAt,
      meta: { channel: fila.channel, reabierta: conversacion.status === 'closed' },
    });
    // Y con ella, el lead: la columna «Leads entrantes» del tablero se llena
    // con lo que entra por los canales, no a mano. La regla de cuándo se abre
    // uno nuevo vive en `leads.ts`, en esta misma transacción.
    const { rows: quien } = await c.query<{ display_name: string | null }>(
      `SELECT display_name FROM contacts WHERE id = $1`,
      [contacto.contactId],
    );
    await asegurarLead(c, {
      tenantId: fila.tenant_id,
      contactId: contacto.contactId,
      conversationId: conversacion.id,
      texto: evento.texto ?? null,
      nombreDelContacto: quien[0]?.display_name ?? null,
    });
    // Reparto automático (0026), en la misma transacción. Apagado por
    // defecto: si la cuenta no lo usa, no hace nada.
    await repartirSiToca(c, conversacion.id);
  }

  if (mediaAssetId) {
    await escribirEnOutbox(c, {
      tenantId: fila.tenant_id,
      aggregateType: 'media_asset',
      aggregateId: mediaAssetId,
      eventType: 'media.descargar',
      payload: {
        mediaAssetId,
        messageId,
        channelAccountId: fila.channel_account_id,
        canal: fila.channel,
        mediaId: evento.mediaId,
      },
    });
  }

  // La ventana la reinicia el ENTRANTE. Lo calcula core con la política que
  // declara el adaptador; el worker no sabe que WhatsApp usa 24 horas.
  const expiracion = expiracionTrasMensaje(
    politica,
    'inbound',
    createdAt,
    conversacion.session_expires_at,
    evento.entradaGratuita ? 'entrada_gratuita' : 'mensaje',
  );

  await c.query(
    `UPDATE conversations
        SET last_inbound_at = $2,
            session_expires_at = $3,
            unread_count = unread_count + 1,
            status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [conversacion.id, createdAt, expiracion],
  );

  await escribirEnOutbox(c, {
    tenantId: fila.tenant_id,
    aggregateType: 'message',
    aggregateId: messageId,
    eventType: 'mensaje.recibido',
    payload: {
      conversationId: conversacion.id,
      tipo: evento.tipo,
      mediaId: evento.mediaId ?? null,
    },
  });

  return { conversationId: conversacion.id };
}

interface Identidad {
  identityId: string;
  contactId: string;
}

/**
 * Un comentario público es un mensaje en un hilo `comment_thread` que cuelga
 * de la publicación (`external_thread_id` = id del post) y del contacto. No
 * abre ventana de sesión: la respuesta libre no existe; lo que existe es
 * responder al comentario, en público o en privado (una vez), y eso lo pide
 * la API con `comment_reply` sin pasar por la ventana.
 */
async function procesarComentario(
  c: PoolClient,
  fila: FilaEntrante,
  evento: EventoDeComentario,
  ahora: Date,
): Promise<boolean> {
  const messageId = await nuevoId(c);
  const reserva = await c.query(
    `INSERT INTO message_keys
       (tenant_id, channel_account_id, external_message_id, message_id, message_created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_account_id, external_message_id) DO NOTHING`,
    [fila.tenant_id, fila.channel_account_id, evento.externalCommentId, messageId, ahora],
  );
  if (reserva.rowCount === 0) return false;

  const contacto = await resolverIdentidad(c, fila, {
    clase: 'mensaje',
    canal: evento.canal,
    externalAccountId: evento.externalAccountId,
    ocurridoEn: evento.ocurridoEn,
    externalMessageId: evento.externalCommentId,
    externalUserId: evento.externalUserId,
    nombreDeContacto: evento.nombreDeUsuario,
    tipo: 'text',
  });

  const hilo = await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM conversations
      WHERE contact_identity_id = $1 AND kind = 'comment_thread' AND external_thread_id = $2
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE`,
    [contacto.identityId, evento.externalPostId],
  );
  let conversationId = hilo.rows[0]?.id ?? null;
  const estabaCerrado = hilo.rows[0]?.status === 'closed';
  if (!conversationId) {
    conversationId = await nuevoId(c);
    await c.query(
      `INSERT INTO conversations
         (id, tenant_id, contact_identity_id, contact_id, channel_account_id, kind, status, external_thread_id)
       VALUES ($1, $2, $3, $4, $5, 'comment_thread', 'open', $6)`,
      [
        conversationId,
        fila.tenant_id,
        contacto.identityId,
        contacto.contactId,
        fila.channel_account_id,
        evento.externalPostId,
      ],
    );
  }

  await c.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, channel_account_id, direction, type, body, payload,
        external_message_id, status, sent_by, created_at)
     VALUES ($1, $2, $3, $4, 'inbound', 'text', $5, $6, $7, 'delivered', 'human', $8)`,
    [
      messageId,
      fila.tenant_id,
      conversationId,
      fila.channel_account_id,
      evento.texto,
      JSON.stringify({
        comentario: {
          id: evento.externalCommentId,
          postId: evento.externalPostId,
          parentId: evento.respondeAComentario ?? null,
        },
        proveedor: { ocurridoEn: evento.ocurridoEn.toISOString() },
      }),
      evento.externalCommentId,
      ahora,
    ],
  );
  await c.query(
    `UPDATE conversations
        SET last_inbound_at = $2,
            unread_count = unread_count + 1,
            status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [conversationId, ahora],
  );

  await registrarUso(c, {
    tenantId: fila.tenant_id,
    metric: 'messages.inbound',
    dedupKey: `message:${messageId}:inbound`,
    occurredAt: ahora,
    meta: { channel: fila.channel, type: 'comment' },
  });
  if (!hilo.rows[0] || estabaCerrado) {
    await registrarUso(c, {
      tenantId: fila.tenant_id,
      metric: 'conversations.opened',
      dedupKey: `conversation:${conversationId}:opened:${messageId}`,
      occurredAt: ahora,
      meta: { channel: fila.channel, kind: 'comment_thread', reabierta: estabaCerrado },
    });
  }
  await escribirEnOutbox(c, {
    tenantId: fila.tenant_id,
    aggregateType: 'message',
    aggregateId: messageId,
    eventType: 'comentario.recibido',
    payload: {
      conversationId,
      postId: evento.externalPostId,
      comentarioId: evento.externalCommentId,
    },
  });
  return true;
}

/**
 * Identificador PÚBLICO del contacto en su canal, que es lo que la bandeja
 * pinta bajo el nombre. En WhatsApp es el teléfono; en Instagram, el @usuario.
 * No es el nombre de perfil: llegó un contacto real cuyo perfil se llamaba
 * «.» y la bandeja no decía a quién se estaba escribiendo.
 */
function handleDe(evento: EventoDeMensaje): string | null {
  if (evento.canal === 'whatsapp') {
    // Con nombres de usuario de WhatsApp puede haber número, @usuario o los
    // dos. El BSUID no se enseña nunca: no le dice nada a una persona.
    const usuario = evento.nombreDeUsuario ? `@${evento.nombreDeUsuario}` : null;
    if (evento.telefonoE164 && usuario) return `${evento.telefonoE164} · ${usuario}`;
    return evento.telefonoE164 ?? usuario ?? 'Usuario de WhatsApp';
  }
  // Messenger no manda el nombre en el webhook, solo el PSID, que no le dice
  // nada a nadie. El agente puede ponerle nombre desde la ficha.
  if (evento.canal === 'facebook') return evento.nombreDeContacto ?? 'Usuario de Messenger';
  return evento.nombreDeContacto ?? evento.externalUserId;
}

const TIPOS_DE_MEDIO = new Set(['image', 'video', 'audio', 'document', 'sticker']);
function esTipoDeMedio(tipo: string): tipo is 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  return TIPOS_DE_MEDIO.has(tipo);
}

/**
 * Resuelve la identidad del canal y, si es nueva, crea la persona (ADR-007).
 *
 * La identidad es el hecho del proveedor; la persona es interpretación
 * nuestra. Nunca se fusiona automáticamente por nombre: una identidad nueva
 * es un contacto nuevo hasta que alguien —o la regla de teléfono verificado
 * de P-08— diga lo contrario.
 */
async function resolverIdentidad(
  c: PoolClient,
  fila: FilaEntrante,
  evento: EventoDeMensaje,
): Promise<Identidad> {
  // Primero por BSUID, que llega siempre; después por la clave de siempre (el
  // número). Así la misma persona se reconoce aunque hoy escriba con número y
  // mañana solo con su nombre de usuario, o al revés.
  const existente = await c.query<{
    id: string;
    contact_id: string;
    phone_e164: string | null;
    username: string | null;
  }>(
    `SELECT id, contact_id, phone_e164, username FROM contact_identities
      WHERE channel_account_id = $1
        AND (($3::text IS NOT NULL AND provider_user_id = $3) OR external_user_id = $2)
      ORDER BY (provider_user_id IS NOT DISTINCT FROM $3) DESC
      LIMIT 1`,
    [fila.channel_account_id, evento.externalUserId, evento.idDeUsuarioDelProveedor ?? null],
  );
  if (existente.rows[0]) {
    // Se refresca el perfil sin tocar el contacto: el nombre de WhatsApp
    // cambia, la persona no. Tampoco se toca `contacts.display_name`: si un
    // agente renombró al contacto, su nombre manda.
    if (evento.nombreDeContacto || evento.idDeUsuarioDelProveedor || evento.nombreDeUsuario) {
      await c.query(
        `UPDATE contact_identities
            SET handle = $2,
                phone_e164 = COALESCE($3, phone_e164),
                provider_user_id = COALESCE($4, provider_user_id),
                username = COALESCE($5, username),
                updated_at = now()
          WHERE id = $1`,
        [
          existente.rows[0].id,
          // Lo que ya se sabía no se olvida porque hoy no venga: sin esto, el
          // número desaparecía de la bandeja al llegar un mensaje sin él.
          handleDe({
            ...evento,
            telefonoE164: evento.telefonoE164 ?? existente.rows[0].phone_e164 ?? undefined,
            nombreDeUsuario: evento.nombreDeUsuario ?? existente.rows[0].username ?? undefined,
          }),
          evento.telefonoE164 ?? null,
          evento.idDeUsuarioDelProveedor ?? null,
          evento.nombreDeUsuario ?? null,
        ],
      );
    }
    return { identityId: existente.rows[0].id, contactId: existente.rows[0].contact_id };
  }

  const contactId = await nuevoId(c);
  await c.query(`INSERT INTO contacts (id, tenant_id, display_name) VALUES ($1, $2, $3)`, [
    contactId,
    fila.tenant_id,
    evento.nombreDeContacto ??
      (evento.nombreDeUsuario ? `@${evento.nombreDeUsuario}` : null) ??
      evento.telefonoE164 ??
      (evento.canal === 'facebook' ? null : evento.externalUserId),
  ]);

  const identityId = await nuevoId(c);
  await c.query(
    `INSERT INTO contact_identities
       (id, tenant_id, contact_id, channel, channel_account_id, external_user_id, handle, phone_e164,
        provider_user_id, username)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      identityId,
      fila.tenant_id,
      contactId,
      fila.channel,
      fila.channel_account_id,
      evento.externalUserId,
      handleDe(evento),
      evento.telefonoE164 ?? null,
      evento.idDeUsuarioDelProveedor ?? null,
      evento.nombreDeUsuario ?? null,
    ],
  );
  return { identityId, contactId };
}

interface Conversacion {
  id: string;
  session_expires_at: Date | null;
  /** Estado ANTES de este mensaje; `nueva` si se acaba de crear. */
  status: string;
}

/** Devuelve la conversación abierta de la identidad, o crea una. */
async function resolverConversacion(
  c: PoolClient,
  fila: FilaEntrante,
  identidad: Identidad,
): Promise<Conversacion> {
  const abierta = await c.query<Conversacion>(
    `SELECT id, session_expires_at, status FROM conversations
      WHERE contact_identity_id = $1 AND status <> 'closed'
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE`,
    [identidad.identityId],
  );
  if (abierta.rows[0]) return abierta.rows[0];

  // Si no hay abierta se reabre la última cerrada en vez de crear otra: el
  // historial del contacto sigue siendo un solo hilo, que es lo que un agente
  // espera ver.
  const cerrada = await c.query<Conversacion>(
    `SELECT id, session_expires_at, status FROM conversations
      WHERE contact_identity_id = $1
      ORDER BY created_at DESC LIMIT 1
      FOR UPDATE`,
    [identidad.identityId],
  );
  if (cerrada.rows[0]) return cerrada.rows[0];

  const id = await nuevoId(c);
  await c.query(
    `INSERT INTO conversations
       (id, tenant_id, contact_identity_id, contact_id, channel_account_id, kind, status)
     VALUES ($1, $2, $3, $4, $5, 'dm', 'open')`,
    [id, fila.tenant_id, identidad.identityId, identidad.contactId, fila.channel_account_id],
  );
  return { id, session_expires_at: null, status: 'nueva' };
}

/**
 * Aplica un cambio de estado de entrega. Devuelve `false` si se ignoró.
 *
 * Los webhooks de estado llegan desordenados: es normal recibir `delivered`
 * antes que `sent`. Un estado nunca retrocede; `failed` se acepta siempre.
 */
/**
 * Estado de una plantilla HSM, fijado por Meta (ARCH §3: se sincroniza, no se
 * asume). La plantilla pertenece a la WABA, no al número: se aplica a todas
 * las cuentas del inquilino con ese `provider_account_id`. Una plantilla que
 * no conocíamos —creada en el panel de Meta— se registra para que el CRM se
 * entere sin esperar a la siguiente sincronización.
 */
async function procesarPlantilla(
  c: PoolClient,
  fila: FilaEntrante,
  evento: EventoDePlantilla,
  ahora: Date,
): Promise<void> {
  const motivo = evento.estado === 'rechazada' ? (evento.motivoDeRechazo ?? null) : null;
  const r = await c.query<{ id: string; current_version_id: string | null }>(
    `UPDATE wa_templates t
        SET status = $3,
            rejection_reason = CASE WHEN $3 = 'rechazada' THEN COALESCE($4, t.rejection_reason) ELSE NULL END,
            category_effective = COALESCE($5, t.category_effective),
            last_synced_at = $6, updated_at = now()
       FROM channel_accounts ca
      WHERE ca.id = t.channel_account_id
        AND (ca.provider_account_id = $7 OR ca.id = $8)
        AND t.name = $1 AND t.language = $2
      RETURNING t.id, t.current_version_id`,
    [
      evento.nombre,
      evento.idioma,
      evento.estado,
      motivo,
      evento.categoriaEfectiva ?? null,
      ahora,
      evento.externalAccountId,
      fila.channel_account_id,
    ],
  );

  if ((r.rowCount ?? 0) === 0) {
    const id = await nuevoId(c);
    const versionId = await nuevoId(c);
    await c.query(
      `INSERT INTO wa_templates
         (id, tenant_id, channel_account_id, name, language, status, rejection_reason,
          category_effective, last_synced_at, current_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        fila.tenant_id,
        fila.channel_account_id,
        evento.nombre,
        evento.idioma,
        evento.estado,
        motivo,
        evento.categoriaEfectiva ?? null,
        ahora,
        versionId,
      ],
    );
    await c.query(
      `INSERT INTO wa_template_versions (id, tenant_id, template_id, version, status, rejection_reason, reviewed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6)`,
      [versionId, fila.tenant_id, id, evento.estado, motivo, ahora],
    );
  } else {
    const versiones = r.rows.map((f) => f.current_version_id).filter((v): v is string => !!v);
    if (versiones.length > 0) {
      await c.query(
        `UPDATE wa_template_versions SET status = $2, rejection_reason = $3, reviewed_at = $4
          WHERE id = ANY($1::uuid[])`,
        [versiones, evento.estado, motivo, ahora],
      );
    }
  }

  await escribirEnOutbox(c, {
    tenantId: fila.tenant_id,
    aggregateType: 'wa_template',
    aggregateId: r.rows[0]?.id ?? fila.channel_account_id,
    eventType: 'plantilla.actualizada',
    payload: {
      nombre: evento.nombre,
      idioma: evento.idioma,
      estado: evento.estado,
      motivoDeRechazo: motivo,
    },
  });
}

async function procesarEstado(
  c: PoolClient,
  fila: FilaEntrante,
  evento: EventoDeEstado,
): Promise<boolean> {
  const clave = await c.query<{ message_id: string; message_created_at: Date }>(
    `SELECT message_id, message_created_at FROM message_keys
      WHERE channel_account_id = $1 AND external_message_id = $2`,
    [fila.channel_account_id, evento.externalMessageId],
  );
  const k = clave.rows[0];
  // Estado de un mensaje que no conocemos: puede ser de antes de conectar la
  // cuenta. Se ignora, no se falla.
  if (!k) return false;

  // Filtrar por created_at además de id permite el pruning de particiones:
  // sin él, PostgreSQL recorrería todas las particiones de messages.
  const actual = await c.query<{ status: string }>(
    `SELECT status FROM messages WHERE created_at = $1 AND id = $2 FOR UPDATE`,
    [k.message_created_at, k.message_id],
  );
  const estadoActual = actual.rows[0]?.status;
  if (!estadoActual) return false;

  const avanza =
    evento.estado === 'failed' ||
    (ORDEN_ESTADO[evento.estado] ?? -1) > (ORDEN_ESTADO[estadoActual] ?? -1);
  if (!avanza) return false;

  await c.query(`UPDATE messages SET status = $3, error = $4 WHERE created_at = $1 AND id = $2`, [
    k.message_created_at,
    k.message_id,
    evento.estado,
    evento.error ? JSON.stringify(evento.error) : null,
  ]);
  return true;
}

/** Tipo exportado para el bootstrap; evita importar el union completo allí. */
export type { EventoEntrante };
