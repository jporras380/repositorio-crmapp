/**
 * Adaptador real de WhatsApp Cloud API (Graph API de Meta).
 *
 * Primer canal real: a partir de aquí `ChannelAdapter` entra en la lista de
 * parada. Este archivo implementa el contrato; no lo amplía.
 *
 * Decisiones que conviene conocer:
 *
 * - **Las credenciales se resuelven por cuenta, en cada llamada.** El
 *   adaptador es único por canal, pero cada inquilino trae su propia WABA y su
 *   propio token (ADR-004). Quien lo construye inyecta `resolverCredenciales`,
 *   que lee `channel_secrets` y descifra. Este archivo nunca ve la clave
 *   maestra ni toca la base de datos.
 * - **`fetch` es inyectable.** Los tests ejercitan la forma exacta de cada
 *   petición y el mapeo de cada error sin red. Si no se inyecta, se usa el
 *   `fetch` global de Node.
 * - **El mapeo de errores es lo más valioso del archivo.** Meta devuelve
 *   códigos numéricos en `error.code` y `error.error_subcode`; traducirlos a
 *   `ErrorDeCanal` con `reintentable` correcto es lo que decide si un job
 *   vuelve a la cola o va a la cola muerta.
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

export interface CredencialesDeWhatsapp {
  /** `phone_number_id` de Cloud API. Es el `external_id` de la cuenta. */
  phoneNumberId: string;
  /** Identificador de la WABA; hace falta para las plantillas. */
  wabaId: string;
  accessToken: string;
}

export type ResolverCredenciales = (channelAccountId: string) => Promise<CredencialesDeWhatsapp>;

export interface OpcionesDeWhatsapp {
  resolverCredenciales: ResolverCredenciales;
  /** Versión de Graph API. Se fija por configuración, no se persigue la última. */
  apiVersion?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

interface RespuestaGraph {
  messages?: { id: string }[];
  id?: string;
  url?: string;
  mime_type?: string;
  file_size?: number;
  data?: unknown[];
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

export class AdaptadorWhatsapp implements ChannelAdapter {
  readonly canal = 'whatsapp' as const;
  readonly #resolver: ResolverCredenciales;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opciones: OpcionesDeWhatsapp) {
    this.#resolver = opciones.resolverCredenciales;
    this.#version = opciones.apiVersion ?? 'v21.0';
    this.#fetch = opciones.fetch ?? globalThis.fetch;
    this.#base = opciones.baseUrl ?? 'https://graph.facebook.com';
  }

  capacidades(): CapacidadesDeCanal {
    return {
      canal: 'whatsapp',
      tiposSoportados: [
        'text',
        'image',
        'video',
        'audio',
        'document',
        'sticker',
        'location',
        'template',
      ],
      soportaPlantillas: true,
      soportaComentarios: false,
      respuestasPrivadasPorComentario: null,
      // Cloud API acepta subida directa (media upload) y también enlace.
      requiereUrlPublicaParaMedios: false,
      limitesDeMedios: {
        image: 5 * MB,
        video: 16 * MB,
        audio: 16 * MB,
        document: 100 * MB,
        sticker: 500 * 1024,
      },
      longitudMaximaTexto: 4096,
    };
  }

  politicaDeVentana(): PoliticaDeVentana {
    // 24 h desde el último entrante; el saliente NO reinicia; 72 h si el
    // contacto llega por anuncio Click-to-WhatsApp.
    return { duracionHoras: 24, salienteReinicia: false, entradaGratuitaHoras: 72 };
  }

  // -------------------------------------------------------------------------
  // Envío
  // -------------------------------------------------------------------------

