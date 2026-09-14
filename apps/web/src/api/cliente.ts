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
  CatalogoDeHotel,
  Cotizacion,
  DatosDeCliente,
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
  GrafoDeFlujo,
  Miembro,
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
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    iniciarSesion: (email: string, contrasena: string) =>
      peticion<Sesion & { expiraEn: number }>('/v1/sesiones', {
        metodo: 'POST',
        cuerpo: { email, contrasena },
      }),
    yo: () => peticion<Yo>('/v1/yo', t),
    panel: () => peticion<ResumenDelPanel>('/v1/panel', t),
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
    respuestasRapidas: () => peticion<RespuestaRapida[]>('/v1/respuestas-rapidas', t),
    urlDeMedio: (mediaAssetId: string) =>
      peticion<{ url: string; expiraEnSegundos: number; mime: string | null }>(
        `/v1/medios/${mediaAssetId}/url`,
        t,
      ),
    prepararSubida: (mime: string, bytes: number, nombre?: string) =>
      peticion<{ mediaAssetId: string; urlDeSubida: string }>('/v1/medios/subidas', {
        ...t,
        metodo: 'POST',
        cuerpo: { mime, bytes, nombre },
      }),
    // --- Ajustes -----------------------------------------------------------
    canales: () => peticion<CuentaDeCanal[]>('/v1/canales', t),
    conectarWhatsapp: (cred: {
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      appSecret: string;
      displayName?: string;
    }) => peticion<CuentaDeCanal>('/v1/canales/whatsapp', { ...t, metodo: 'POST', cuerpo: cred }),
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
    sincronizarPlantillas: (channelAccountId: string) =>
      peticion<{ total: number; nuevas: number; actualizadas: number }>(
        `/v1/canales/${channelAccountId}/plantillas/sincronizar`,
        { ...t, metodo: 'POST' },
      ),
    crearRapida: (d: { atajo: string; titulo: string; cuerpo: string; mediaAssetId?: string }) =>
      peticion<RespuestaRapida>('/v1/respuestas-rapidas', { ...t, metodo: 'POST', cuerpo: d }),
    editarRapida: (id: string, d: { atajo?: string; titulo?: string; cuerpo?: string }) =>
      peticion<RespuestaRapida>(`/v1/respuestas-rapidas/${id}`, {
        ...t,
        metodo: 'PATCH',
        cuerpo: d,
      }),
    archivarRapida: (id: string) =>
      peticion<void>(`/v1/respuestas-rapidas/${id}`, { ...t, metodo: 'DELETE' }),
    uso: () => peticion<ResumenDeUso>('/v1/cuenta/uso', t),
    suscripcion: () => peticion<ResumenDeSuscripcion>('/v1/cuenta/suscripcion', t),
    usuarios: () => peticion<Miembro[]>('/v1/usuarios', t),

    // --- Salesbots ---------------------------------------------------------
    flujos: () => peticion<ResumenDeFlujo[]>('/v1/flujos', t),
    flujo: (id: string) => peticion<DetalleDeFlujo>(`/v1/flujos/${id}`, t),
    crearFlujo: (d: { nombre: string; grafo: GrafoDeFlujo; disparadores: DisparadorDeFlujo[] }) =>
      peticion<{ id: string; version: number }>('/v1/flujos', { ...t, metodo: 'POST', cuerpo: d }),
    guardarFlujo: (
      id: string,
      d: { nombre?: string; grafo?: GrafoDeFlujo; disparadores?: DisparadorDeFlujo[] },
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
