/**
 * Adaptador de Facebook Messenger y comentarios de página (Graph API de Meta).
 *
 * Tercer canal, dentro del contrato `ChannelAdapter` sin tocarlo. Es primo
 * hermano de Instagram —mismo Graph, mismos tokens de página, misma ventana—
 * con estas diferencias, todas de la documentación de Meta:
 *
 * - **Envío:** `POST /{page-id}/messages` con `recipient.id` = PSID (id de la
 *   persona propio de la página) y `messaging_type: 'RESPONSE'`, que es el
 *   tipo para contestar dentro de la ventana estándar de 24 h.
 * - **Medios salientes por URL:** `attachment.payload.url`. Messenger tiene
 *   subida de adjuntos, pero el núcleo ya firma URLs para Instagram y un
 *   segundo camino no aporta nada hoy.
 * - **Comentarios:** respuesta pública con `POST /{comment-id}/comments`
 *   (permiso `pages_manage_engagement`); privada con `recipient.comment_id`,
 *   **una** por comentario y dentro de los 7 días del comentario.
 * - **Sin plantillas:** fuera de la ventana solo quedarían etiquetas de
 *   mensaje, que exigen permisos propios; no se ofrecen.
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

export interface CredencialesDeFacebook {
  /** Id de la página. Es el `external_id` de la cuenta de canal. */
  pageId: string;
  /** Token de página con `pages_messaging` (y `pages_manage_engagement` para comentar). */
  accessToken: string;
}

export type ResolverCredencialesFacebook = (
  channelAccountId: string,
) => Promise<CredencialesDeFacebook>;

export interface OpcionesDeFacebook {
  resolverCredenciales: ResolverCredencialesFacebook;
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
  };
}

export class AdaptadorFacebook implements ChannelAdapter {
  readonly canal = 'facebook' as const;
  readonly #resolver: ResolverCredencialesFacebook;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opciones: OpcionesDeFacebook) {
    this.#resolver = opciones.resolverCredenciales;
    this.#version = opciones.apiVersion ?? 'v21.0';
    this.#fetch = opciones.fetch ?? globalThis.fetch;
    this.#base = opciones.baseUrl ?? 'https://graph.facebook.com';
  }

  capacidades(): CapacidadesDeCanal {
    return {
      canal: 'facebook',
      tiposSoportados: ['text', 'image', 'video', 'audio', 'document'],
      soportaPlantillas: false,
      soportaComentarios: true,
      respuestasPrivadasPorComentario: 1,
      requiereUrlPublicaParaMedios: true,
      limitesDeMedios: { image: 25 * MB, video: 25 * MB, audio: 25 * MB, document: 25 * MB },
      longitudMaximaTexto: 2000,
    };
  }

  politicaDeVentana(): PoliticaDeVentana {
    // Ventana estándar de Messenger: 24 h desde la última interacción de la
    // persona. Lo que enviamos nosotros no la reabre.
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
      throw new ErrorDeCanal(
        'tipo_no_soportado',
        'Facebook se envía por URL pública en este sistema; sube el archivo y envía su URL.',
        false,
      );
    }
    const cred = await this.#resolver(envio.channelAccountId);
    // Messenger llama `file` a lo que aquí es un documento.
    const tipo = envio.tipo === 'document' ? 'file' : envio.tipo;
    const r = await this.#mensaje(
      cred,
      { id: envio.externalUserId },
      { attachment: { type: tipo, payload: { url: envio.origen.url, is_reusable: false } } },
    );
    // El pie no viaja con el adjunto: va como segundo mensaje.
    if (envio.pieDeFoto)
      await this.#mensaje(cred, { id: envio.externalUserId }, { text: envio.pieDeFoto });
    return r;
  }

  async sendTemplate(_envio: EnvioDePlantilla): Promise<ResultadoDeEnvio> {
    throw new ErrorDeCanal('tipo_no_soportado', 'Facebook Messenger no tiene plantillas.', false);
  }

  async replyToComment(respuesta: RespuestaAComentario): Promise<ResultadoDeEnvio> {
    this.#validar({ tipo: 'text', longitudTexto: respuesta.texto.length });
    const cred = await this.#resolver(respuesta.channelAccountId);
    if (respuesta.modo === 'privada') {
      return this.#mensaje(cred, { comment_id: respuesta.comentarioId }, { text: respuesta.texto });
    }
    const json = await this.#graph<RespuestaGraph>(
      cred,
      'POST',
      `/${encodeURIComponent(respuesta.comentarioId)}/comments`,
      { message: respuesta.texto },
    );
    return { externalMessageId: json.id ?? '', estado: 'sent', enviadoEn: new Date() };
  }

  /** Como en Instagram: el `mediaId` es la URL del adjunto que vino en el webhook. */
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
      throw new ErrorDeCanal(
        r.status === 403 || r.status === 404
          ? 'rechazado_por_proveedor'
          : 'proveedor_no_disponible',
        `El CDN de Facebook respondió ${r.status}.`,
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
    cred: CredencialesDeFacebook,
    recipient: { id: string } | { comment_id: string },
    message: unknown,
  ): Promise<ResultadoDeEnvio> {
    const json = await this.#graph<RespuestaGraph>(
      cred,
      'POST',
      `/${encodeURIComponent(cred.pageId)}/messages`,
      {
        recipient,
        // RESPONSE: contestar dentro de la ventana. Una respuesta privada a un
        // comentario no lleva tipo: la documentación solo pide recipient y message.
        ...('id' in recipient ? { messaging_type: 'RESPONSE' } : {}),
        message,
      },
    );
    return { externalMessageId: json.message_id ?? '', estado: 'sent', enviadoEn: new Date() };
  }

  async #graph<T>(
    cred: CredencialesDeFacebook,
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
   * Errores de la Send API de Messenger. Lo que decide es `reintentable`.
   * - 190 / 401: token de página inválido o caducado (común a Graph).
   * - 551: «esta persona no está disponible ahora mismo».
   * - 4, 17, 32, 613: límite de tasa (común a Graph).
   *
   * El resto —incluido fuera de ventana— cae como `rechazado_por_proveedor`,
   * no reintentable, con el mensaje de Meta. La tabla oficial de subcódigos no
   * se pudo leer al escribir esto (2026-09-15, la página devolvía 500) y no se
   * mapean subcódigos de memoria.
   */
  async #errorDesde(r: Response): Promise<ErrorDeCanal> {
    let json: RespuestaGraph = {};
    try {
      json = (await r.json()) as RespuestaGraph;
    } catch {
      /* decide el status */
    }
    const e = json.error ?? {};
    const code = e.code ?? 0;
    const sub = e.error_subcode ?? 0;
    const detalle = e.message ?? `HTTP ${r.status}`;
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
    if (code === 551) return mk('destinatario_invalido', false);
    if (r.status >= 500 || code === 1 || code === 2)
      return mk('proveedor_no_disponible', true, retryAfter ?? 30);
    return mk('rechazado_por_proveedor', false);
  }
}
