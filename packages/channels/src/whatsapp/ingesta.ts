/**
 * Ingesta de WhatsApp Cloud API: traduce el webhook de Meta a eventos
 * normalizados.
 *
 * El payload de Meta es profundo y agrupa varias cosas en una sola entrega:
 * `entry[].changes[].value` puede traer mensajes, estados y cambios de
 * plantilla, de varias cuentas. Aquí se aplana. Lo que no se reconoce se
 * ignora en silencio a propósito: Meta añade tipos sin avisar, y fallar ante
 * uno desconocido tumbaría los demás del lote.
 */
import type { TipoDeMensaje } from '../adaptador.js';
import {
  responderAlDesafioMeta,
  verificarFirmaMeta,
  type AdaptadorDeIngesta,
  type EventoDeEstado,
  type EventoDeMensaje,
  type EventoDePlantilla,
  type EventoEntrante,
  type PeticionDeWebhook,
  type EventoDeEco,
  type EventoDeContacto,
  type EventoDeHistorial,
} from '../ingesta.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Tipos de mensaje de Cloud API → nuestro vocabulario. */
const TIPO: Record<string, TipoDeMensaje> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
};

const ESTADO: Record<string, EventoDeEstado['estado']> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

const EVENTO_PLANTILLA: Record<string, EventoDePlantilla['estado']> = {
  APPROVED: 'aprobada',
  REJECTED: 'rechazada',
  PAUSED: 'pausada',
  DISABLED: 'deshabilitada',
};

export class IngestaWhatsapp implements AdaptadorDeIngesta {
  readonly canal = 'whatsapp' as const;

  verificarFirma(peticion: PeticionDeWebhook, secreto: string): boolean {
    return verificarFirmaMeta(peticion, secreto);
  }

  responderAlDesafio(
    parametros: Record<string, string | undefined>,
    verifyToken: string,
  ): string | null {
    return responderAlDesafioMeta(parametros, verifyToken);
  }

  parsearEventos(cuerpo: unknown): EventoEntrante[] {
    const salida: EventoEntrante[] = [];
    for (const entry of arr(obj(cuerpo)['entry'])) {
      const wabaId = str(obj(entry)['id']);
      for (const change of arr(obj(entry)['changes'])) {
        const field = str(obj(change)['field']);
        const value = obj(obj(change)['value']);

        if (field === 'message_template_status_update') {
          const estado = EVENTO_PLANTILLA[str(value['event']) ?? ''];
          if (!estado || !wabaId) continue;
          salida.push({
            clase: 'plantilla',
            canal: 'whatsapp',
            externalAccountId: wabaId,
            ocurridoEn: new Date(),
            nombre: str(value['message_template_name']) ?? '',
            idioma: str(value['message_template_language']) ?? '',
            estado,
            motivoDeRechazo: str(value['reason']),
            categoriaEfectiva: str(obj(value['other_info'])['category']),
          });
          continue;
        }

        // Mensajes y estados: la cuenta es el phone_number_id de metadata.
        const phoneNumberId = str(obj(value['metadata'])['phone_number_id']);
        if (!phoneNumberId) continue;

        // Coexistencia (ADR-015): la agenda de la app del celular. Campo
        // `smb_app_state_sync`. Solo los contactos; lo demás se ignora.
        for (const sinc of arr(value['state_sync'])) {
          const evento = contacto(obj(sinc), phoneNumberId);
          if (evento) salida.push(evento);
        }

        // Y el historial: campo `history`, por tandas. Cada hilo es una
        // persona; dentro van sus mensajes y los del negocio, mezclados. Una
        // tanda que solo trae `errors` es que el dueño no quiso compartirlo.
        const numeroDelNegocio = soloDigitos(str(obj(value['metadata'])['display_phone_number']));
        for (const tanda of arr(value['history'])) {
          for (const hilo of arr(obj(tanda)['threads'])) {
            const persona = str(obj(hilo)['id']);
            if (!persona) continue;
            for (const m of arr(obj(hilo)['messages'])) {
              const evento = delHistorial(obj(m), phoneNumberId, persona, numeroDelNegocio);
              if (evento) salida.push(evento);
            }
          }
        }

        // Perfiles: Meta manda nombre y nombre de usuario aparte, en
        // `contacts[]`. Se indexan por BSUID (`user_id`) y por número
        // (`wa_id`), porque el número puede faltar y el BSUID no.
        const perfiles = new Map<string, Perfil>();
        for (const c of arr(value['contacts'])) {
          const perfil = obj(obj(c)['profile']);
          const p: Perfil = {
            nombre: str(perfil['name']),
            nombreDeUsuario: str(perfil['username']) ?? str(obj(c)['username']),
          };
          const userId = str(obj(c)['user_id']);
          const waId = str(obj(c)['wa_id']);
          if (userId) perfiles.set(userId, p);
          if (waId) perfiles.set(waId, p);
        }

        for (const m of arr(value['messages'])) {
          const evento = mensaje(obj(m), phoneNumberId, perfiles);
          if (evento) salida.push(evento);
        }

        for (const s of arr(value['statuses'])) {
          const evento = estado(obj(s), phoneNumberId);
          if (evento) salida.push(evento);
        }

        // Coexistencia (ADR-015): lo que el negocio envió desde la app
        // WhatsApp Business del celular. Campo `smb_message_echoes`.
        for (const e of arr(value['message_echoes'])) {
          const evento = eco(obj(e), phoneNumberId);
          if (evento) salida.push(evento);
        }
      }
    }
    return salida;
  }
}

