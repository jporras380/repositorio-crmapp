/**
 * Adaptador real de Instagram (Messaging API de Meta, Graph API).
 *
 * Segundo canal. El contrato `ChannelAdapter` está en la lista de parada: este
 * archivo lo implementa tal cual está, y donde Instagram no llega —plantillas—
 * lo dice con un `ErrorDeCanal` en vez de fingir.
 *
 * Diferencias con WhatsApp que condicionan el código:
 * - **Medios salientes solo por URL pública**: no hay `/media` para subir
 *   bytes; el buffer se rechaza y el núcleo debe traer una URL firmada.
 * - **Comentarios**: respuesta pública (`/{comment-id}/replies`) o privada
 *   (mensaje con `recipient.comment_id`, UNA por comentario).
 * - **Sin plantillas**: fuera de la ventana de 24 h no hay forma de escribir
 *   primero. `sendTemplate` y `syncTemplates` lo dicen.
 * - **El medio entrante llega como URL del CDN**, no como id: `fetchMedia`
 *   descarga esa URL directamente, sin token.
 */
import type { PoliticaDeVentana } from '@crmapp/core';
import {
  ErrorDeCanal,
  validarContraCapacidades,
  type CapacidadesDeCanal,
  type ChannelAdapter,
  type EnvioDeMedia,
  type EnvioDePlantilla,
  type EnvioDeTexto,
  type MediaDescargada,
  type PlantillaSincronizada,
  type RespuestaAComentario,
  type ResultadoDeEnvio,
} from '../adaptador.js';

const MB = 1024 * 1024;

export interface CredencialesDeInstagram {
  /** Id de la cuenta profesional de Instagram (IG User). Es el `external_id`. */
  igUserId: string;
  /** Token de página con `instagram_manage_messages` y `instagram_manage_comments`. */
  accessToken: string;
}

export type ResolverCredencialesInstagram = (
  channelAccountId: string,
) => Promise<CredencialesDeInstagram>;

