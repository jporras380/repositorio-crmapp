/**
 * La puerta de envío (ARCH §9).
 *
 * Un mensaje sale de este sistema por un solo sitio, y este es el sitio.
 * Atraviesa una puerta con orden fijo: estado de la suscripción → estado de la
 * conversación → ventana de sesión → capacidades del canal → cola de salida.
 * Cada paso devuelve un error TIPADO con lo que quien llama necesita para
 * explicarlo; un «no se puede» sin motivo es un ticket de soporte.
 *
 * **Por qué es un paquete y no un método de la API.** Vivía dentro de
 * `BandejaService`, que es una clase de NestJS: mientras el único remitente
 * fue un agente humano pulsando «Enviar», daba igual. Con los Salesbots
 * aparece un segundo remitente que corre en el worker, y con la fase 5
 * aparecerá un tercero. Copiar la puerta habría sido copiar la regla de la
 * ventana de 24 h y la de la suscripción: el día que una de las dos copias se
 * corrija y la otra no, el bot manda mensajes que le cuestan dinero al cliente
 * —o peor, que Meta cuenta como fuera de política— sin que nadie lo vea.
 *
 * Aquí no se envía nada: se inserta el mensaje en `queued` y se escribe el
 * evento en el outbox. El worker lo entrega. Así una caída del proveedor no
 * bloquea la petición, y el mensaje queda en la base aunque el proceso muera
 * un instante después.
 */
import type { PoolClient } from 'pg';
import {
  ErrorDeNegocio,
  evaluarEnvio,
  expiracionTrasMensaje,
  ventanaAbierta,
  type Suscripcion,
  type TipoDeEnvio,
} from '@crmapp/core';
import {
  validarContraCapacidades,
  type ChannelAdapter,
  type TipoDeMensaje,
} from '@crmapp/channels';
import { escribirEnOutbox } from '@crmapp/queue';
import {
  peticionParaEnvio,
  type MensajeEncolado,
  type PeticionDeEnvio,
  type PeticionEfectiva,
} from './peticion.js';
import {
  exigirPlantillaAprobada,
  plantillasAprobadas,
  versionActualDeRapida,
} from './plantillas.js';

/** Lo mínimo que la puerta necesita saber de la conversación. */
export interface ConversacionParaEnvio {
  id: string;
  status: string;
  session_expires_at: Date | null;
  channel_account_id: string;
  channel: string;
  external_user_id: string;
}

/**
 * Quién envía.
 *
 * `origen` no es decorativo: `core` lo usa para decidir si una suscripción en
 * gracia puede seguir ejecutando bots o IA, y queda en `messages.sent_by`,
 * que es lo que permite responder a «¿esto lo dijo una persona?».
 */
export interface Remitente {
  tenantId: string;
  origen: 'human' | 'bot' | 'ai';
  /** El agente que pulsó enviar. `null` cuando envía un bot o la IA. */
  userId: string | null;
}

export interface DependenciasDeEnvio {
  /** Se pregunta al canal, no se asume (ARCH §8). */
  canales: Map<string, Pick<ChannelAdapter, 'capacidades' | 'politicaDeVentana'>>;
  ahora?: () => Date;
}

export async function nuevoId(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>('SELECT uuidv7() AS id');
  return rows[0]!.id;
}

/**
 * Carga la conversación con lo que la puerta necesita.
 *
 * **Sin regla de visibilidad**: eso es cosa de quien llama, porque depende del
 * usuario que pide (ADR-008) y un bot no es un usuario. La API comprueba la
 * visibilidad antes; el worker no tiene a quién comprobársela.
 */
