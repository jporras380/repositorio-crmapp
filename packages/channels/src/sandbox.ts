/**
 * Adaptador de pruebas.
 *
 * **Es la mitigación del riesgo principal del proyecto**, no una comodidad
 * para los tests. El ARCH lo pide en fase 0 por un motivo: antes de enviar un
 * mensaje real hacen falta verificación de empresa, App Review y un número con
 * calidad aceptable, y ninguno de esos plazos los controlamos. Con esto,
 * ninguna fase de desarrollo depende de tener credenciales.
 *
 * Se comporta como un canal de verdad en lo que importa: valida contra sus
 * capacidades, aplica su política de ventana, devuelve identificadores únicos
 * y **sabe fallar**. Un doble que solo sabe tener éxito no prueba el camino de
 * error, que es donde están los bugs.
 *
 * Sus capacidades imitan a WhatsApp a propósito: si el núcleo funciona contra
 * esto, la sorpresa al conectar el canal real es menor.
 */
import type { PoliticaDeVentana } from '@crmapp/core';
import {
  ErrorDeCanal,
  validarContraCapacidades,
  type CapacidadesDeCanal,
  type Canal,
  type ChannelAdapter,
  type EnvioDeMedia,
  type EnvioDePlantilla,
  type EnvioDeTexto,
  type MediaDescargada,
  type PlantillaSincronizada,
  type RespuestaAComentario,
  type ResultadoDeEnvio,
  type TipoDeErrorDeCanal,
  type TipoDeMensaje,
} from './adaptador.js';

const MB = 1024 * 1024;

export interface EnvioRegistrado {
  tipo: TipoDeMensaje | 'comentario';
  destino: string;
  contenido: unknown;
  externalMessageId: string;
  en: Date;
}

export interface OpcionesDeSandbox {
  canal?: Canal;
  /** Reloj inyectable, para probar ventanas sin esperar 24 horas. */
  ahora?: () => Date;
  /** Fuerza un fallo en el próximo envío. Para probar el camino de error. */
  fallarCon?: { tipo: TipoDeErrorDeCanal; reintentable: boolean } | null;
  /** Plantillas que devuelve `syncTemplates`. */
  plantillas?: PlantillaSincronizada[];
}

export class AdaptadorSandbox implements ChannelAdapter {
  readonly canal: Canal;
  readonly #ahora: () => Date;
  readonly enviados: EnvioRegistrado[] = [];
  #contador = 0;
  #fallarCon: OpcionesDeSandbox['fallarCon'];
  #plantillas: PlantillaSincronizada[];

  constructor(opciones: OpcionesDeSandbox = {}) {
    this.canal = opciones.canal ?? 'whatsapp';
    this.#ahora = opciones.ahora ?? (() => new Date());
    this.#fallarCon = opciones.fallarCon ?? null;
    this.#plantillas = opciones.plantillas ?? [];
  }

  capacidades(): CapacidadesDeCanal {
    // Instagram y Facebook comparten forma: sin plantillas, con comentarios y
    // medios salientes por URL.
    const deMeta = this.canal === 'instagram' || this.canal === 'facebook';
    return {
      canal: this.canal,
      tiposSoportados: (
        ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'template'] as const
      ).filter((t) => !deMeta || t !== 'template'),
      // Imita lo que cada canal real declara, para que los tests de API y
      // worker ejerciten el mismo camino que en producción.
      soportaPlantillas: !deMeta,
      soportaComentarios: deMeta,
      respuestasPrivadasPorComentario: deMeta ? 1 : null,
      requiereUrlPublicaParaMedios: deMeta,
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
    return { duracionHoras: 24, salienteReinicia: false, entradaGratuitaHoras: 72 };
  }

  /** Programa el siguiente envío para que falle. Se consume al usarse. */
  programarFallo(fallo: OpcionesDeSandbox['fallarCon']): void {
    this.#fallarCon = fallo;
  }

  limpiar(): void {
    this.enviados.length = 0;
    this.#contador = 0;
    this.#fallarCon = null;
  }

