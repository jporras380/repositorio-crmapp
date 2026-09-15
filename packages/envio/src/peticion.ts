/** Formas de una petición de envío y su traducción a la carga del outbox. */

export type PeticionDeEnvio =
  | {
      tipo: 'text';
      texto: string;
      /**
       * El texto lo redactó la IA y una persona lo revisó y lo envió. El
       * remitente sigue siendo esa persona (`sent_by = 'human'`); la marca
       * queda en `messages.ai_generated` para que se sepa de dónde salió.
       */
      generadoPorIa?: boolean | undefined;
    }
  | {
      tipo: 'image' | 'video' | 'audio' | 'document';
      /** URL externa, o bien un medio propio ya almacenado. Uno de los dos. */
      url?: string | undefined;
      mediaAssetId?: string | undefined;
      pieDeFoto?: string | undefined;
    }
  | { tipo: 'template'; nombre: string; idioma: string; parametros: string[] }
  /** Respuesta rápida: se expande a su versión actual (texto o medio). */
  | { tipo: 'quick_reply'; quickReplyId: string }
  /** Respuesta a un comentario público (Instagram): en el hilo o por privado. */
  | {
      tipo: 'comment_reply';
      /**
       * Por defecto `privada`: es donde se captura el lead, y es lo que hacen
       * Kommo y Zenvia. Pública es una decisión explícita porque la ve todo el
       * mundo. La privada solo se puede enviar UNA vez por comentario.
       */
      modo: 'publica' | 'privada';
      texto: string;
      /** Si falta, se responde al último comentario recibido en la conversación. */
      comentarioId?: string | undefined;
    };

/** Lo que llega a la puerta tras expandir las respuestas rápidas. */
export type PeticionEfectiva = Exclude<PeticionDeEnvio, { tipo: 'quick_reply' }>;

export interface MensajeEncolado {
  id: string;
  createdAt: Date;
  estado: 'queued';
}

/**
 * Carga que viaja al worker. Se recorta a lo que el adaptador necesita: el
 * worker no vuelve a leer la petición de la base, así que lo que no vaya aquí
 * no existe para él.
 */
export function peticionParaEnvio(p: PeticionEfectiva, mediaAssetId: string | null): unknown {
  if (p.tipo === 'text' || p.tipo === 'template' || p.tipo === 'comment_reply') return p;
  return { tipo: p.tipo, url: p.url ?? null, mediaAssetId, pieDeFoto: p.pieDeFoto };
}