export async function cargarConversacionParaEnvio(
  c: PoolClient,
  conversationId: string,
  opciones: { bloquear?: boolean } = {},
): Promise<ConversacionParaEnvio> {
  const { rows } = await c.query<ConversacionParaEnvio>(
    `SELECT c.id, c.status, c.session_expires_at, c.channel_account_id, ca.channel,
            ci.external_user_id
       FROM conversations c
       JOIN channel_accounts ca ON ca.id = c.channel_account_id
       JOIN contact_identities ci ON ci.id = c.contact_identity_id
      WHERE c.id = $1 ${opciones.bloquear ? 'FOR UPDATE OF c' : ''}`,
    [conversationId],
  );
  const fila = rows[0];
  // RLS ya filtra por inquilino: una conversación ajena simplemente no existe
  // desde aquí, y se responde igual que a una inexistente.
  if (!fila) {
    throw new ErrorDeNegocio('conversacion_no_encontrada', 'La conversación no existe.', 404);
  }
  return fila;
}

/**
 * Encola un mensaje saliente para una conversación ya cargada.
 *
 * Debe llamarse DENTRO de una transacción con el inquilino puesto
 * (`SET LOCAL app.tenant_id`, ADR-005): el mensaje, la ventana recalculada y
 * el evento del outbox entran juntos o no entra ninguno.
 */