  #comprobarFallo(): void {
    if (!this.#fallarCon) return;
    const f = this.#fallarCon;
    // Se consume: si no, un fallo programado haría fallar todos los envíos
    // siguientes y el test siguiente heredaría el estado.
    this.#fallarCon = null;
    throw new ErrorDeCanal(
      f.tipo,
      `Fallo simulado por el sandbox: ${f.tipo}.`,
      f.reintentable,
      f.tipo === 'limite_de_tasa' ? 30 : undefined,
    );
  }

  #registrar(tipo: EnvioRegistrado['tipo'], destino: string, contenido: unknown): ResultadoDeEnvio {
    const en = this.#ahora();
    this.#contador += 1;
    // Prefijo `sandbox.` para que sea imposible confundir un identificador
    // simulado con uno real si acaba en la base por error.
    const externalMessageId = `sandbox.${this.canal}.${en.getTime()}.${this.#contador}`;
    this.enviados.push({ tipo, destino, contenido, externalMessageId, en });
    return { externalMessageId, estado: 'sent', enviadoEn: en };
  }

  #validar(tipo: TipoDeMensaje, extra: { bytes?: number; longitudTexto?: number }): void {
    const error = validarContraCapacidades(this.capacidades(), { tipo, ...extra });
    if (error) throw error;
  }

  async sendText(envio: EnvioDeTexto): Promise<ResultadoDeEnvio> {
    this.#comprobarFallo();
    this.#validar('text', { longitudTexto: envio.texto.length });
    return this.#registrar('text', envio.externalUserId, { texto: envio.texto });
  }

  async sendMedia(envio: EnvioDeMedia): Promise<ResultadoDeEnvio> {
    this.#comprobarFallo();
    const bytes = envio.origen.tipo === 'buffer' ? envio.origen.datos.length : undefined;
    this.#validar(envio.tipo, bytes !== undefined ? { bytes } : {});
    return this.#registrar(envio.tipo, envio.externalUserId, {
      origen: envio.origen.tipo,
      pieDeFoto: envio.pieDeFoto,
      // Se registra para que los tests puedan comprobar que el nombre del
      // fichero llega hasta el canal, que es lo que ve el cliente.
      nombreDeArchivo: envio.nombreDeArchivo,
    });
  }

  async sendTemplate(envio: EnvioDePlantilla): Promise<ResultadoDeEnvio> {
    this.#comprobarFallo();
    this.#validar('template', {});

    const conocida = this.#plantillas.find(
      (p) => p.nombre === envio.nombre && p.idioma === envio.idioma,
    );
    // Solo se rechaza si la plantilla está registrada Y no aprobada. Una
    // plantilla desconocida se acepta, para no obligar a declararlas todas en
    // cada test.
    if (conocida && conocida.estado !== 'aprobada') {
      throw new ErrorDeCanal(
        'plantilla_no_aprobada',
        `La plantilla "${envio.nombre}" está en estado "${conocida.estado}".`,
        false,
      );
    }

    return this.#registrar('template', envio.externalUserId, {
      nombre: envio.nombre,
      parametros: envio.parametros,
    });
  }

  async replyToComment(respuesta: RespuestaAComentario): Promise<ResultadoDeEnvio> {
    this.#comprobarFallo();
    if (!this.capacidades().soportaComentarios) {
      throw new ErrorDeCanal(
        'tipo_no_soportado',
        `El canal ${this.canal} no admite comentarios.`,
        false,
      );
    }
    return this.#registrar('comentario', respuesta.comentarioId, respuesta);
  }

  // Firma completa aunque no use `channelAccountId`: el sandbox existe para
  // sustituir a un adaptador real, y una firma recortada dejaria pasar
  // llamadas que el canal de verdad rechazaria.
  async fetchMedia(mediaId: string, _channelAccountId: string): Promise<MediaDescargada> {
    this.#comprobarFallo();
    const datos = Buffer.from(`contenido simulado de ${mediaId}`, 'utf8');
    return { datos, mime: 'application/octet-stream', bytes: datos.length };
  }

  async syncTemplates(_channelAccountId?: string): Promise<PlantillaSincronizada[]> {
    this.#comprobarFallo();
    return [...this.#plantillas];
  }
}