export interface OpcionesDeInstagram {
  resolverCredenciales: ResolverCredencialesInstagram;
  apiVersion?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface RespuestaGraph {
  message_id?: string;
  recipient_id?: string;
  id?: string;
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

export class AdaptadorInstagram implements ChannelAdapter {
  readonly canal = 'instagram' as const;
  readonly #resolver: ResolverCredencialesInstagram;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opciones: OpcionesDeInstagram) {
    this.#resolver = opciones.resolverCredenciales;
    this.#version = opciones.apiVersion ?? 'v21.0';
    this.#fetch = opciones.fetch ?? globalThis.fetch;
    this.#base = opciones.baseUrl ?? 'https://graph.facebook.com';
  }

  capacidades(): CapacidadesDeCanal {
    return {
      canal: 'instagram',
      tiposSoportados: ['text', 'image', 'video', 'audio'],
      soportaPlantillas: false,
      soportaComentarios: true,
      respuestasPrivadasPorComentario: 1,
      requiereUrlPublicaParaMedios: true,
      limitesDeMedios: { image: 8 * MB, video: 25 * MB, audio: 25 * MB },
      longitudMaximaTexto: 1000,
    };
  }

  politicaDeVentana(): PoliticaDeVentana {
    // 24 h desde el último entrante; el saliente no reinicia; no hay entrada
    // gratuita. Sin plantillas, fuera de ventana no se puede escribir.
    return { duracionHoras: 24, salienteReinicia: false };
  }

  async sendText(envio: EnvioDeTexto): Promise<ResultadoDeEnvio> {
    this.#validar({ tipo: 'text', longitudTexto: envio.texto.length });
    const cred = await this.#resolver(envio.channelAccountId);
    return this.#mensaje(cred, { id: envio.externalUserId }, { text: envio.texto });
  }

  async sendMedia(envio: EnvioDeMedia): Promise<ResultadoDeEnvio> {
    this.#validar({
      tipo: envio.tipo,
      ...(envio.origen.tipo === 'buffer' ? { bytes: envio.origen.datos.length } : {}),
    });
    if (envio.origen.tipo === 'buffer') {
      // No es un límite nuestro: Instagram no tiene subida de bytes. El núcleo
      // debe pasar una URL firmada (requiereUrlPublicaParaMedios = true).
      throw new ErrorDeCanal(
        'tipo_no_soportado',
        'Instagram solo acepta medios por URL pública; sube el archivo y envía su URL.',
        false,
      );
    }
    const cred = await this.#resolver(envio.channelAccountId);
    const r = await this.#mensaje(
      cred,
      { id: envio.externalUserId },
      { attachment: { type: envio.tipo, payload: { url: envio.origen.url } } },
    );
    // El pie no viaja con el adjunto en Instagram: va como segundo mensaje.
    if (envio.pieDeFoto)
      await this.#mensaje(cred, { id: envio.externalUserId }, { text: envio.pieDeFoto });
    return r;
  }

  async sendTemplate(_envio: EnvioDePlantilla): Promise<ResultadoDeEnvio> {
    throw new ErrorDeCanal('tipo_no_soportado', 'Instagram no tiene plantillas.', false);
  }

  async replyToComment(respuesta: RespuestaAComentario): Promise<ResultadoDeEnvio> {
    this.#validar({ tipo: 'text', longitudTexto: respuesta.texto.length });
    const cred = await this.#resolver(respuesta.channelAccountId);
    if (respuesta.modo === 'privada') {
      // Una sola por comentario, y dentro de los 7 días del comentario: si el
      // proveedor la rechaza, el error llega mapeado, no adivinado aquí.
      return this.#mensaje(cred, { comment_id: respuesta.comentarioId }, { text: respuesta.texto });
    }
    const json = await this.#graph<RespuestaGraph>(
      cred,
      'POST',
      `/${respuesta.comentarioId}/replies`,
      {
        message: respuesta.texto,
      },
    );
    return { externalMessageId: json.id ?? '', estado: 'sent', enviadoEn: new Date() };
  }

  /** En Instagram `mediaId` es la URL del CDN que vino en el webhook; caduca. */
  async fetchMedia(mediaId: string, _channelAccountId: string): Promise<MediaDescargada> {
    let r: Response;
    try {
      r = await this.#fetch(mediaId);
    } catch (error) {
      throw new ErrorDeCanal(
        'proveedor_no_disponible',
        `No se pudo descargar el medio: ${(error as Error).message}`,
        true,
        30,
        error,
      );
    }
    if (!r.ok) {
      // Una URL del CDN caducada no vuelve: no reintentable.
      throw new ErrorDeCanal(
        r.status === 403 || r.status === 404
          ? 'rechazado_por_proveedor'
          : 'proveedor_no_disponible',
        `El CDN de Instagram respondió ${r.status}.`,
        r.status >= 500,
        30,
      );
    }
    const datos = Buffer.from(await r.arrayBuffer());
    return {
      datos,
      mime: r.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
      bytes: datos.length,
    };
  }

  async syncTemplates(_channelAccountId: string): Promise<PlantillaSincronizada[]> {
    return [];
  }

  // -------------------------------------------------------------------------

  #validar(p: {
    tipo: CapacidadesDeCanal['tiposSoportados'][number];
    bytes?: number;
    longitudTexto?: number;
  }) {
    const e = validarContraCapacidades(this.capacidades(), p);
    if (e) throw e;
  }

  async #mensaje(
    cred: CredencialesDeInstagram,
    recipient: { id: string } | { comment_id: string },
    message: unknown,
  ): Promise<ResultadoDeEnvio> {
    const json = await this.#graph<RespuestaGraph>(cred, 'POST', `/${cred.igUserId}/messages`, {
      recipient,
      message,
    });
    return { externalMessageId: json.message_id ?? '', estado: 'sent', enviadoEn: new Date() };
  }

  async #graph<T>(
    cred: CredencialesDeInstagram,
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo?: unknown,
  ): Promise<T> {
    let r: Response;
    try {
      r = await this.#fetch(`${this.#base}/${this.#version}${ruta}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${cred.accessToken}`,
          ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
      });
    } catch (error) {
      throw new ErrorDeCanal(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        true,
        30,
        error,
      );
    }
    if (!r.ok) throw await this.#errorDesde(r);
    return (await r.json()) as T;
  }

  /**
   * Códigos de la Messaging API de Instagram. Igual que en WhatsApp, lo que
   * decide es `reintentable`. Los subcódigos de ventana (2534022) y de
   * destinatario (2534014, 551) son distintos de los de Cloud API: por eso
   * cada adaptador tiene su tabla y no se comparte.
   */
  async #errorDesde(r: Response): Promise<ErrorDeCanal> {
    let json: RespuestaGraph = {};
    try {
      json = (await r.json()) as RespuestaGraph;
    } catch {
      /* se decide por el status */
    }
    const e = json.error ?? {};
    const code = e.code ?? 0;
    const sub = e.error_subcode ?? 0;
    const detalle = e.error_data?.details ?? e.message ?? `HTTP ${r.status}`;
    const retryAfter = Number(r.headers.get('retry-after') ?? '') || undefined;
    const mk = (tipo: ErrorDeCanal['tipo'], reintentable: boolean, espera?: number) =>
      new ErrorDeCanal(
        tipo,
        `Meta (${code}${sub ? `/${sub}` : ''}): ${detalle}`,
        reintentable,
        espera,
        json.error,
      );

    if (r.status === 401 || code === 190) return mk('token_invalido', false);
    if (r.status === 429 || code === 4 || code === 17 || code === 32 || code === 613) {
      return mk('limite_de_tasa', true, retryAfter ?? 60);
    }
    if (sub === 2534022 || sub === 2534023) return mk('fuera_de_ventana', false);
    if (sub === 2534014 || sub === 2534001 || code === 551)
      return mk('destinatario_invalido', false);
    if (sub === 2534039 || sub === 2534040) return mk('rechazado_por_proveedor', false); // respuesta privada ya usada / caducada
    if (r.status >= 500 || code === 1 || code === 2)
      return mk('proveedor_no_disponible', true, retryAfter ?? 30);
    return mk('rechazado_por_proveedor', false);
  }
}