export async function enviarPorConversacion(
  c: PoolClient,
  deps: DependenciasDeEnvio,
  entrada: {
    conversacion: ConversacionParaEnvio;
    peticion: PeticionDeEnvio;
    remitente: Remitente;
  },
): Promise<MensajeEncolado> {
  const ahora = (deps.ahora ?? (() => new Date()))();
  const conv = entrada.conversacion;
  const remitente = entrada.remitente;

  // 1. Una respuesta rápida es, técnicamente, un mensaje libre: se expande a
  //    su versión actual y atraviesa la misma puerta.
  const { peticion, quickReplyVersionId } = await expandirRapida(c, entrada.peticion);

  // 2. Estado de la suscripción. Deriva de las fechas, nunca de la columna
  //    cacheada (ADR y packages/core).
  const suscripcion = await leerSuscripcion(c, remitente.tenantId);
  const decision = evaluarEnvio(
    suscripcion,
    {
      tipo: (peticion.tipo === 'comment_reply' ? 'text' : peticion.tipo) as TipoDeEnvio,
      origen: remitente.origen,
    },
    ahora,
  );
  if (!decision.permitido) {
    throw new ErrorDeNegocio(
      `suscripcion_${decision.motivo}`,
      decision.mensaje ?? 'Envío no permitido.',
      402,
    );
  }

  // 3. Estado de la conversación.
  if (conv.status === 'closed') {
    throw new ErrorDeNegocio(
      'conversacion_cerrada',
      'La conversación está cerrada. Reábrela para responder.',
      409,
    );
  }

  const canal = deps.canales.get(conv.channel);
  if (!canal)
    throw new ErrorDeNegocio('canal_no_disponible', `Canal "${conv.channel}" no disponible.`, 503);
  const capacidades = canal.capacidades();
  const politica = canal.politicaDeVentana();

  // 4. Ventana de sesión. Las plantillas son la excepción: existen
  //    precisamente para hablar fuera de ventana.
  // Responder a un comentario tampoco depende de la ventana: sus reglas
  // (una privada por comentario, dentro de siete días) las aplica el proveedor.
  if (
    peticion.tipo !== 'template' &&
    peticion.tipo !== 'comment_reply' &&
    !ventanaAbierta(conv.session_expires_at, ahora)
  ) {
    throw new ErrorDeNegocio(
      'fuera_de_ventana',
      'La ventana de 24 horas está cerrada. Solo se puede enviar una plantilla aprobada.',
      409,
      // Lo que el agente SÍ puede enviar. El frontend lo pinta, no lo decide.
      { plantillasSugeridas: await plantillasAprobadas(c, conv.channel_account_id) },
    );
  }

  // 4b. Plantilla: debe existir sincronizada y estar aprobada. El estado lo
  //     fija Meta; aquí solo se consulta lo que se sincronizó (ARCH §3).
  let waTemplateVersionId: string | null = null;
  if (peticion.tipo === 'template') {
    waTemplateVersionId = await exigirPlantillaAprobada(
      c,
      conv.channel_account_id,
      peticion.nombre,
      peticion.idioma,
    );
  }

  // 4c. Comentario al que se responde: el indicado o el último recibido.
  let comentarioId: string | null = null;
  if (peticion.tipo === 'comment_reply') {
    if (!capacidades.soportaComentarios) {
      throw new ErrorDeNegocio(
        'canal_sin_comentarios',
        `El canal "${conv.channel}" no tiene comentarios.`,
        422,
      );
    }
    comentarioId = peticion.comentarioId ?? (await ultimoComentario(c, conv.id));
    if (!comentarioId) {
      throw new ErrorDeNegocio(
        'comentario_requerido',
        'Esta conversación no tiene comentarios a los que responder.',
        400,
      );
    }
  }

  // 5. Capacidades del canal. Se pregunta, no se asume (ARCH §8).
  const error = validarContraCapacidades(capacidades, {
    tipo: (peticion.tipo === 'comment_reply' ? 'text' : peticion.tipo) as TipoDeMensaje,
    ...(peticion.tipo === 'text' || peticion.tipo === 'comment_reply'
      ? { longitudTexto: peticion.texto.length }
      : {}),
  });
  if (error) throw new ErrorDeNegocio(`canal_${error.tipo}`, error.message, 422);

  // 5b. Medio propio: debe existir (RLS: ajeno = inexistente) y estar
  //     almacenado. La URL firmada la genera el worker al enviar.
  let mediaAssetId: string | null = null;
  if (
    peticion.tipo !== 'text' &&
    peticion.tipo !== 'template' &&
    peticion.tipo !== 'comment_reply'
  ) {
    if (!peticion.url && !peticion.mediaAssetId) {
      throw new ErrorDeNegocio('medio_requerido', 'Indica url o mediaAssetId.', 400);
    }
    if (peticion.mediaAssetId) {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM media_assets WHERE id = $1`,
        [peticion.mediaAssetId],
      );
      if (!rows[0]) throw new ErrorDeNegocio('medio_no_encontrado', 'El medio no existe.', 404);
      if (rows[0].status !== 'stored') {
        throw new ErrorDeNegocio(
          'medio_no_disponible',
          'El medio todavía no está almacenado.',
          409,
        );
      }
      mediaAssetId = peticion.mediaAssetId;
    }
  }

  // 6. Insertar en `queued` y encolar por el outbox. Sin RETURNING.
  const messageId = await nuevoId(c);
  const createdAt = ahora;
  const texto =
    peticion.tipo === 'text' || peticion.tipo === 'comment_reply' ? peticion.texto : null;
  const payload =
    peticion.tipo === 'text'
      ? {}
      : peticion.tipo === 'comment_reply'
        ? { comentario: { id: comentarioId, modo: peticion.modo } }
        : peticion.tipo === 'template'
          ? {
              plantilla: {
                nombre: peticion.nombre,
                idioma: peticion.idioma,
                parametros: peticion.parametros,
                versionId: waTemplateVersionId,
              },
            }
          : {
              media: {
                url: peticion.url ?? null,
                mediaAssetId,
                pieDeFoto: peticion.pieDeFoto ?? null,
              },
            };

  await c.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, channel_account_id, direction, type, body, payload,
        status, sent_by, sent_by_user_id, created_at, media_asset_id,
        quick_reply_version_id, wa_template_version_id)
     VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, 'queued', $8, $9, $10, $11, $12, $13)`,
    [
      messageId,
      remitente.tenantId,
      conv.id,
      conv.channel_account_id,
      peticion.tipo === 'comment_reply' ? 'text' : peticion.tipo,
      texto,
      JSON.stringify(payload),
      remitente.origen,
      remitente.userId,
      createdAt,
      mediaAssetId,
      quickReplyVersionId,
      waTemplateVersionId,
    ],
  );

  // La ventana la reinicia el ENTRANTE; para WhatsApp esto no cambia nada y
  // para un canal que sí reinicie con salientes, core lo sabe.
  const nuevaExpiracion = expiracionTrasMensaje(
    politica,
    'outbound',
    createdAt,
    conv.session_expires_at,
  );

  await c.query(
    `UPDATE conversations
        SET last_outbound_at = $2,
            first_response_at = COALESCE(first_response_at, $2),
            session_expires_at = $3,
            unread_count = 0,
            updated_at = now()
      WHERE id = $1`,
    [conv.id, createdAt, nuevaExpiracion],
  );

  await escribirEnOutbox(c, {
    tenantId: remitente.tenantId,
    aggregateType: 'message',
    aggregateId: messageId,
    eventType: 'mensaje.enviar',
    payload: {
      messageId,
      createdAt: createdAt.toISOString(),
      conversationId: conv.id,
      channelAccountId: conv.channel_account_id,
      canal: conv.channel,
      externalUserId: conv.external_user_id,
      peticion: peticionParaEnvio(
        peticion.tipo === 'comment_reply' ? { ...peticion, comentarioId: comentarioId! } : peticion,
        mediaAssetId,
      ),
    },
  });

  await c.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
     VALUES ($1, $2, 'mensaje.enviado', 'conversation', $3)`,
    [remitente.tenantId, remitente.userId, conv.id],
  );

  return { id: messageId, createdAt, estado: 'queued' };
}

async function expandirRapida(
  c: PoolClient,
  p: PeticionDeEnvio,
): Promise<{ peticion: PeticionEfectiva; quickReplyVersionId: string | null }> {
  if (p.tipo !== 'quick_reply') return { peticion: p, quickReplyVersionId: null };
  const v = await versionActualDeRapida(c, p.quickReplyId);
  if (!v) {
    throw new ErrorDeNegocio(
      'respuesta_rapida_no_encontrada',
      'La respuesta rápida no existe o está archivada.',
      404,
    );
  }
  if (v.mediaAssetId) {
    if (v.mediaStatus !== 'stored') {
      throw new ErrorDeNegocio(
        'medio_no_disponible',
        'El adjunto de la respuesta rápida no está almacenado.',
        409,
      );
    }
    return {
      peticion: {
        tipo: v.mediaKind as 'image' | 'video' | 'audio' | 'document',
        mediaAssetId: v.mediaAssetId,
        pieDeFoto: v.cuerpo || undefined,
      },
      quickReplyVersionId: v.versionId,
    };
  }
  return { peticion: { tipo: 'text', texto: v.cuerpo }, quickReplyVersionId: v.versionId };
}

async function ultimoComentario(c: PoolClient, conversationId: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string | null }>(
    `SELECT payload #>> '{comentario,id}' AS id
       FROM messages
      WHERE conversation_id = $1 AND direction = 'inbound' AND payload ? 'comentario'
      ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0]?.id ?? null;
}

export async function leerSuscripcion(c: PoolClient, tenantId: string): Promise<Suscripcion> {
  const { rows } = await c.query<{
    status: Suscripcion['estadoDeclarado'];
    trial_ends_at: Date | null;
    current_period_ends_at: Date | null;
    grace_days: number;
  }>(
    `SELECT status, trial_ends_at, current_period_ends_at, grace_days FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  const s = rows[0];
  // Sin suscripción, core la considera suspendida: fallar cerrado.
  if (!s)
    return { estadoDeclarado: 'trialing', pruebaHasta: null, periodoHasta: null, diasDeGracia: 0 };
  return {
    estadoDeclarado: s.status,
    pruebaHasta: s.trial_ends_at,
    periodoHasta: s.current_period_ends_at,
    diasDeGracia: s.grace_days,
  };
}
