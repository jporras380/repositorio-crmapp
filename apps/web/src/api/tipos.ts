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

export interface FiltrosDeBandeja {
  canal?: string | undefined;
  tipo?: string | undefined;
  estado?: string | undefined;
  agenteId?: string | undefined;
  etiquetaId?: string | undefined;
  sinRespuesta?: boolean | undefined;
  cursor?: string | undefined;
}
