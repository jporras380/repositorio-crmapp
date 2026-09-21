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

/** Un mensaje del hilo con soporte técnico (0043). */
export interface MensajeDeSoporte {
  id: string;
  /** `true` lo escribió la plataforma; `false`, alguien de tu equipo. */
  deLaPlataforma: boolean;
  autor: string | null;
  cuerpo: string;
  creadoEn: string;
  leidoEn: string | null;
}

/** Un acceso de soporte a tu cuenta: quién, para qué y hasta cuándo. */
export interface PermisoDeSoporte {
  id: string;
  motivo: string;
  pedidoPor: string | null;
  pedidoEn: string;
  aprobadoEn: string | null;
  expiraEn: string | null;
  revocadoEn: string | null;
  estado: 'pendiente' | 'activo' | 'terminado';
}

/** Un plan del catálogo, tal como lo ve quien todavía no es cliente. */
export interface PlanPublico {
  codigo: string;
  nombre: string;
  precioPorAsientoCentimos: number;
  moneda: string;
  mesesDePrueba: number;
  /** Topes del plan: `agentes`, `canales`, `conversaciones_mes`… */
  limites: Record<string, number>;
}

export interface Yo {
  userId: string;
  tenantId: string;
  rol: Sesion['rol'];
  /** Estado efectivo que calcula la API (packages/core): la web solo lo pinta. */
  suscripcion: 'prueba' | 'activa' | 'gracia' | 'suspendida' | string;
  /** Para el riel de navegación, que está en todas las pantallas. */
  nombre: string;
  fotoId: string | null;
  /** Personal de la PLATAFORMA (0039). El riel enseña la consola solo a quien lo sea. */
  esOperador: boolean;
}

/** Una cuenta vista desde la consola del operador: cifras, nunca conversaciones. */
export interface CuentaEnLaConsola {
  tenantId: string;
  nombre: string;
  slug: string;
  altaEn: string;
  plan: string | null;
  estado: string;
  pruebaHasta: string | null;
  periodoHasta: string | null;
  diasDeGracia: number;
  asientos: number;
  importeMensualCentimos: number;
  moneda: string;
  comprobantesPendientes: number;
  comprobanteMasViejoEn: string | null;
  canales: number;
  canalesConProblema: number;
  ultimoEventoEn: string | null;
  mensajesDelMes: number;
  /** Lo que este cliente escribió a soporte y nadie ha leído. */
  soporteSinLeer: number;
}

/** Etiqueta con dónde se usa, para el apartado donde se administran. */
export interface EtiquetaConUso {
  id: string;
  nombre: string;
  color: string | null;
  usos: { conversaciones: number; clientes: number; leads: number };
  bots: string[];
  creadaEn: string;
}

/** Reparto automático de conversaciones: modo de la cuenta y quién entra. */
export interface ConfiguracionDeReparto {
  modo: 'off' | 'least_busy';
  miembros: {
    userId: string;
    nombre: string;
    email: string;
    rol: string;
    recibe: boolean;
    abiertas: number;
  }[];
}

/** Un tramo abierto del horario: `["09:00", "13:00"]`, hora del hotel. */
export type TramoDeHorario = [string, string];

export interface HorarioDeAtencion {
  zonaHoraria: string;
  /** Día ISO (1 = lunes … 7 = domingo) → tramos. Un día ausente está cerrado. */
  horario: Record<string, TramoDeHorario[]>;
  avisoActivo: boolean;
  avisoTexto: string;
  configurado: boolean;
}

/** Lo que uno puede ver y cambiar de sí mismo. */
export interface Perfil {
  userId: string;
  nombre: string;
  email: string;
  fotoId: string | null;
  dobleFactor: boolean;
}

/** Una sesión abierta, para reconocerla o cerrarla. */
export interface SesionAbierta {
  id: string;
  ip: string | null;
  dispositivo: string | null;
  ultimaVezEn: string;
  creadaEn: string;
  esLaActual: boolean;
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
  contacto: {
    id: string;
    nombre: string | null;
    /** Cómo se le llama de un vistazo; puede venir unido. */
    handle: string | null;
    telefono: string | null;
    /** Sin «@»: lo pone la interfaz. */
    usuario: string | null;
  };
  agenteId: string | null;
  noLeidos: number;
  ultimoEntranteEn: string | null;
  ultimoSalienteEn: string | null;
  ventanaExpiraEn: string | null;
  /** Calculado al leer, nunca guardado a mano: por eso no puede mentir. */
  atencion: EstadoDeAtencion;
  aplazadaHasta: string | null;
  /**
   * Puesta en espera a propósito: el bot no le contesta. Sigue siendo `true`
   * aunque el cliente vuelva a escribir y `atencion` deje de decirlo.
   */
  enEspera: boolean;
  ventanaAbierta: boolean;
  etiquetas: Etiqueta[];
  vistaPrevia: string | null;
  /** El bot pidió una persona y dejó dicho por qué. Se apaga al contestar. */
  relevo: { motivo: string; en: string | null } | null;
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
  /** Quién lo escribió, si fue una persona. `null` en entrantes y bots. */
  autor_id: string | null;
  autor: string | null;
  autor_foto_id: string | null;
  creado_en: string;
  error: { tipo?: string; mensaje?: string } | null;
  medio_id: string | null;
  medio_estado: 'pending' | 'stored' | 'failed' | null;
  /** Nombre del fichero, cuando lo hay (documentos). */
  medio_nombre: string | null;
  /** En una respuesta a comentario, si fue pública o privada. */
  modo_comentario: 'publica' | 'privada' | null;
}

