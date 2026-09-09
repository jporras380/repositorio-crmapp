/**
 * Contrato de adaptador de canal (ARCH §8).
 *
 * **Cambiar este archivo una vez implementado el primer canal está en la lista
 * de parada del prompt maestro.** El motivo es concreto: si el contrato se
 * define con un solo canal delante, se contamina con detalles de Meta, y el
 * tercer canal obliga a tocar el núcleo. La prueba de que está bien planteado
 * llega en fase 2 con Instagram — si Instagram entra sin tocar `core`, sirve.
 *
 * De ahí la regla que gobierna el diseño: **el núcleo pregunta capacidades, no
 * asume**. TikTok puede no tener plantillas ni ventana; Instagram limita la
 * respuesta privada a una por comentario y exige URL pública para los medios;
 * WhatsApp acepta subida directa. Nada de eso puede ser un `if` en el núcleo.
 */
import type { PoliticaDeVentana } from '@crmapp/core';

export type Canal = 'whatsapp' | 'instagram' | 'tiktok';

export type TipoDeMensaje =
  'texto' | 'imagen' | 'video' | 'audio' | 'documento' | 'sticker' | 'ubicacion' | 'plantilla';

// ---------------------------------------------------------------------------
// Capacidades
// ---------------------------------------------------------------------------

export interface CapacidadesDeCanal {
  canal: Canal;

  /** Qué puede enviar. Lo que no esté aquí, el núcleo ni lo intenta. */
  tiposSoportados: readonly TipoDeMensaje[];

  soportaPlantillas: boolean;
  soportaComentarios: boolean;

  /**
   * Cuántas respuestas privadas admite un comentario. `null` = sin límite.
   *
   * Instagram permite **una**, y no se recupera. Es un dato que el producto
   * tiene que mostrar ANTES de enviar: si el agente gasta la única respuesta
   * privada en un saludo, no hay segunda oportunidad.
   */
  respuestasPrivadasPorComentario: number | null;

  /**
   * Si los medios salientes necesitan estar en una URL pública.
   *
   * Instagram sí, WhatsApp no —acepta subida directa—. Es capacidad y no `if`
   * porque determina cómo se configura el almacenamiento: si algún canal la
   * exige, el bucket no puede ser privado del todo.
   */
  requiereUrlPublicaParaMedios: boolean;

  /** Tamaño máximo por tipo, en bytes. Validar antes de enviar, no después. */
  limitesDeMedios: Partial<Record<TipoDeMensaje, number>>;

  /** Longitud máxima del cuerpo de texto. */
  longitudMaximaTexto: number;
}

// ---------------------------------------------------------------------------
// Peticiones y resultados
// ---------------------------------------------------------------------------

export interface DestinoDeEnvio {
  /** Identificador del destinatario en el proveedor. */
  externalUserId: string;
  /** Cuenta de canal desde la que se envía. */
  channelAccountId: string;
}

export interface EnvioDeTexto extends DestinoDeEnvio {
  texto: string;
  /** Para responder citando otro mensaje, donde el canal lo soporte. */
  respondeA?: string | undefined;
}

export interface EnvioDeMedia extends DestinoDeEnvio {
  tipo: Exclude<TipoDeMensaje, 'texto' | 'ubicacion' | 'plantilla'>;
  /** Bytes o URL pública, según lo que exija el canal. */
  origen: { tipo: 'buffer'; datos: Buffer; mime: string } | { tipo: 'url'; url: string };
  pieDeFoto?: string | undefined;
  nombreDeArchivo?: string | undefined;
}

export interface EnvioDePlantilla extends DestinoDeEnvio {
  nombre: string;
  idioma: string;
  /** Parámetros numerados, en orden. */
  parametros: readonly string[];
  cabecera?: { tipo: 'imagen' | 'video' | 'documento'; url: string } | undefined;
}

export interface RespuestaAComentario {
  channelAccountId: string;
  comentarioId: string;
  texto: string;
  /** Pública en el hilo, o privada por mensaje directo. */
  modo: 'publica' | 'privada';
}

export interface ResultadoDeEnvio {
  /** Identificador del proveedor. Es la clave de idempotencia (ADR-006). */
  externalMessageId: string;
  /**
   * Estado con el que nace el mensaje.
   *
   * Casi siempre `sent`: la entrega la confirma un webhook posterior. Un
   * adaptador que devolviera `delivered` aquí estaría mintiendo.
   */
  estado: 'sent' | 'queued';
  enviadoEn: Date;
}

export interface MediaDescargada {
  datos: Buffer;
  mime: string;
  bytes: number;
  /** Nombre original, cuando el proveedor lo da. */
  nombreDeArchivo?: string | undefined;
}

