/**
 * Formas que devuelve la API, tal cual. La web no las interpreta: las pinta.
 * Si algo aquí necesitara una regla de negocio, esa regla va a la API.
 */
export interface Sesion {
  token: string;
  tenantId: string;
  userId: string;
  rol: 'owner' | 'admin' | 'supervisor' | 'agent';
}

export interface Yo {
  userId: string;
  tenantId: string;
  rol: Sesion['rol'];
  /** Estado efectivo que calcula la API (packages/core): la web solo lo pinta. */
  suscripcion: 'prueba' | 'activa' | 'gracia' | 'suspendida' | string;
}

export interface Etiqueta {
  id: string;
  nombre: string;
  color: string | null;
}

export interface ResumenDeConversacion {
  id: string;
  canal: 'whatsapp' | 'instagram' | 'tiktok' | string;
  estado: 'open' | 'pending' | 'snoozed' | 'closed' | string;
  /** `dm` o `comment_thread`: se responden distinto. */
  tipo: 'dm' | 'comment_thread' | string;
  publicacionId: string | null;
  contacto: { id: string; nombre: string | null; handle: string | null };
  agenteId: string | null;
  noLeidos: number;
  ultimoEntranteEn: string | null;
  ultimoSalienteEn: string | null;
  ventanaExpiraEn: string | null;
  ventanaAbierta: boolean;
  etiquetas: Etiqueta[];
  vistaPrevia: string | null;
}

export interface Pagina<T> {
  items: T[];
  siguienteCursor: string | null;
}

export interface Mensaje {
  id: string;
  direccion: 'inbound' | 'outbound';
  tipo: string;
  texto: string | null;
  estado: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | string;
  origen: string;
  generado_por_ia: boolean;
  creado_en: string;
  error: { tipo?: string; mensaje?: string } | null;
  medio_id: string | null;
  medio_estado: 'pending' | 'stored' | 'failed' | null;
}

export interface PlantillaSugerida {
  id: string;
  nombre: string;
  idioma: string;
}

export interface RespuestaRapida {
  id: string;
  atajo: string;
  titulo: string;
  cuerpo: string;
  medioId: string | null;
  version: number;
}

export type PeticionDeEnvio =
  | { tipo: 'text'; texto: string }
  | { tipo: 'image' | 'video' | 'audio' | 'document'; mediaAssetId: string; pieDeFoto?: string }
  | { tipo: 'template'; nombre: string; idioma: string; parametros: string[] }
  | { tipo: 'quick_reply'; quickReplyId: string }
  | { tipo: 'comment_reply'; modo: 'publica' | 'privada'; texto: string; comentarioId?: string };

export interface CuentaDeCanal {
  id: string;
  canal: string;
  externalId: string;
  providerAccountId: string | null;
  displayName: string;
  status: 'connected' | 'degraded' | 'blocked' | 'disconnected' | string;
  /** `false` = conectado pero el proveedor no nos manda sus webhooks. */
  webhookSuscrito: boolean | null;
  lastEventAt: string | null;
  createdAt: string;
}

export interface PlantillaDeWhatsapp {
  id: string;
  nombre: string;
  idioma: string;
  estado: string;
  categoriaDeclarada: string | null;
  categoriaEfectiva: string | null;
  calidad: string | null;
  motivoDeRechazo: string | null;
  metaTemplateId: string | null;
  ultimaSincronizacion: string | null;
}

export interface ResumenDeUso {
  periodo: string;
  desde: string;
  plan: string | null;
  uso: Record<string, number>;
  limites: Record<string, { limite: number | null; usado: number | null }>;
}

export interface ResumenDelPanel {
  atencion: { sinResponder: number; ventanasPorCerrar: number; sinAsignar: number };
  conversaciones: { abiertas: number; pendientes: number; cerradasHoy: number };
  actividadHoy: { canal: string; entrantes: number; salientes: number }[];
  respuesta: { medianaSegundos: number | null; conversacionesMedidas: number };
  uso: Record<string, number>;
  periodo: string;
}

export interface FiltrosDeBandeja {
  canal?: string | undefined;
  tipo?: string | undefined;
  estado?: string | undefined;
  agenteId?: string | undefined;
  etiquetaId?: string | undefined;
  sinRespuesta?: boolean | undefined;
  cursor?: string | undefined;
}

// ---------------------------------------------------------------------------
// Salesbots
// ---------------------------------------------------------------------------