/**
 * Qué se puede subir y qué admite cada canal. Se pregunta ANTES de subir: el
 * agente no debería descubrir el límite después de mandar 38 MB por datos.
 */
export interface LimitesDeMedios {
  mimesPermitidos: string[];
  tamanoMaximo: number;
  porCanal: Record<string, { tipos: string[]; limites: Record<string, number> }>;
}

/** Otra ficha que podría ser la misma persona, con el motivo de la sospecha. */
export interface DuplicadoDeCliente {
  id: string;
  nombre: string | null;
  porque: string;
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
  actualizadoEn: string;
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
/** Quién redacta los borradores. Todos con la clave del propio hotel (BYOK). */
export type Proveedor = 'anthropic' | 'google' | 'openai' | 'xai';

export interface DatosDeProveedorDeIa {
  id: Proveedor;
  nombre: string;
  /** Sugerencias; se puede escribir otro y el servidor lo comprueba. */
  modelos: string[];
  dondeSacarLaClave: string;
  /** Lo que hay que saber antes de mandarle conversaciones. Vacío si no hay nada. */
  aviso: string;
}

export interface AjustesDeIa {
  activa: boolean;
  proveedor: Proveedor;
  modelo: string;
  instrucciones: string;
  /** Si hay clave del proveedor ACTUAL. La clave nunca sale. */
  tieneClave: boolean;
  /** Cuáles ya tienen clave: cambiar de proveedor no obliga a repegarla. */
  proveedoresConClave: Proveedor[];
  modelosDisponibles: string[];
  proveedores: DatosDeProveedorDeIa[];
}

/** Aviso o error del editor de plantillas: `error` impide enviarla a Meta. */
export interface ProblemaDePlantilla {
  nivel: 'error' | 'aviso';
  codigo: string;
  mensaje: string;
}

export interface BorradorDePlantilla {
  nombre: string;
  idioma: string;
  categoria: string;
  encabezado?: string;
  cuerpo: string;
  pie?: string;
  botones?: string[];
  ejemplos?: string[];
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
  /** Solo las que un bot dejó pidiendo una persona. */
  relevo?: boolean | undefined;
  /** Estado de atención, deducido por el servidor (0020). */
  atencion?: string | undefined;
  /** Busca por el contacto (nombre, @ o teléfono) y por lo que se dijo en la conversación. */
  q?: string | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
  etapaId?: string | undefined;
  cursor?: string | undefined;
}

export type EstadoDeAtencion =
  'nueva' | 'por_responder' | 'esperando_cliente' | 'seguimiento' | 'en_espera' | 'cerrada';

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
  /** Se rinde y pide una persona. Termina siempre: el bot no habla después. */
  | { id: string; tipo: 'relevo'; motivo: string }
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

/** Cuándo se le deja hablar al bot, contra el horario del hotel. */
export type HorasActivasDeFlujo = 'siempre' | 'solo_abierto' | 'solo_cerrado';

export interface ResumenDeFlujo {
  id: string;
  nombre: string;
  estado: 'borrador' | 'activo' | 'pausado' | string;
  horasActivas: HorasActivasDeFlujo;
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
  | { tipo: 'pedir_humano'; motivo: string }
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
  pagos: PagoDeSuscripcion[];
  avisos: { limite: string; nivel: 'holgado' | 'cerca' | 'pasado'; usado: number; tope: number }[];
  facturacion: DatosDeFacturacion;
}

export type TipoDeComprobante = 'boleta' | 'factura';

/** A nombre de quién se emiten los comprobantes del CRM. */
export interface DatosDeFacturacion {
  tipo: TipoDeComprobante;
  /** RUC si es factura, DNI si es boleta. */
  documento: string | null;
  nombre: string | null;
  direccion: string | null;
}

export interface PagoDeSuscripcion {
  id: string;
  importeCentimos: number;
  moneda: string;
  cubreDesde: string;
  cubreHasta: string;
  metodo: string;
  referencia: string | null;
  comprobante: {
    /** `retrasado` = pasaron las 48 h y sigue sin subirse. */
    estado: 'pendiente' | 'retrasado' | 'disponible';
    medioId: string | null;
    numero: string | null;
    venceEn: string;
    subidoEn: string | null;
  };
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
  /** Fichas que esta absorbió y todavía se pueden devolver. */
  fusiones: { origenId: string; nombre: string | null; nota: string; fecha: string }[];
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
