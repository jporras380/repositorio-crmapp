/**
 * Ingesta de webhooks de Instagram (objeto `instagram` de Meta).
 *
 * Firma y reto son los mismos de Meta (HMAC-SHA256 sobre los bytes crudos).
 * El payload difiere de WhatsApp en la forma, no en el fondo:
 *
 * - `entry[].messaging[]`: mensajes directos. `sender.id` es el IGSID del
 *   contacto (scoped a la app: no es el @usuario). `is_echo` marca lo que
 *   enviamos nosotros y se ignora: ya está en `messages` por el saliente.
 * - `entry[].changes[]` con `field: 'comments'`: comentarios en publicaciones.
 *   Se descartan los del propio negocio (`from.id === entry.id`) para no
 *   abrir un hilo con nosotros mismos.
 *
 * Los adjuntos llegan como URL del CDN que caduca: el `mediaId` que se emite
 * ES esa URL, y el worker la descarga enseguida (ADR-009).
 */
import type { TipoDeMensaje } from '../adaptador.js';
import {
  responderAlDesafioMeta,
  verificarFirmaMeta,
  type AdaptadorDeIngesta,
  type EventoDeComentario,
  type EventoDeMensaje,
  type EventoEntrante,
  type PeticionDeWebhook,
} from '../ingesta.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const TIPO_ADJUNTO: Record<string, TipoDeMensaje> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
  // Un "share" es una publicación reenviada: se trata como imagen para no perderlo.
  share: 'image',
  story_mention: 'image',
  ig_reel: 'video',
};

export class IngestaInstagram implements AdaptadorDeIngesta {
  readonly canal = 'instagram' as const;

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
      const e = obj(entry);
      const igUserId = str(e['id']);
      if (!igUserId) continue;

      for (const m of arr(e['messaging'])) {
        const evento = mensaje(obj(m), igUserId);
        if (evento) salida.push(evento);
      }
      for (const change of arr(e['changes'])) {
        const ch = obj(change);
        if (str(ch['field']) !== 'comments') continue;
        const evento = comentario(obj(ch['value']), igUserId);
        if (evento) salida.push(evento);
      }
    }
    return salida;
  }
}

function fechaDe(timestamp: unknown): Date {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  // Instagram manda milisegundos en `messaging` y segundos en `comments`.
  return new Date(n > 1e12 ? n : n * 1000);
}

function mensaje(m: Obj, igUserId: string): EventoDeMensaje | null {
  const sender = str(obj(m['sender'])['id']);
  const message = obj(m['message']);
  const mid = str(message['mid']);
  if (!sender || !mid) return null;
  // Eco de un mensaje nuestro, o mensaje borrado / no soportado: no es entrante.
  if (message['is_echo'] === true || sender === igUserId) return null;
  if (message['is_deleted'] === true || message['is_unsupported'] === true) return null;

  const texto = str(message['text']);
  const adjunto = obj(arr(message['attachments'])[0]);
  const tipoAdjunto = str(adjunto['type']);
  const url = str(obj(adjunto['payload'])['url']);

  const base = {
    clase: 'mensaje' as const,
    canal: 'instagram' as const,
    externalAccountId: igUserId,
    ocurridoEn: fechaDe(m['timestamp']),
    externalMessageId: mid,
    externalUserId: sender,
    respondeA: str(obj(message['reply_to'])['mid']),
  };
  if (tipoAdjunto && url) {
    return { ...base, tipo: TIPO_ADJUNTO[tipoAdjunto] ?? 'document', mediaId: url, texto };
  }
  if (texto === undefined) return null;
  return { ...base, tipo: 'text', texto };
}

function comentario(v: Obj, igUserId: string): EventoDeComentario | null {
  const id = str(v['id']);
  const from = obj(v['from']);
  const de = str(from['id']);
  const media = str(obj(v['media'])['id']);
  if (!id || !de || !media) return null;
  if (de === igUserId) return null; // nuestro propio comentario o respuesta

  return {
    clase: 'comentario',
    canal: 'instagram',
    externalAccountId: igUserId,
    ocurridoEn: fechaDe(v['timestamp']),
    externalCommentId: id,
    externalUserId: de,
    externalPostId: media,
    texto: str(v['text']) ?? '',
    respondeAComentario: str(v['parent_id']),
    nombreDeUsuario: str(from['username']),
  };
}