export type NodoDeFlujo =
  | { id: string; tipo: 'mensaje'; texto: string; siguiente: string | null }
  | {
      id: string;
      tipo: 'esperar_respuesta';
      segundos: number;
      siguiente: string | null;
      alExpirar: string | null;
    }
  | {
      id: string;
      tipo: 'condicion';
      casos: { contiene: string[]; siguiente: string | null }[];
      siNo: string | null;
    }
  | { id: string; tipo: 'pausa'; segundos: number; siguiente: string | null }
  | { id: string; tipo: 'etiquetar'; etiquetaId: string; siguiente: string | null }
  | { id: string; tipo: 'asignar'; usuarioId: string; siguiente: string | null }
  | { id: string; tipo: 'fin'; cerrarConversacion?: boolean };

export interface GrafoDeFlujo {
  inicio: string;
  nodos: NodoDeFlujo[];
}

export interface DisparadorDeFlujo {
  tipo: 'conversacion_abierta' | 'palabra_clave';
  palabras?: string[] | null;
  activo?: boolean;
}

export interface ProblemaDeFlujo {
  codigo: string;
  mensaje: string;
  nodoId?: string;
}

export interface ResumenDeFlujo {
  id: string;
  nombre: string;
  estado: 'borrador' | 'activo' | 'pausado' | string;
  /** Versión PUBLICADA; `null` mientras sea borrador. */
  version: number | null;
  disparadores: DisparadorDeFlujo[];
  ejecucionesVivas: number;
  creadoEn: string;
}

export interface DetalleDeFlujo extends ResumenDeFlujo {
  grafo: GrafoDeFlujo | null;
  problemas: ProblemaDeFlujo[];
}

export type EfectoDeFlujo =
  | { tipo: 'enviar_texto'; texto: string }
  | { tipo: 'etiquetar'; etiquetaId: string }
  | { tipo: 'asignar'; usuarioId: string }
  | { tipo: 'cerrar_conversacion' };

export interface SimulacionDeFlujo {
  pasos: { nodoId: string; tipo: string; efectos: EfectoDeFlujo[]; entrada?: string }[];
  final: 'fin' | 'esperando' | 'sin_respuestas' | 'limite_de_pasos';
  problemas: ProblemaDeFlujo[];
}

export interface EjecucionDeFlujo {
  id: string;
  conversacionId: string;
  estado: string;
  nodoActual: string | null;
  esperaHasta: string | null;
  error: string | null;
  iniciadaEn: string;
  terminadaEn: string | null;
  pasos: { nodoId: string; tipo: string; error: string | null; en: string }[];
}

export interface Miembro {
  id: string;
  nombre: string;
  rol: Sesion['rol'];
}

export interface ResumenDeSuscripcion {
  plan: { codigo: string; nombre: string; precioPorAsientoCentimos: number; moneda: string } | null;
  estado: 'prueba' | 'activa' | 'gracia' | 'suspendida' | string;
  /** Asientos OCUPADOS: se cuentan de los miembros, no se guardan (ADR-011). */
  asientos: number;
  importeMensualCentimos: number;
  pruebaHasta: string | null;
  periodoHasta: string | null;
  graciaHasta: string | null;
  pagos: {
    importeCentimos: number;
    moneda: string;
    cubreDesde: string;
    cubreHasta: string;
    metodo: string;
    referencia: string | null;
  }[];
  avisos: { limite: string; nivel: 'holgado' | 'cerca' | 'pasado'; usado: number; tope: number }[];
}

// ---------------------------------------------------------------------------
// Embudo de ventas
// ---------------------------------------------------------------------------

export type TipoDeEtapa = 'abierta' | 'ganada' | 'perdida';

export interface EtapaDeEmbudo {
  id: string;
  nombre: string;
  color: string | null;
  tipo: TipoDeEtapa;
  posicion: number;
}

export interface Embudo {
  id: string;
  nombre: string;
  /** ISO 4217. La interfaz la pinta, no la convierte. */
  moneda: string;
  porDefecto: boolean;
  etapas: EtapaDeEmbudo[];
}

export interface TarjetaDeLead {
  id: string;
  titulo: string;
  /** En céntimos: el servidor no sabe de comas y la interfaz tampoco debería. */
  importe: number;
  contacto: { id: string; nombre: string | null };
  conversacionId: string | null;
  canal: string | null;
  responsableId: string | null;
  etiquetas: Etiqueta[];
  creadoEn: string;
  actualizadoEn: string;
}

export interface ColumnaDelTablero {
  etapa: EtapaDeEmbudo;
  total: number;
  importe: number;
  tarjetas: TarjetaDeLead[];
}

export interface Tablero {
  embudo: { id: string; nombre: string; moneda: string };
  columnas: ColumnaDelTablero[];
  pronostico: number;
  leadsAbiertos: number;
}

export interface DetalleDeLead extends TarjetaDeLead {
  embudoId: string;
  etapaId: string;
  estado: 'abierto' | 'ganado' | 'perdido';
  cerradoEn: string | null;
  historial: {
    tipo: string;
    desde: string | null;
    hasta: string | null;
    actorId: string | null;
    en: string;
  }[];
}
