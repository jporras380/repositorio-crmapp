/**
 * Cliente HTTP mínimo. Un solo lugar donde vive la URL base, la cabecera de
 * sesión y la traducción de errores de la API a `ErrorDeApi`.
 *
 * La API responde `{codigo, mensaje, ...detalle}` en todo error de negocio
 * (FiltroDeErrores). El código es lo que la interfaz usa para decidir qué
 * pintar; el mensaje se muestra tal cual, viene ya redactado para personas.
 */
import type {
  CuentaDeCanal,
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
    confirmarSubida: (mediaAssetId: string) =>
      peticion<{ mediaAssetId: string }>(`/v1/medios/subidas/${mediaAssetId}/confirmar`, {
        ...t,
        metodo: 'POST',
      }),
  };
}

export type Api = ReturnType<typeof crearApi>;
