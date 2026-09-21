/**
 * Cliente HTTP mínimo. Un solo lugar donde vive la URL base, la cabecera de
 * sesión y la traducción de errores de la API a `ErrorDeApi`.
 *
 * La API responde `{codigo, mensaje, ...detalle}` en todo error de negocio
 * (FiltroDeErrores). El código es lo que la interfaz usa para decidir qué
 * pintar; el mensaje se muestra tal cual, viene ya redactado para personas.
 */
import type {
  ColumnaDelTablero,
  CuentaDeCanal,
  CuentaEnLaConsola,
  CuentaDeInstagramDescubierta,
  PaginaDeFacebookDescubierta,
  AjustesDeIa,
  EtiquetaConUso,
  ConfiguracionDeReparto,
  HorarioDeAtencion,
  BorradorDePlantilla,
  ProblemaDePlantilla,
  DescubrimientoWhatsapp,
  AccionDeReserva,
  CatalogoDeHotel,
  ClaveDePeriodo,
  InformeDelPeriodo,
  DetalleDeReserva,
  MetodoDePago,
  PeticionDeReserva,
  ResumenDeReserva,
  Cotizacion,
  DatosDeCliente,
  DatosDeFacturacion,
  Tarifa,
  UnidadDeServicio,
  EstadoDeHabitacion,
  NotaInterna,
  VistaDeBandeja,
  FichaDeCliente,
  ResultadoDeImportacion,
  ResumenDeCliente,
  DetalleDeLead,
  Embudo,
  EtapaDeEmbudo,
  Tablero,
  TipoDeEtapa,
  DetalleDeFlujo,
  DisparadorDeFlujo,
  EjecucionDeFlujo,
  DuplicadoDeCliente,
  GrafoDeFlujo,
  HorasActivasDeFlujo,
  LimitesDeMedios,
  Miembro,
  Perfil,
  PermisoDeSoporte,
  PlanPublico,
  Proveedor,
  ResumenDeFlujo,
  ResumenDeSuscripcion,
  SimulacionDeFlujo,
  ResumenDelPanel,
  Etiqueta,
  PlantillaDeWhatsapp,
  ResumenDeUso,
  FiltrosDeBandeja,
  Mensaje,
  Pagina,
  PeticionDeEnvio,
  RespuestaRapida,
  ResumenDeConversacion,
  Sesion,
  SesionAbierta,
  Yo,
} from './tipos.ts';

export const BASE = '/api';

export class ErrorDeApi extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalle: Record<string, unknown> = {},
  ) {
    super(mensaje);
    this.name = 'ErrorDeApi';
  }
}

export interface OpcionesDePeticion {
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  cuerpo?: unknown;
  token?: string | null;
  senal?: AbortSignal;
}