export interface PlantillaSincronizada {
  nombre: string;
  idioma: string;
  estado: 'borrador' | 'en_revision' | 'aprobada' | 'rechazada' | 'pausada' | 'deshabilitada';
  categoriaEfectiva: string | null;
  motivoDeRechazo: string | null;
  calidad: string | null;
  externalId: string;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type TipoDeErrorDeCanal =
  | 'limite_de_tasa'
  | 'token_invalido'
  | 'fuera_de_ventana'
  | 'medio_demasiado_grande'
  | 'tipo_no_soportado'
  | 'destinatario_invalido'
  | 'plantilla_no_aprobada'
  | 'proveedor_no_disponible'
  | 'rechazado_por_proveedor';

/**
 * Error tipado de canal.
 *
 * `reintentable` no es informativo: es lo que decide si el job vuelve a la
 * cola con backoff o se manda a la cola muerta. Sin ese dato, el worker o
 * reintenta un token inválido cinco veces —y sigue inválido— o descarta un
 * corte de red que se habría resuelto solo.
 */
export class ErrorDeCanal extends Error {
  constructor(
    readonly tipo: TipoDeErrorDeCanal,
    mensaje: string,
    readonly reintentable: boolean,
    /** Segundos que pide esperar el proveedor, si lo indica. */
    readonly reintentarEnSegundos?: number,
    readonly detalleDelProveedor?: unknown,
  ) {
    super(mensaje);
    this.name = 'ErrorDeCanal';
  }
}

/** Los tipos que siempre conviene reintentar, para no decidirlo caso a caso. */
export const ERRORES_REINTENTABLES: readonly TipoDeErrorDeCanal[] = [
  'limite_de_tasa',
  'proveedor_no_disponible',
];

// ---------------------------------------------------------------------------
// El contrato
// ---------------------------------------------------------------------------

export interface ChannelAdapter {
  readonly canal: Canal;

  /** Qué soporta este canal. El núcleo pregunta, no asume. */
  capacidades(): CapacidadesDeCanal;

  /** Duración y reglas de la ventana. La aplica `@crmapp/core`. */
  politicaDeVentana(): PoliticaDeVentana;

  sendText(envio: EnvioDeTexto): Promise<ResultadoDeEnvio>;
  sendMedia(envio: EnvioDeMedia): Promise<ResultadoDeEnvio>;
  sendTemplate(envio: EnvioDePlantilla): Promise<ResultadoDeEnvio>;
  replyToComment(respuesta: RespuestaAComentario): Promise<ResultadoDeEnvio>;

  /** Descarga un medio entrante antes de que caduque su URL firmada. */
  fetchMedia(mediaId: string, channelAccountId: string): Promise<MediaDescargada>;

  /** Estado y calidad de las plantillas, tal como los tiene el proveedor. */
  syncTemplates(channelAccountId: string): Promise<PlantillaSincronizada[]>;
}

// ---------------------------------------------------------------------------
// Validación previa
// ---------------------------------------------------------------------------

/**
 * Comprueba un envío contra las capacidades ANTES de llamar al proveedor.
 *
 * Ahorra un viaje de red y, sobre todo, da un error entendible: el mensaje que
 * devuelve Meta cuando un vídeo pasa de tamaño no dice cuál es el límite.
 */
export function validarContraCapacidades(
  capacidades: CapacidadesDeCanal,
  peticion: { tipo: TipoDeMensaje; bytes?: number; longitudTexto?: number },
): ErrorDeCanal | null {
  if (!capacidades.tiposSoportados.includes(peticion.tipo)) {
    return new ErrorDeCanal(
      'tipo_no_soportado',
      `El canal ${capacidades.canal} no admite mensajes de tipo "${peticion.tipo}".`,
      false,
    );
  }

  if (peticion.tipo === 'plantilla' && !capacidades.soportaPlantillas) {
    return new ErrorDeCanal(
      'tipo_no_soportado',
      `El canal ${capacidades.canal} no admite plantillas.`,
      false,
    );
  }

  const limite = capacidades.limitesDeMedios[peticion.tipo];
  if (limite !== undefined && peticion.bytes !== undefined && peticion.bytes > limite) {
    return new ErrorDeCanal(
      'medio_demasiado_grande',
      `El archivo pesa ${Math.round(peticion.bytes / 1024)} KB y el límite de ` +
        `${capacidades.canal} para "${peticion.tipo}" es ${Math.round(limite / 1024)} KB.`,
      false,
    );
  }

  if (
    peticion.longitudTexto !== undefined &&
    peticion.longitudTexto > capacidades.longitudMaximaTexto
  ) {
    return new ErrorDeCanal(
      'rechazado_por_proveedor',
      `El texto tiene ${peticion.longitudTexto} caracteres y el límite de ` +
        `${capacidades.canal} es ${capacidades.longitudMaximaTexto}.`,
      false,
    );
  }

  return null;
}
