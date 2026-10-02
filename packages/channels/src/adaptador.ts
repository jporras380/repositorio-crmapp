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
 *
 * ## Cambio autorizado: mensajes con opciones (PR-112, 2026-10-02)
 *
 * El dueño autorizó tocar el contrato para que los bots manden botones y
 * listas de WhatsApp. Se hizo siguiendo la regla de arriba: una capacidad
 * nueva (`interactivos`, `null` si el canal no los tiene) y un método
 * (`sendInteractive`). El núcleo no pregunta «¿es WhatsApp?»: pregunta si el
 * canal tiene opciones y con qué límites, y si no, las manda como texto.
 */
import type { PoliticaDeVentana } from '@crmapp/core';

export type Canal = 'whatsapp' | 'instagram' | 'facebook' | 'tiktok';

export type TipoDeMensaje =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'template'
  /** Texto con opciones para pulsar: botones o lista (PR-112). */
  | 'interactive';

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

  /**
   * Mensajes con opciones para pulsar, y sus límites. `null` = el canal no
   * los tiene, y quien envía los convierte en texto (`interactivoComoTexto`).
   */
  interactivos: LimitesDeInteractivos | null;
}

/** Límites de los mensajes con opciones. Todos en caracteres salvo los máximos. */
export interface LimitesDeInteractivos {
  /** Cuántos botones caben. Con más opciones, lista. */
  botonesMax: number;
  longitudBoton: number;
  /** Cuántas filas caben en una lista. */
  filasMax: number;
  longitudFila: number;
  /** El botón que abre la lista. */
  longitudBotonDeLista: number;
  longitudCuerpo: number;
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
  tipo: Exclude<TipoDeMensaje, 'text' | 'location' | 'template'>;
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
  cabecera?: { tipo: 'image' | 'video' | 'document'; url: string } | undefined;
}

/** Una opción que el contacto puede pulsar. Lo que pulse vuelve como texto: su `titulo`. */
export interface OpcionInteractiva {
  id: string;
  titulo: string;
}

/**
 * Un texto con opciones. Hasta `botonesMax` caben como botones; más, como
 * lista detrás de un botón que la abre.
 */
export type Interactivo =
  | { tipo: 'botones'; cuerpo: string; opciones: readonly OpcionInteractiva[] }
  | {
      tipo: 'lista';
      cuerpo: string;
      /** El texto del botón que despliega la lista: «Ver opciones». */
      textoDelBoton: string;
      opciones: readonly OpcionInteractiva[];
    };

export interface EnvioInteractivo extends DestinoDeEnvio {
  interactivo: Interactivo;
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
  /** Texto con opciones. Un canal con `interactivos: null` lanza `tipo_no_soportado`. */
  sendInteractive(envio: EnvioInteractivo): Promise<ResultadoDeEnvio>;
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

  if (peticion.tipo === 'template' && !capacidades.soportaPlantillas) {
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

/**
 * Comprueba un mensaje con opciones contra los límites del canal.
 *
 * `null` si cabe. Quien envía, si no cabe, lo manda como texto en vez de
 * fallar: un bot que se queda mudo a mitad de conversación es peor que unos
 * botones que llegan escritos.
 */
export function validarInteractivo(
  capacidades: CapacidadesDeCanal,
  i: Interactivo,
): ErrorDeCanal | null {
  const l = capacidades.interactivos;
  const no = (mensaje: string) => new ErrorDeCanal('tipo_no_soportado', mensaje, false);
  if (!l) return no(`El canal ${capacidades.canal} no tiene mensajes con opciones.`);
  if (i.opciones.length === 0) return no('Un mensaje con opciones necesita al menos una.');
  if (i.cuerpo.length > l.longitudCuerpo) {
    return no(`El texto pasa de ${l.longitudCuerpo} caracteres.`);
  }
  if (i.tipo === 'botones') {
    if (i.opciones.length > l.botonesMax) return no(`Caben ${l.botonesMax} botones como mucho.`);
    const larga = i.opciones.find((o) => o.titulo.length > l.longitudBoton);
    if (larga) return no(`«${larga.titulo}» pasa de ${l.longitudBoton} caracteres.`);
    return null;
  }
  if (i.opciones.length > l.filasMax) return no(`Caben ${l.filasMax} opciones como mucho.`);
  if (i.textoDelBoton.length === 0 || i.textoDelBoton.length > l.longitudBotonDeLista) {
    return no(`El botón de la lista necesita texto, hasta ${l.longitudBotonDeLista} caracteres.`);
  }
  const larga = i.opciones.find((o) => o.titulo.length > l.longitudFila);
  if (larga) return no(`«${larga.titulo}» pasa de ${l.longitudFila} caracteres.`);
  return null;
}

/**
 * Las mismas opciones, escritas. Es lo que recibe quien está en un canal sin
 * botones, o cuando unas opciones no caben.
 *
 * Con viñetas y no con números a propósito: el bot reconoce la respuesta por
 * lo que contiene (`condicion`), y alguien que contesta «2» no contiene
 * «Bungalow». Quien lee una lista con viñetas responde con la palabra.
 */
export function interactivoComoTexto(i: Interactivo): string {
  return `${i.cuerpo}\n\n${i.opciones.map((o) => `• ${o.titulo}`).join('\n')}`;
}
