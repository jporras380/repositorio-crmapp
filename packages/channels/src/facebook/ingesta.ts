/**
 * Ingesta de webhooks de Facebook (objeto `page` de Meta).
 *
 * Firma y reto son los de Meta. Dos cosas llegan por la misma suscripción:
 *
 * - `entry[].messaging[]`: mensajes de Messenger. `sender.id` es el PSID de la
 *   persona (propio de la página). `is_echo` marca lo que enviamos nosotros y
 *   se ignora: ya está en `messages` por el saliente.
 * - `entry[].changes[]` con `field: 'feed'` e `item: 'comment'`, `verb: 'add'`:
 *   comentarios nuevos en publicaciones de la página. El resto del feed
 *   (reacciones, publicaciones, ediciones, borrados) no es conversación y se
 *   ignora. Los comentarios de la propia página se descartan, para no abrir
 *   un hilo con nosotros mismos.
 *
 * Los adjuntos llegan como URL del CDN: el `mediaId` que se emite ES esa URL,
 * igual que en Instagram, y el worker la descarga enseguida (ADR-009).
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
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const TIPO_ADJUNTO: Record<string, TipoDeMensaje> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
};

export class IngestaFacebook implements AdaptadorDeIngesta {
  readonly canal = 'facebook' as const;

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
      const pageId = str(e['id']);
      if (!pageId) continue;

      for (const m of arr(e['messaging'])) {
        const evento = mensaje(obj(m), pageId);
        if (evento) salida.push(evento);
      }
      for (const change of arr(e['changes'])) {
        const ch = obj(change);
        if (str(ch['field']) !== 'feed') continue;
        const evento = comentario(obj(ch['value']), pageId);
        if (evento) salida.push(evento);
      }
    }
    return salida;
  }
}

function fechaDe(timestamp: unknown): Date {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  // Messenger manda milisegundos; el feed, segundos.
  return new Date(n > 1e12 ? n : n * 1000);
}

function mensaje(m: Obj, pageId: string): EventoDeMensaje | null {
  const sender = str(obj(m['sender'])['id']);
  const message = obj(m['message']);
  const mid = str(message['mid']);
  if (!sender || !mid) return null;
  if (message['is_echo'] === true || sender === pageId) return null;

  const texto = str(message['text']);
  const adjunto = obj(arr(message['attachments'])[0]);
  const tipoAdjunto = str(adjunto['type']);
  const url = str(obj(adjunto['payload'])['url']);

  const base = {
    clase: 'mensaje' as const,
    canal: 'facebook' as const,
    externalAccountId: pageId,
    ocurridoEn: fechaDe(m['timestamp']),
    externalMessageId: mid,
    externalUserId: sender,
    respondeA: str(obj(message['reply_to'])['mid']),
  };
  // Un adjunto de tipo conocido y con URL se descarga; uno raro (plantillas,
  // ubicaciones compartidas, «fallback») con texto se queda en el texto.
  const tipo = tipoAdjunto ? TIPO_ADJUNTO[tipoAdjunto] : undefined;
  if (tipo && url) return { ...base, tipo, mediaId: url, texto };
  if (texto === undefined) return null;
  return { ...base, tipo: 'text', texto };
}

function comentario(v: Obj, pageId: string): EventoDeComentario | null {
  if (str(v['item']) !== 'comment' || str(v['verb']) !== 'add') return null;
  const id = str(v['comment_id']);
  const post = str(v['post_id']);
  const from = obj(v['from']);
  const de = str(from['id']);
  if (!id || !post || !de) return null;
  if (de === pageId) return null; // nuestra propia respuesta

  const parent = str(v['parent_id']);
  return {
    clase: 'comentario',
    canal: 'facebook',
    externalAccountId: pageId,
    ocurridoEn: fechaDe(v['created_time']),
    externalCommentId: id,
    externalUserId: de,
    externalPostId: post,
    texto: str(v['message']) ?? '',
    // En un comentario de primer nivel, `parent_id` es la publicación.
    respondeAComentario: parent && parent !== post ? parent : undefined,
    nombreDeUsuario: str(from['name']),
  };
}
