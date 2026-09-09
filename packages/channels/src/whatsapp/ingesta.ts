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

        // Perfiles: Meta manda los nombres aparte, indexados por wa_id.
        const perfiles = new Map<string, string>();
        for (const c of arr(value['contacts'])) {
          const waId = str(obj(c)['wa_id']);
          const nombre = str(obj(obj(c)['profile'])['name']);
          if (waId && nombre) perfiles.set(waId, nombre);
        }

        for (const m of arr(value['messages'])) {
          const evento = mensaje(obj(m), phoneNumberId, perfiles);
          if (evento) salida.push(evento);
        }

        for (const s of arr(value['statuses'])) {
          const evento = estado(obj(s), phoneNumberId);
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

function mensaje(
  m: Obj,
  phoneNumberId: string,
  perfiles: Map<string, string>,
): EventoDeMensaje | null {
  const id = str(m['id']);
  const from = str(m['from']);
  const tipoMeta = str(m['type']) ?? '';
  if (!id || !from) return null;

  const tipo = TIPO[tipoMeta];
  // Tipos que no manejamos todavía (reaction, interactive, button, order,
  // system, unsupported...): se ignoran, no se falla.
  if (!tipo) return null;

  const contenido = obj(m[tipoMeta]);
  const texto =
    tipo === 'text'
      ? str(contenido['body'])
      : tipo === 'location'
        ? `${contenido['latitude']},${contenido['longitude']}`
        : str(contenido['caption']);

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
    externalUserId: from,
    nombreDeContacto: perfiles.get(from),
    // `from` es el número en formato internacional sin '+'.
    telefonoE164: /^\d{6,15}$/.test(from) ? `+${from}` : undefined,
    tipo,
    texto,
    mediaId: tipo === 'text' || tipo === 'location' ? undefined : str(contenido['id']),
    entradaGratuita,
    respondeA: str(obj(m['context'])['id']),
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