function fechaDe(timestamp: unknown): Date {
  const n = Number(timestamp);
  // Meta manda segundos Unix como string. Si no viene, ahora.
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

interface Perfil {
  nombre: string | undefined;
  nombreDeUsuario: string | undefined;
}

function mensaje(
  m: Obj,
  phoneNumberId: string,
  perfiles: Map<string, Perfil>,
): EventoDeMensaje | null {
  const id = str(m['id']);
  const from = str(m['from']);
  // BSUID: viene siempre (desde abril de 2026); `from` puede faltar cuando la
  // persona usa nombre de usuario. Sin ninguno de los dos, no hay a quién.
  const bsuid = str(m['from_user_id']);
  const tipoMeta = str(m['type']) ?? '';
  const quien = from ?? bsuid;
  if (!id || !quien) return null;
  const perfil =
    (bsuid ? perfiles.get(bsuid) : undefined) ?? (from ? perfiles.get(from) : undefined);

  // Respuestas a botones y listas: son lo que el cliente ELIGIÓ y se tratan
  // como texto con lo que ve escrito. Antes se descartaban: quien pulsaba
  // «Reservar» en una plantilla no aparecía en la bandeja.
  // - `button`: botón de respuesta rápida de una plantilla ({text, payload}).
  // - `interactive`: `button_reply` o `list_reply` ({id, title[, description]}).
  const eleccion = textoDeEleccion(tipoMeta, m);

  const tipo = eleccion !== undefined ? 'text' : TIPO[tipoMeta];
  // Tipos que no manejamos todavía (reaction, order, system, unsupported...):
  // se ignoran, no se falla.
  if (!tipo) return null;

  const contenido = obj(m[tipoMeta]);
  const texto =
    eleccion !== undefined
      ? eleccion
      : tipo === 'text'
        ? str(contenido['body'])
        : tipo === 'location'
          ? `${contenido['latitude']},${contenido['longitude']}`
          : str(contenido['caption']);

  // Solo los documentos traen nombre; en una foto, Meta no manda ninguno.
  const nombreDeArchivo = str(contenido['filename']);

  // `referral` aparece cuando el contacto llegó desde un anuncio
  // Click-to-WhatsApp: abre la ventana gratuita de 72 h.
  const referral = obj(m['referral']);
  const entradaGratuita = Object.keys(referral).length > 0;

  return {
    clase: 'mensaje',
    canal: 'whatsapp',
    externalAccountId: phoneNumberId,
    ocurridoEn: fechaDe(m['timestamp']),
    externalMessageId: id,
    // Con número, la clave sigue siendo el número: así lo guardan todas las
    // identidades anteriores a los BSUID. Sin número, el BSUID.
    externalUserId: quien,
    nombreDeContacto: perfil?.nombre,
    // `from` es el número en formato internacional sin '+'.
    telefonoE164: from && /^\d{6,15}$/.test(from) ? `+${from}` : undefined,
    idDeUsuarioDelProveedor: bsuid,
    nombreDeUsuario: perfil?.nombreDeUsuario,
    tipo,
    texto,
    mediaId: tipo === 'text' || tipo === 'location' ? undefined : str(contenido['id']),
    nombreDeArchivo,
    entradaGratuita,
    respondeA: str(obj(m['context'])['id']),
  };
}

/** Texto de lo que el cliente eligió en un botón o una lista, o `undefined` si no es eso. */
function textoDeEleccion(tipoMeta: string, m: Obj): string | undefined {
  if (tipoMeta === 'button') {
    const b = obj(m['button']);
    return str(b['text']) ?? str(b['payload']);
  }
  if (tipoMeta === 'interactive') {
    const i = obj(m['interactive']);
    const r = obj(i[str(i['type']) ?? '']);
    // Solo las dos respuestas documentadas; otros tipos (formularios, pagos)
    // no son una elección con texto y se ignoran.
    if (i['type'] !== 'button_reply' && i['type'] !== 'list_reply') return undefined;
    return str(r['title']) ?? str(r['id']);
  }
  return undefined;
}

/**
 * Un eco tiene la forma de un mensaje, con `to` en vez de un remitente que
 * importe: `from` es el propio negocio. Se lee con el mismo código que un
 * entrante —tipos, texto, medio— para no tener dos traducciones que se
 * separen, y se le da la vuelta al destinatario.
 */
function eco(e: Obj, phoneNumberId: string): EventoDeEco | null {
  const para = str(e['to']);
  if (!para) return null;
  const m = mensaje({ ...e, from: para, from_user_id: undefined }, phoneNumberId, new Map());
  if (!m) return null;
  return {
    clase: 'eco',
    canal: 'whatsapp',
    externalAccountId: phoneNumberId,
    ocurridoEn: m.ocurridoEn,
    externalMessageId: m.externalMessageId,
    externalUserId: m.externalUserId,
    telefonoE164: m.telefonoE164,
    tipo: m.tipo,
    texto: m.texto,
    mediaId: m.mediaId,
    nombreDeArchivo: m.nombreDeArchivo,
  };
}

const soloDigitos = (v: string | undefined): string => (v ?? '').replace(/\D/g, '');

/** Cómo quedó en su día un mensaje del historial, en nuestros estados. */
const ESTADO_DEL_HISTORIAL: Record<string, EventoDeHistorial['estado']> = {
  SENT: 'sent',
  PENDING: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

/**
 * Un mensaje del historial. Lo escribió el negocio si `from` es su número;
 * si no, la persona del hilo. Se lee con el mismo código que un entrante,
 * para que un tipo de mensaje no se traduzca de dos formas.
 *
 * Los medios antiguos llegan SIN identificador de archivo (Meta solo manda,
 * aparte, los de los últimos 14 días): se importa el mensaje con su tipo y su
 * pie de foto, y la bandeja dice que el archivo no vino.
 */
function delHistorial(
  m: Obj,
  phoneNumberId: string,
  persona: string,
  numeroDelNegocio: string,
): EventoDeHistorial | null {
  const leido = mensaje({ ...m, from: persona, from_user_id: undefined }, phoneNumberId, new Map());
  if (!leido) return null;
  const deQuien = soloDigitos(str(m['from']));
  const delNegocio =
    deQuien !== soloDigitos(persona) && (numeroDelNegocio === '' || deQuien === numeroDelNegocio);
  return {
    clase: 'historial',
    canal: 'whatsapp',
    externalAccountId: phoneNumberId,
    ocurridoEn: leido.ocurridoEn,
    externalMessageId: leido.externalMessageId,
    externalUserId: leido.externalUserId,
    telefonoE164: leido.telefonoE164,
    direccion: delNegocio ? 'outbound' : 'inbound',
    tipo: leido.tipo,
    texto: leido.texto,
    estado: ESTADO_DEL_HISTORIAL[str(obj(m['history_context'])['status']) ?? ''],
  };
}

/** Un contacto de la agenda de la app. `remove` lo quita; lo demás lo guarda. */
function contacto(s: Obj, phoneNumberId: string): EventoDeContacto | null {
  if (str(s['type']) !== 'contact') return null;
  const c = obj(s['contact']);
  const numero = soloDigitos(str(c['phone_number']));
  if (!numero) return null;
  const nombre = str(c['full_name'])?.trim() || str(c['first_name'])?.trim() || null;
  return {
    clase: 'contacto',
    canal: 'whatsapp',
    externalAccountId: phoneNumberId,
    ocurridoEn: new Date(),
    externalUserId: numero,
    nombre: str(s['action']) === 'remove' ? null : nombre,
  };
}

function estado(s: Obj, phoneNumberId: string): EventoDeEstado | null {
  const id = str(s['id']);
  const est = ESTADO[str(s['status']) ?? ''];
  if (!id || !est) return null;
  const primerError = obj(arr(s['errors'])[0]);
  return {
    clase: 'estado',
    canal: 'whatsapp',
    externalAccountId: phoneNumberId,
    ocurridoEn: fechaDe(s['timestamp']),
    externalMessageId: id,
    estado: est,
    error:
      est === 'failed'
        ? {
            codigo: String(primerError['code'] ?? 'desconocido'),
            mensaje:
              str(primerError['title']) ??
              str(obj(primerError['error_data'])['details']) ??
              'Fallo de entrega',
          }
        : undefined,
  };
}