export async function peticion<T>(ruta: string, o: OpcionesDePeticion = {}): Promise<T> {
  const r = await fetch(BASE + ruta, {
    method: o.metodo ?? 'GET',
    headers: {
      ...(o.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.cuerpo !== undefined ? JSON.stringify(o.cuerpo) : null,
    ...(o.senal ? { signal: o.senal } : {}),
  });
  if (r.status === 204) return undefined as T;
  const texto = await r.text();
  const json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  if (!r.ok) {
    const { codigo, mensaje, ...detalle } = json as {
      codigo?: string;
      mensaje?: string;
      [k: string]: unknown;
    };
    throw new ErrorDeApi(
      r.status,
      codigo ?? 'http',
      mensaje ?? `Error ${r.status}`,
      detalle as Record<string, unknown>,
    );
  }
  return json as T;
}

function consulta(filtros: Record<string, string | boolean | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filtros)) {
    if (v === undefined || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Superficie de la API que usa la bandeja. Cada método es una ruta, sin lógica. */
export function crearApi(token: string | null) {
  const t = { token };
  return {
    /**
     * `codigo` es el segundo factor, y solo va cuando la cuenta lo tiene
     * activado: el servidor responde `codigo_requerido` y se vuelve a llamar
     * con él. Vale tanto el del autenticador como uno de recuperación.
     */
    iniciarSesion: (email: string, contrasena: string, codigo?: string) =>
      peticion<Sesion & { expiraEn: number }>('/v1/sesiones', {
        metodo: 'POST',
        cuerpo: codigo ? { email, contrasena, codigo } : { email, contrasena },
      }),
    /** Catálogo de planes. Sin sesión: es la página de precios. */
    planes: () => peticion<PlanPublico[]>('/v1/planes'),
    /** Si el identificador de cuenta está libre, mientras se escribe. */
    slugDisponible: (slug: string) =>
      peticion<{ libre: boolean; motivo: string | null }>(
        `/v1/cuentas/disponible?slug=${encodeURIComponent(slug)}`,
      ),
    crearCuenta: (d: {
      nombreDeCuenta: string;
      slug: string;
      email: string;
      contrasena: string;
      nombreCompleto: string;
      planCode?: string;
    }) => peticion<Sesion & { expiraEn: number }>('/v1/cuentas', { metodo: 'POST', cuerpo: d }),
    yo: () => peticion<Yo>('/v1/yo', t),
    /** Consola del operador: todas las cuentas. 404 si no eres de la plataforma. */
    cuentasDeLaPlataforma: () => peticion<CuentaEnLaConsola[]>('/v1/operador/cuentas', t),
    panel: () => peticion<ResumenDelPanel>('/v1/panel', t),
    informe: (periodo: ClaveDePeriodo) =>
      peticion<InformeDelPeriodo>(`/v1/panel/informe?periodo=${periodo}`, t),
    etiquetas: () => peticion<Etiqueta[]>('/v1/etiquetas', t),
    conversaciones: (f: FiltrosDeBandeja) =>
      peticion<Pagina<ResumenDeConversacion>>(`/v1/conversaciones${consulta({ ...f })}`, t),
    mensajes: (conversationId: string, cursor?: string) =>
      peticion<Pagina<Mensaje>>(
        `/v1/conversaciones/${conversationId}/mensajes${consulta({ cursor, limite: 50 })}`,
        t,
      ),
    enviar: (conversationId: string, cuerpo: PeticionDeEnvio) =>
      peticion<{ id: string; createdAt: string; estado: 'queued' }>(
        `/v1/conversaciones/${conversationId}/mensajes`,
        { ...t, metodo: 'POST', cuerpo },
      ),
    asignar: (conversationId: string, agenteId: string | null) =>
      peticion<void>(`/v1/conversaciones/${conversationId}/asignacion`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { agenteId },
      }),
    cambiarEstado: (conversationId: string, estado: string) =>
      peticion<void>(`/v1/conversaciones/${conversationId}/estado`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { estado },
      }),
    etiquetar: (conversationId: string, tagId: string, poner: boolean) =>
      peticion<void>(`/v1/conversaciones/${conversationId}/etiquetas`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { tagId, poner },
      }),
    crearEtiqueta: (nombre: string, color: string | null) =>
      peticion<{ id: string }>('/v1/etiquetas', {
        ...t,
        metodo: 'POST',
        cuerpo: { nombre, color },
      }),
    horario: () => peticion<HorarioDeAtencion>('/v1/cuenta/horario', t),
    guardarHorario: (d: {
      zonaHoraria?: string;
      horario?: Record<string, [string, string][]>;
      avisoActivo?: boolean;
      avisoTexto?: string;
    }) => peticion<HorarioDeAtencion>('/v1/cuenta/horario', { ...t, metodo: 'PUT', cuerpo: d }),
    reparto: () => peticion<ConfiguracionDeReparto>('/v1/cuenta/reparto', t),
    guardarReparto: (d: {
      modo?: 'off' | 'least_busy';
      miembros?: { userId: string; recibe: boolean }[];
    }) =>
      peticion<ConfiguracionDeReparto>('/v1/cuenta/reparto', { ...t, metodo: 'PUT', cuerpo: d }),
    etiquetasConUso: () => peticion<EtiquetaConUso[]>('/v1/etiquetas/uso', t),
    editarEtiqueta: (id: string, cambios: { nombre?: string; color?: string | null }) =>
      peticion<void>(`/v1/etiquetas/${id}`, { ...t, metodo: 'PATCH', cuerpo: cambios }),
    borrarEtiqueta: (id: string) =>
      peticion<void>(`/v1/etiquetas/${id}`, { ...t, metodo: 'DELETE' }),
    respuestasRapidas: () => peticion<RespuestaRapida[]>('/v1/respuestas-rapidas', t),
    urlDeMedio: (mediaAssetId: string) =>
      peticion<{ url: string; expiraEnSegundos: number; mime: string | null }>(
        `/v1/medios/${mediaAssetId}/url`,
        t,
      ),
    limitesDeMedios: () => peticion<LimitesDeMedios>('/v1/medios/limites', t),
    prepararSubida: (mime: string, bytes: number, nombre?: string) =>
      peticion<{ mediaAssetId: string; urlDeSubida: string }>('/v1/medios/subidas', {
        ...t,
        metodo: 'POST',
        cuerpo: { mime, bytes, nombre },
      }),
    // --- IA asistida (BYOK) -------------------------------------------------
    iaAjustes: () => peticion<AjustesDeIa>('/v1/ia/ajustes', t),
    guardarIa: (d: {
      activa?: boolean;
      proveedor?: Proveedor;
      modelo?: string;
      instrucciones?: string;
      clave?: string;
    }) => peticion<AjustesDeIa>('/v1/ia/ajustes', { ...t, metodo: 'PUT', cuerpo: d }),
    /** Sin decir cuál, borra la del proveedor en uso. */
    borrarClaveIa: (proveedor?: Proveedor) =>
      peticion<AjustesDeIa>(`/v1/ia/clave${proveedor ? `?proveedor=${proveedor}` : ''}`, {
        ...t,
        metodo: 'DELETE',
      }),
    sugerirRespuesta: (conversationId: string) =>
      peticion<{ texto: string; modelo: string }>(
        `/v1/conversaciones/${conversationId}/sugerencia`,
        {
          ...t,
          metodo: 'POST',
        },
      ),
    // --- Ajustes -----------------------------------------------------------
    canales: () => peticion<CuentaDeCanal[]>('/v1/canales', t),
    conectarWhatsapp: (cred: {
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      appSecret: string;
      displayName?: string;
    }) => peticion<CuentaDeCanal>('/v1/canales/whatsapp', { ...t, metodo: 'POST', cuerpo: cred }),
    descubrirWhatsapp: (d: { accessToken: string; wabaId?: string }) =>
      peticion<DescubrimientoWhatsapp>('/v1/canales/whatsapp/descubrir', {
        ...t,
        metodo: 'POST',
        cuerpo: d,
      }),
    descubrirInstagram: (d: { accessToken: string }) =>
      peticion<CuentaDeInstagramDescubierta[]>('/v1/canales/instagram/descubrir', {
        ...t,
        metodo: 'POST',
        cuerpo: d,
      }),
    descubrirFacebook: (d: { accessToken: string }) =>
      peticion<PaginaDeFacebookDescubierta[]>('/v1/canales/facebook/descubrir', {
        ...t,
        metodo: 'POST',
        cuerpo: d,
      }),
    conectarFacebook: (cred: {
      paginaId: string;
      accessToken: string;
      appSecret: string;
      displayName?: string;
    }) => peticion<CuentaDeCanal>('/v1/canales/facebook', { ...t, metodo: 'POST', cuerpo: cred }),
    conectarInstagram: (cred: {
      igUserId: string;
      accessToken: string;
      appSecret: string;
      displayName?: string;
    }) => peticion<CuentaDeCanal>('/v1/canales/instagram', { ...t, metodo: 'POST', cuerpo: cred }),
    desconectarCanal: (id: string) =>
      peticion<void>(`/v1/canales/${id}`, { ...t, metodo: 'DELETE' }),
    renovarCredenciales: (id: string, d: { accessToken: string; appSecret?: string }) =>
      peticion<CuentaDeCanal>(`/v1/canales/${id}/credenciales`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: d,
      }),
    plantillasDeCanal: (channelAccountId: string) =>
      peticion<PlantillaDeWhatsapp[]>(`/v1/canales/${channelAccountId}/plantillas`, t),
    crearPlantilla: (channelAccountId: string, borrador: BorradorDePlantilla) =>
      peticion<{ id: string; estado: string; avisos: ProblemaDePlantilla[] }>(
        `/v1/canales/${channelAccountId}/plantillas`,
        { ...t, metodo: 'POST', cuerpo: borrador },
      ),
    borrarPlantilla: (channelAccountId: string, plantillaId: string) =>
      peticion<void>(`/v1/canales/${channelAccountId}/plantillas/${plantillaId}`, {
        ...t,
        metodo: 'DELETE',
      }),
    sincronizarPlantillas: (channelAccountId: string) =>
      peticion<{ total: number; nuevas: number; actualizadas: number }>(
        `/v1/canales/${channelAccountId}/plantillas/sincronizar`,
        { ...t, metodo: 'POST' },
      ),
    crearRapida: (d: { atajo: string; titulo: string; cuerpo: string; mediaAssetId?: string }) =>
      peticion<RespuestaRapida>('/v1/respuestas-rapidas', { ...t, metodo: 'POST', cuerpo: d }),
    editarRapida: (
      id: string,
      // `mediaAssetId: null` QUITA el adjunto y omitirlo lo deja como estaba:
      // el servidor distingue las dos cosas, así que el tipo también.
      d: { atajo?: string; titulo?: string; cuerpo?: string; mediaAssetId?: string | null },
    ) =>
      peticion<RespuestaRapida>(`/v1/respuestas-rapidas/${id}`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: d,
      }),
    archivarRapida: (id: string) =>
      peticion<void>(`/v1/respuestas-rapidas/${id}`, { ...t, metodo: 'DELETE' }),
    uso: () => peticion<ResumenDeUso>('/v1/cuenta/uso', t),
    suscripcion: () => peticion<ResumenDeSuscripcion>('/v1/cuenta/suscripcion', t),
    guardarFacturacion: (d: DatosDeFacturacion) =>
      peticion<ResumenDeSuscripcion>('/v1/cuenta/suscripcion/facturacion', {
        ...t,
        metodo: 'PUT',
        cuerpo: d,
      }),
    usuarios: () => peticion<Miembro[]>('/v1/usuarios', t),

    // --- Salesbots ---------------------------------------------------------
    flujos: () => peticion<ResumenDeFlujo[]>('/v1/flujos', t),
    flujo: (id: string) => peticion<DetalleDeFlujo>(`/v1/flujos/${id}`, t),
    crearFlujo: (d: { nombre: string; grafo: GrafoDeFlujo; disparadores: DisparadorDeFlujo[] }) =>
      peticion<{ id: string; version: number }>('/v1/flujos', { ...t, metodo: 'POST', cuerpo: d }),
    guardarFlujo: (
      id: string,
      d: {
        nombre?: string;
        grafo?: GrafoDeFlujo;
        disparadores?: DisparadorDeFlujo[];
        horasActivas?: HorasActivasDeFlujo;
      },
    ) =>
      peticion<{ version: number | null }>(`/v1/flujos/${id}`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: d,
      }),
    publicarFlujo: (id: string) =>
      peticion<{ version: number }>(`/v1/flujos/${id}/publicar`, { ...t, metodo: 'POST' }),
    pausarFlujo: (id: string) =>
      peticion<{ pausado: true }>(`/v1/flujos/${id}/pausar`, { ...t, metodo: 'POST' }),
    ejecucionesDeFlujo: (id: string) =>
      peticion<EjecucionDeFlujo[]>(`/v1/flujos/${id}/ejecuciones`, t),
    probarFlujo: (grafo: GrafoDeFlujo, respuestas: string[]) =>
      peticion<SimulacionDeFlujo>('/v1/flujos/probar', {
        ...t,
        metodo: 'POST',
        cuerpo: { grafo, respuestas },
      }),
    // --- Bandeja: aplazar, notas y vistas -----------------------------------
    cerrarVarias: (ids: string[]) =>
      peticion<{ cerradas: number }>('/v1/conversaciones/cerrar', {
        ...t,
        metodo: 'POST',
        cuerpo: { ids },
      }),
    aplazar: (id: string, hasta: string | null) =>
      peticion<void>(`/v1/conversaciones/${id}/aplazar`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { hasta },
      }),
    notas: (id: string) => peticion<NotaInterna[]>(`/v1/conversaciones/${id}/notas`, t),
    anotar: (id: string, cuerpo: string) =>
      peticion<{ id: string }>(`/v1/conversaciones/${id}/notas`, {
        ...t,
        metodo: 'POST',
        cuerpo: { cuerpo },
      }),
    borrarNota: (id: string) => peticion<void>(`/v1/notas/${id}`, { ...t, metodo: 'DELETE' }),
    vistas: () => peticion<VistaDeBandeja[]>('/v1/vistas', t),
    guardarVista: (nombre: string, filtros: Record<string, string>) =>
      peticion<{ id: string }>('/v1/vistas', { ...t, metodo: 'POST', cuerpo: { nombre, filtros } }),
    borrarVista: (id: string) => peticion<void>(`/v1/vistas/${id}`, { ...t, metodo: 'DELETE' }),

    // --- Reservas ----------------------------------------------------------
    reservas: (
      f: {
        estado?: string;
        desde?: string;
        hasta?: string;
        contactoId?: string;
        conversacionId?: string;
      } = {},
    ) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      const cola = p.toString();
      return peticion<ResumenDeReserva[]>(`/v1/reservas${cola ? `?${cola}` : ''}`, t);
    },
    reserva: (id: string) => peticion<DetalleDeReserva>(`/v1/reservas/${id}`, t),
    crearReserva: (d: PeticionDeReserva) =>
      peticion<DetalleDeReserva>('/v1/reservas', { ...t, metodo: 'POST', cuerpo: d }),
    moverReserva: (id: string, accion: AccionDeReserva) =>
      peticion<DetalleDeReserva>(`/v1/reservas/${id}/estado`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { accion },
      }),
    asignarHabitacion: (id: string, habitacionId: string | null) =>
      peticion<DetalleDeReserva>(`/v1/reservas/${id}/habitacion`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { habitacionId },
      }),
    registrarPago: (
      id: string,
      d: { importe: number; metodo: MetodoDePago; referencia?: string },
    ) =>
      peticion<DetalleDeReserva>(`/v1/reservas/${id}/pagos`, { ...t, metodo: 'POST', cuerpo: d }),

    // --- Hotel -------------------------------------------------------------
    hotel: () => peticion<CatalogoDeHotel>('/v1/hotel', t),
    cotizar: (d: {
      tipoId: string;
      entrada: string;
      salida: string;
      personas: number;
      servicios?: string[];
    }) => peticion<Cotizacion>('/v1/hotel/cotizar', { ...t, metodo: 'POST', cuerpo: d }),
    crearTipo: (d: {
      nombre: string;
      capacidad: number;
      precioBase: number | null;
      descripcion?: string | null;
    }) => peticion<{ id: string }>('/v1/hotel/tipos', { ...t, metodo: 'POST', cuerpo: d }),
    editarTipo: (
      id: string,
      d: Partial<{
        nombre: string;
        capacidad: number;
        precioBase: number | null;
        descripcion: string | null;
        activo: boolean;
      }>,
    ) => peticion<void>(`/v1/hotel/tipos/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),
    borrarTipo: (id: string) => peticion<void>(`/v1/hotel/tipos/${id}`, { ...t, metodo: 'DELETE' }),
    crearHabitacion: (d: { tipoId: string; nombre: string }) =>
      peticion<{ id: string }>('/v1/hotel/habitaciones', { ...t, metodo: 'POST', cuerpo: d }),
    editarHabitacion: (
      id: string,
      d: Partial<{ nombre: string; estado: EstadoDeHabitacion; notas: string | null }>,
    ) => peticion<void>(`/v1/hotel/habitaciones/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),
    borrarHabitacion: (id: string) =>
      peticion<void>(`/v1/hotel/habitaciones/${id}`, { ...t, metodo: 'DELETE' }),
    crearTarifa: (d: Omit<Tarifa, 'id'>) =>
      peticion<{ id: string }>('/v1/hotel/tarifas', { ...t, metodo: 'POST', cuerpo: d }),
    borrarTarifa: (id: string) =>
      peticion<void>(`/v1/hotel/tarifas/${id}`, { ...t, metodo: 'DELETE' }),
    crearServicio: (d: { nombre: string; precio: number; unidad: UnidadDeServicio }) =>
      peticion<{ id: string }>('/v1/hotel/servicios', { ...t, metodo: 'POST', cuerpo: d }),
    editarServicio: (id: string, d: Partial<{ activo: boolean; precio: number }>) =>
      peticion<void>(`/v1/hotel/servicios/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),

    // --- Clientes ----------------------------------------------------------
    clientes: (f: { q?: string; origen?: string; etiqueta?: string; cursor?: string } = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      const cola = p.toString();
      return peticion<{ items: ResumenDeCliente[]; siguienteCursor: string | null }>(
        `/v1/contactos${cola ? `?${cola}` : ''}`,
        t,
      );
    },
    cliente: (id: string) => peticion<FichaDeCliente>(`/v1/contactos/${id}`, t),
    crearCliente: (d: DatosDeCliente) =>
      peticion<{ id: string }>('/v1/contactos', { ...t, metodo: 'POST', cuerpo: d }),
    editarCliente: (id: string, d: DatosDeCliente) =>
      peticion<{ editado: true }>(`/v1/contactos/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),
    perfil: () => peticion<Perfil>('/v1/perfil', t),
    editarPerfil: (d: { nombre?: string; fotoId?: string | null }) =>
      peticion<void>('/v1/perfil', { ...t, metodo: 'PATCH', cuerpo: d }),
    cambiarAcceso: (d: { contrasenaActual: string; email?: string; contrasenaNueva?: string }) =>
      peticion<{ sesionesCerradas: number }>('/v1/perfil/acceso', {
        ...t,
        metodo: 'POST',
        cuerpo: d,
      }),
    prepararDosPasos: () =>
      peticion<{ secreto: string; enlace: string }>('/v1/perfil/dos-pasos', {
        ...t,
        metodo: 'POST',
      }),
    confirmarDosPasos: (codigo: string) =>
      peticion<{ codigosDeRecuperacion: string[] }>('/v1/perfil/dos-pasos/confirmar', {
        ...t,
        metodo: 'POST',
        cuerpo: { codigo },
      }),
    quitarDosPasos: (contrasenaActual: string) =>
      peticion<void>('/v1/perfil/dos-pasos', {
        ...t,
        metodo: 'DELETE',
        cuerpo: { contrasenaActual },
      }),
    ponerEnEspera: (id: string, enEspera: boolean) =>
      peticion<void>(`/v1/conversaciones/${id}/espera`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { enEspera },
      }),
    /** Quién de soporte puede mirar la cuenta, y hasta cuándo (0042). */
    permisosDeSoporte: () => peticion<PermisoDeSoporte[]>('/v1/cuenta/soporte', t),
    aprobarSoporte: (id: string, horas: number) =>
      peticion<PermisoDeSoporte[]>(`/v1/cuenta/soporte/${id}/aprobar`, {
        ...t,
        metodo: 'POST',
        cuerpo: { horas },
      }),
    /** Sirve igual para rechazar que para cerrar un acceso ya abierto. */
    revocarSoporte: (id: string) =>
      peticion<PermisoDeSoporte[]>(`/v1/cuenta/soporte/${id}/revocar`, { ...t, metodo: 'POST' }),
    sesiones: () => peticion<SesionAbierta[]>('/v1/sesiones', t),
    cerrarSesion: (id: string | 'otras') =>
      peticion<{ cerradas: number }>(`/v1/sesiones/${id}`, { ...t, metodo: 'DELETE' }),
    duplicadosDeCliente: (id: string) =>
      peticion<DuplicadoDeCliente[]>(`/v1/contactos/${id}/duplicados`, t),
    fusionarClientes: (destinoId: string, origenId: string, motivo: string) =>
      peticion<{ movidas: number }>(`/v1/contactos/${destinoId}/fusionar`, {
        ...t,
        metodo: 'POST',
        cuerpo: { origenId, motivo },
      }),
    deshacerFusionDeCliente: (origenId: string) =>
      peticion<void>(`/v1/contactos/${origenId}/deshacer-fusion`, { ...t, metodo: 'POST' }),
    borrarCliente: (id: string) =>
      peticion<{ accion: 'borrado' | 'anonimizado' }>(`/v1/contactos/${id}`, {
        ...t,
        metodo: 'DELETE',
      }),
    importarClientes: (csv: string, prefijo?: string) =>
      peticion<ResultadoDeImportacion>('/v1/contactos/importar', {
        ...t,
        metodo: 'POST',
        cuerpo: { csv, ...(prefijo ? { prefijo } : {}) },
      }),
    exportarClientes: (f: { q?: string; origen?: string; etiqueta?: string } = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      const cola = p.toString();
      return peticion<{ csv: string; nombreDeArchivo: string }>(
        `/v1/contactos/exportar${cola ? `?${cola}` : ''}`,
        t,
      );
    },

    // --- Embudo ------------------------------------------------------------
    embudos: () => peticion<Embudo[]>('/v1/embudos', t),
    tablero: (f: { embudo?: string; q?: string; responsable?: string; etiqueta?: string } = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      const cola = p.toString();
      return peticion<Tablero>(`/v1/leads/tablero${cola ? `?${cola}` : ''}`, t);
    },
    lead: (id: string) => peticion<DetalleDeLead>(`/v1/leads/${id}`, t),
    crearLead: (d: {
      contactoId: string;
      titulo: string;
      importe?: number;
      etapaId?: string;
      responsableId?: string | null;
    }) => peticion<{ id: string }>('/v1/leads', { ...t, metodo: 'POST', cuerpo: d }),
    editarLead: (
      id: string,
      d: {
        etapaId?: string;
        titulo?: string;
        importe?: number;
        responsableId?: string | null;
        etiquetas?: string[];
      },
    ) => peticion<{ editado: true }>(`/v1/leads/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),
    borrarLead: (id: string) =>
      peticion<{ borrado: true }>(`/v1/leads/${id}`, { ...t, metodo: 'DELETE' }),
    crearEtapa: (embudoId: string, d: { nombre: string; color?: string; tipo?: TipoDeEtapa }) =>
      peticion<EtapaDeEmbudo>(`/v1/embudos/${embudoId}/etapas`, {
        ...t,
        metodo: 'POST',
        cuerpo: d,
      }),
    editarEtapa: (id: string, d: { nombre?: string; color?: string; tipo?: TipoDeEtapa }) =>
      peticion<{ editada: true }>(`/v1/etapas/${id}`, { ...t, metodo: 'PATCH', cuerpo: d }),
    borrarEtapa: (id: string, destinoId?: string) =>
      peticion<{ borrada: true }>(`/v1/etapas/${id}${destinoId ? `?destino=${destinoId}` : ''}`, {
        ...t,
        metodo: 'DELETE',
      }),
    ordenarEtapas: (embudoId: string, ids: string[]) =>
      peticion<{ ordenadas: number }>(`/v1/embudos/${embudoId}/etapas/orden`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: { ids },
      }),

    confirmarSubida: (mediaAssetId: string) =>
      peticion<{ mediaAssetId: string }>(`/v1/medios/subidas/${mediaAssetId}/confirmar`, {
        ...t,
        metodo: 'POST',
      }),
  };
}

export type Api = ReturnType<typeof crearApi>;
