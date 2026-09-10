/**
 * Definición de colas y trabajos (ARCH §10).
 *
 * Colas por CLASE DE TRABAJO, no por inquilino (ADR-003). Una cola por
 * inquilino implicaría un worker con conexión bloqueante propia por cliente:
 * el coste en Redis y en operación crecería lineal con las ventas, que es la
 * peor forma de que crezca un coste.
 *
 * Los nombres y las cargas van tipados aquí para que publicar un trabajo con
 * la forma equivocada sea un error de compilación y no un fallo silencioso en
 * un worker a las tres de la mañana.
 */
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

export const COLAS = {
  /** Webhooks entrantes ya persistidos, listos para procesar. */
  ingestaEntrante: 'inbound-ingest',
  /** Envíos salientes, una cola por canal: sus límites de tasa son distintos. */
  salidaWhatsapp: 'outbound-whatsapp',
  salidaInstagram: 'outbound-instagram',
  /** Descarga, transcodificación y miniaturas. */
  media: 'media',
  /** Avance de flujos de Salesbot. */
  flujos: 'flows',
  /** Llamadas a proveedores de IA. */
  ia: 'ai',
  /** Correo saliente: invitaciones, avisos de plan. */
  correo: 'email',
  /** Mantenimiento: precreación de particiones, purgas, refresco de vistas. */
  mantenimiento: 'maintenance',
} as const;

export type NombreDeCola = (typeof COLAS)[keyof typeof COLAS];

/**
 * Todo trabajo lleva inquilino y correlación.
 *
 * `tenantId` no es opcional: es lo que necesita el semáforo para repartir y lo
 * que necesita el worker para abrir su transacción con `SET LOCAL`. Un trabajo
 * sin inquilino no se puede procesar de forma aislada, así que el tipo lo
 * impide en vez de dejarlo a la disciplina.
 */
export interface TrabajoBase {
  tenantId: string;
  correlationId: string;
}

export interface TrabajoDeCorreo extends TrabajoBase {
  tipo: 'invitacion' | 'aviso_de_plan';
  para: string;
  datos: Record<string, unknown>;
}

export interface TrabajoDeIngesta extends TrabajoBase {
  inboundEventId: string;
  inboundEventCreatedAt: string;
}

export interface TrabajoDeEnvio extends TrabajoBase {
  messageId: string;
  /** Carga completa del outbox; el worker no vuelve a leer la peticion. */
  carga: unknown;
}

export interface TrabajoDeMedia extends TrabajoBase {
  mediaAssetId: string;
  /** Carga completa del outbox (`media.descargar`). */
  carga: unknown;
}

/**
 * Avance de un Salesbot. Un solo tipo de trabajo con tres sucesos posibles,
 * en vez de tres colas: el motor es el mismo y así el semáforo por inquilino
 * cuenta todo lo que hace un bot junto, que es lo que de verdad hay que
 * limitar.
 */
export interface TrabajoDeFlujo extends TrabajoBase {
  evento:
    /** Entró un mensaje del contacto: puede disparar un flujo o reanudar uno. */
    | { tipo: 'mensaje_recibido'; conversationId: string; messageId: string }
    /** Venció la espera de una ejecución concreta. */
    | { tipo: 'despertar'; flowRunId: string };
}

export interface TrabajoDeMantenimiento extends TrabajoBase {
  tarea:
    | 'precrear_particiones'
    | 'purgar_message_keys'
    | 'refrescar_vistas'
    /** Red de seguridad de ADR-002: esperas de Salesbot que nadie despertó. */
    | 'despertar_flujos';
}

export interface MapaDeTrabajos {
  [COLAS.correo]: TrabajoDeCorreo;
  [COLAS.ingestaEntrante]: TrabajoDeIngesta;
  [COLAS.salidaWhatsapp]: TrabajoDeEnvio;
  [COLAS.salidaInstagram]: TrabajoDeEnvio;
  [COLAS.media]: TrabajoDeMedia;
  [COLAS.flujos]: TrabajoDeFlujo;
  [COLAS.mantenimiento]: TrabajoDeMantenimiento;
}

/**
 * Opciones por defecto.
 *
 * `removeOnComplete` acotado: sin él, Redis acumula el historial de todos los
 * trabajos completados hasta llenarse. `removeOnFail` mucho más generoso,
 * porque un fallo sin rastro no se puede diagnosticar.
 *
 * Backoff exponencial por defecto (ARCH §9). El límite de tasa concreto de
 * cada canal se aplica en su worker, con el valor sincronizado desde
 * `channel_accounts.limits` — nunca codificado.
 */
export const OPCIONES_POR_DEFECTO: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function crearCola<N extends NombreDeCola>(nombre: N, connection: ConnectionOptions): Queue {
  return new Queue(nombre, { connection, defaultJobOptions: OPCIONES_POR_DEFECTO });
}