  async sendText(envio: EnvioDeTexto): Promise<ResultadoDeEnvio> {
    this.#validar({ tipo: 'text', longitudTexto: envio.texto.length });
    const cred = await this.#resolver(envio.channelAccountId);
    return this.#enviarMensaje(cred, {
      to: envio.externalUserId,
      type: 'text',
      text: { body: envio.texto, preview_url: false },
      ...(envio.respondeA ? { context: { message_id: envio.respondeA } } : {}),
    });
  }

  async sendMedia(envio: EnvioDeMedia): Promise<ResultadoDeEnvio> {
    const bytes = envio.origen.tipo === 'buffer' ? envio.origen.datos.length : undefined;
    this.#validar({ tipo: envio.tipo, ...(bytes !== undefined ? { bytes } : {}) });
    const cred = await this.#resolver(envio.channelAccountId);

    // Por enlace se envía directo; por bytes hay que subir primero y enviar
    // el `id` que devuelve Meta. Dos viajes, pero evita exponer una URL.
    const referencia =
      envio.origen.tipo === 'url'
        ? { link: envio.origen.url }
        : { id: await this.#subirMedia(cred, envio.origen.datos, envio.origen.mime) };

    const cuerpo: Record<string, unknown> = {
      ...referencia,
      ...(envio.pieDeFoto && envio.tipo !== 'audio' && envio.tipo !== 'sticker'
        ? { caption: envio.pieDeFoto }
        : {}),
      ...(envio.tipo === 'document' && envio.nombreDeArchivo
        ? { filename: envio.nombreDeArchivo }
        : {}),
    };

    return this.#enviarMensaje(cred, {
      to: envio.externalUserId,
      type: envio.tipo,
      [envio.tipo]: cuerpo,
    });
  }

  async sendTemplate(envio: EnvioDePlantilla): Promise<ResultadoDeEnvio> {
    this.#validar({ tipo: 'template' });
    const cred = await this.#resolver(envio.channelAccountId);

    const components: unknown[] = [];
    if (envio.cabecera) {
      components.push({
        type: 'header',
        parameters: [
          { type: envio.cabecera.tipo, [envio.cabecera.tipo]: { link: envio.cabecera.url } },
        ],
      });
    }
    if (envio.parametros.length > 0) {
      components.push({
        type: 'body',
        parameters: envio.parametros.map((texto) => ({ type: 'text', text: texto })),
      });
    }

    return this.#enviarMensaje(cred, {
      to: envio.externalUserId,
      type: 'template',
      template: {
        name: envio.nombre,
        language: { code: envio.idioma },
        ...(components.length ? { components } : {}),
      },
    });
  }

  async replyToComment(_respuesta: RespuestaAComentario): Promise<ResultadoDeEnvio> {
    throw new ErrorDeCanal('tipo_no_soportado', 'WhatsApp no tiene comentarios.', false);
  }

  // -------------------------------------------------------------------------
  // Medios y plantillas
  // -------------------------------------------------------------------------

  /**
   * Dos pasos: GET /{media_id} devuelve una URL firmada de vida corta, y esa
   * URL hay que pedirla con el mismo token. Por eso el worker descarga en
   * cuanto llega el webhook: si espera, la URL caduca.
   */
  async fetchMedia(mediaId: string, channelAccountId: string): Promise<MediaDescargada> {
    const cred = await this.#resolver(channelAccountId);
    const meta = await this.#graph<RespuestaGraph>(cred, 'GET', `/${mediaId}`);
    if (!meta.url) {
      throw new ErrorDeCanal(
        'rechazado_por_proveedor',
        `Meta no devolvió URL para el medio ${mediaId}.`,
        false,
      );
    }
    const r = await this.#fetch(meta.url, {
      headers: { Authorization: `Bearer ${cred.accessToken}` },
    });
    if (!r.ok) throw await this.#errorDesde(r);
    const datos = Buffer.from(await r.arrayBuffer());
    return { datos, mime: meta.mime_type ?? 'application/octet-stream', bytes: datos.length };
  }

  async syncTemplates(channelAccountId: string): Promise<PlantillaSincronizada[]> {
    const cred = await this.#resolver(channelAccountId);
    const r = await this.#graph<RespuestaGraph>(
      cred,
      'GET',
      `/${cred.wabaId}/message_templates?fields=name,language,status,category,quality_score,rejected_reason,id&limit=100`,
    );
    const filas = (r.data ?? []) as Record<string, unknown>[];
    return filas.map((t) => ({
      nombre: String(t['name']),
      idioma: String(t['language']),
      estado: ESTADO_PLANTILLA[String(t['status'])] ?? 'en_revision',
      categoriaEfectiva: t['category'] ? String(t['category']) : null,
      motivoDeRechazo:
        t['rejected_reason'] && t['rejected_reason'] !== 'NONE'
          ? String(t['rejected_reason'])
          : null,
      calidad: (t['quality_score'] as { score?: string } | undefined)?.score ?? null,
      externalId: String(t['id']),
    }));
  }

  // -------------------------------------------------------------------------

  #validar(p: {
    tipo: CapacidadesDeCanal['tiposSoportados'][number];
    bytes?: number;
    longitudTexto?: number;
  }): void {
    const e = validarContraCapacidades(this.capacidades(), p);
    if (e) throw e;
  }

  async #enviarMensaje(
    cred: CredencialesDeWhatsapp,
    cuerpo: Record<string, unknown>,
  ): Promise<ResultadoDeEnvio> {
    const r = await this.#graph<RespuestaGraph>(cred, 'POST', `/${cred.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...cuerpo,
    });
    const id = r.messages?.[0]?.id;
    if (!id) {
      throw new ErrorDeCanal(
        'rechazado_por_proveedor',
        'Meta aceptó la petición pero no devolvió identificador.',
        false,
      );
    }
    // `sent`, nunca `delivered`: la entrega la confirma un webhook de estado.
    return { externalMessageId: id, estado: 'sent', enviadoEn: new Date() };
  }

  async #subirMedia(cred: CredencialesDeWhatsapp, datos: Buffer, mime: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([datos], { type: mime }), 'archivo');
    const r = await this.#fetch(`${this.#base}/${this.#version}/${cred.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.accessToken}` },
      body: form,
    });
    if (!r.ok) throw await this.#errorDesde(r);
    const json = (await r.json()) as RespuestaGraph;
    if (!json.id)
      throw new ErrorDeCanal(
        'rechazado_por_proveedor',
        'La subida del medio no devolvió id.',
        false,
      );
    return json.id;
  }

  async #graph<T>(
    cred: CredencialesDeWhatsapp,
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
      // Red caída, DNS, timeout: reintentable. No es culpa del mensaje.
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
   * Traduce la respuesta de error de Graph a `ErrorDeCanal`.
   *
   * La tabla de códigos está tomada de la documentación de Cloud API. Lo que
   * decide es `reintentable`: reintentar un 190 (token caducado) cinco veces
   * solo gasta cuota; no reintentar un 429 pierde un mensaje que habría salido
   * treinta segundos después.
   */
  async #errorDesde(r: Response): Promise<ErrorDeCanal> {
    let json: RespuestaGraph = {};
    try {
      json = (await r.json()) as RespuestaGraph;
    } catch {
      /* cuerpo no JSON: se decide por el status */
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

    if (r.status === 401 || code === 190 || (code === 0 && r.status === 403))
      return mk('token_invalido', false);
    if (r.status === 429 || code === 4 || code === 80007 || code === 130429 || code === 131056) {
      return mk('limite_de_tasa', true, retryAfter ?? 60);
    }
    if (code === 131047) return mk('fuera_de_ventana', false);
    if (code === 131026 || code === 131021 || code === 131030)
      return mk('destinatario_invalido', false);
    if (code >= 132000 && code <= 132015) return mk('plantilla_no_aprobada', false);
    if (code === 131053 || code === 131052) return mk('medio_demasiado_grande', false);
    if (r.status >= 500 || code === 1 || code === 2 || code === 131000 || code === 131016) {
      return mk('proveedor_no_disponible', true, retryAfter ?? 30);
    }
    return mk('rechazado_por_proveedor', false);
  }
}

const ESTADO_PLANTILLA: Record<string, PlantillaSincronizada['estado']> = {
  APPROVED: 'aprobada',
  PENDING: 'en_revision',
  IN_APPEAL: 'en_revision',
  REJECTED: 'rechazada',
  PAUSED: 'pausada',
  DISABLED: 'deshabilitada',
  PENDING_DELETION: 'deshabilitada',
};
