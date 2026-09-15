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

/** Etiqueta con dónde se usa, para el apartado donde se administran. */
export interface EtiquetaConUso {
  id: string;
  nombre: string;
  color: string | null;
  usos: { conversaciones: number; clientes: number; leads: number };
  bots: string[];
}

export interface Etiqueta {
  id: string;
  nombre: string;
  color: string | null;
}

export interface ResumenDeConversacion {
  id: string;
  canal: 'whatsapp' | 'instagram' | 'facebook' | 'tiktok' | string;
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
  /** Calculado al leer, nunca guardado a mano: por eso no puede mentir. */
  atencion: EstadoDeAtencion;
  aplazadaHasta: string | null;
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
  | { tipo: 'text'; texto: string; generadoPorIa?: boolean }
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

/** Números que ve un token de WhatsApp, para elegir en vez de copiar ids. */
export interface DescubrimientoWhatsapp {
  cuentas: {
    wabaId: string;
    nombre: string | null;
    numeros: {
      phoneNumberId: string;
      numero: string;
      nombreVerificado: string;
      calidad: string | null;
      yaConectado: boolean;
    }[];
  }[];
  /** Meta no deja listar las cuentas con este token: hace falta el id de WABA. */
  necesitaWaba: boolean;
  caducaEn: string | null;
}

/** Página de Facebook que ve un token (sin su token de página). */
export interface PaginaDeFacebookDescubierta {
  paginaId: string;
  pagina: string;
  yaConectado: boolean;
}

export interface CuentaDeInstagramDescubierta {
  igUserId: string;
  usuario: string | null;
  paginaId: string;
  pagina: string;
  yaConectado: boolean;
}

/** Ajustes de la IA asistida. La clave no viaja nunca de vuelta: solo si existe. */
export interface AjustesDeIa {
  activa: boolean;
  modelo: string;
  instrucciones: string;
  tieneClave: boolean;
  modelosDisponibles: string[];
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

export type ClaveDePeriodo = '24h' | '7d' | '30d';

/** Cómo fue el periodo (§15). Ventanas móviles; mediana y p90, no media. */
export interface InformeDelPeriodo {
  periodo: { clave: ClaveDePeriodo; desde: string; hasta: string };
  conversaciones: {
    nuevas: number;
    porCanal: { canal: string; nuevas: number }[];
    atencionAhora: Record<EstadoDeAtencion, number>;
  };
  respuesta: { medianaSegundos: number | null; p90Segundos: number | null; medidas: number };
  agentes: {
    id: string;
    nombre: string;
    asignadasAbiertas: number;
    porResponder: number;
    respuestasEnviadas: number;
  }[];
  clientesNuevos: number;
  reservas: {
    generadas: number;
    confirmadas: number;
    canceladas: number;
    porMoneda: { moneda: string; confirmado: number; cobrado: number }[];
  };
  embudo: { consultas: number; conReserva: number; perdidas: number };
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
  /** Estado de atención, deducido por el servidor (0020). */
  atencion?: string | undefined;
  /** Busca por nombre del contacto, su @ o su teléfono. */
  q?: string | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
  etapaId?: string | undefined;
  cursor?: string | undefined;
}

export type EstadoDeAtencion =
  'nueva' | 'por_responder' | 'esperando_cliente' | 'seguimiento' | 'cerrada';

/** Un filtro compuesto con nombre, guardado por agente. */
export interface VistaDeBandeja {
  id: string;
  nombre: string;
  filtros: Record<string, string>;
  posicion: number;
}

export interface NotaInterna {
  id: string;
  cuerpo: string;
  autorId: string | null;
  autor: string | null;
  creadaEn: string;
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

// ---------------------------------------------------------------------------
// Clientes
// ---------------------------------------------------------------------------

export type OrigenDeCliente = 'whatsapp' | 'instagram' | 'facebook' | 'tiktok' | 'web' | 'otro';

export interface ResumenDeCliente {
  id: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  ciudad: string | null;
  origen: string;
  tipoDeHuesped: string | null;
  etiquetas: Etiqueta[];
  /** Canales por los que ha escrito; sale de sus identidades. */
  canales: string[];
  creadoEn: string;
  ultimaActividad: string | null;
}

export interface FichaDeCliente extends ResumenDeCliente {
  notas: string | null;
  identidades: { canal: string; handle: string | null; telefono: string | null }[];
  conversaciones: { id: string; canal: string; estado: string; ultimoMensajeEn: string | null }[];
  reservas: {
    id: string;
    titulo: string;
    etapa: string;
    estado: string;
    importe: number;
    creadoEn: string;
  }[];
}

export interface DatosDeCliente {
  nombre?: string | null;
  telefono?: string | null;
  email?: string | null;
  ciudad?: string | null;
  origen?: OrigenDeCliente;
  tipoDeHuesped?: string | null;
  notas?: string | null;
  etiquetas?: string[];
}

export interface ResultadoDeImportacion {
  creados: number;
  actualizados: number;
  omitidos: number;
  errores: { linea: number; motivo: string }[];
  columnasIgnoradas: string[];
}

// ---------------------------------------------------------------------------
// Hotel
// ---------------------------------------------------------------------------

export type EstadoDeHabitacion = 'disponible' | 'mantenimiento' | 'fuera_de_servicio';
export type UnidadDeServicio = 'por_estancia' | 'por_noche' | 'por_persona_noche';

export interface Habitacion {
  id: string;
  tipoId: string;
  nombre: string;
  estado: EstadoDeHabitacion;
  notas: string | null;
}

export interface Tarifa {
  id: string;
  tipoId: string;
  nombre: string;
  /** `YYYY-MM-DD`, inclusive. */
  desde: string;
  hasta: string;
  /** Céntimos por noche. */
  precio: number;
  minNoches: number;
  /** 0 = domingo … 6 = sábado; `null` = todos. */
  dias: number[] | null;
}

export interface TipoDeHabitacion {
  id: string;
  nombre: string;
  descripcion: string | null;
  capacidad: number;
  precioBase: number | null;
  moneda: string;
  activo: boolean;
  habitaciones: Habitacion[];
  tarifas: Tarifa[];
}

export interface ServicioDeHotel {
  id: string;
  nombre: string;
  precio: number;
  moneda: string;
  unidad: UnidadDeServicio;
  activo: boolean;
}

export interface CatalogoDeHotel {
  tipos: TipoDeHabitacion[];
  servicios: ServicioDeHotel[];
}

export interface Cotizacion {
  tipo: string;
  noches: number;
  personas: number;
  moneda: string;
  detalle: { fecha: string; precio: number; tarifa: string | null }[];
  alojamiento: number;
  servicios: { nombre: string; cantidad: number; precioUnitario: number; total: number }[];
  total: number;
  problemas: { codigo: string; mensaje: string; fecha?: string }[];
  /** `false` si falta el precio de alguna noche: esa cifra no se le da a un cliente. */
  completa: boolean;
}

// ---------------------------------------------------------------------------
// Reservas
// ---------------------------------------------------------------------------

export type EstadoDeReserva = 'pendiente' | 'confirmada' | 'en_casa' | 'finalizada' | 'cancelada';
export type AccionDeReserva = 'confirmar' | 'llegar' | 'salir' | 'cancelar';
export type MetodoDePago = 'efectivo' | 'transferencia' | 'yape' | 'plin' | 'tarjeta' | 'otro';

export interface ResumenDeReserva {
  id: string;
  estado: EstadoDeReserva;
  contacto: { id: string; nombre: string | null };
  tipo: string;
  habitacion: string | null;
  entrada: string;
  salida: string;
  noches: number;
  personas: number;
  total: number;
  pagado: number;
  moneda: string;
  conversacionId: string | null;
  creadaEn: string;
}

export interface DetalleDeReserva extends ResumenDeReserva {
  tipoId: string;
  habitacionId: string | null;
  leadId: string | null;
  notas: string | null;
  lineas: {
    tipo: 'noche' | 'servicio' | 'descuento';
    descripcion: string;
    noche: string | null;
    cantidad: number;
    unitario: number;
    total: number;
  }[];
  pagos: {
    id: string;
    importe: number;
    metodo: MetodoDePago;
    referencia: string | null;
    pagadoEn: string;
  }[];
  historial: {
    tipo: string;
    desde: string | null;
    hasta: string | null;
    en: string;
    actor: string | null;
  }[];
  saldo: { total: number; pagado: number; pendiente: number; aFavor: number };
  /** Lo que se puede hacer ahora. Lo decide el servidor; la pantalla pinta botones. */
  acciones: AccionDeReserva[];
  solapes: { id: string; contacto: string | null; entrada: string; salida: string }[];
}

export interface PeticionDeReserva {
  conversacionId?: string;
  contactoId?: string;
  tipoId: string;
  entrada: string;
  salida: string;
  personas: number;
  servicios?: string[];
  habitacionId?: string;
  descuento?: { importe: number; motivo: string };
  notas?: string;
  aceptarAvisos?: boolean;
}
