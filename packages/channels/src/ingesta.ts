/**
 * Contrato de ingesta de webhooks.
 *
 * **Separado de `ChannelAdapter` a propósito.** Recibir y enviar tienen ciclos
 * de vida distintos: el camino del webhook corre en el proceso HTTP, tiene que
 * responder en menos de un segundo y no debería arrastrar nada del cliente de
 * envío. Mezclarlos habría obligado además a tocar un contrato que ya está en
 * la lista de parada.
 *
 * La otra razón es que un canal puede tener uno y no el otro: un proveedor de
 * solo salida no tendría webhooks, y uno de solo entrada no tendría envío.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Canal, TipoDeMensaje } from './adaptador.js';

// ---------------------------------------------------------------------------
// Eventos normalizados
// ---------------------------------------------------------------------------

/**
 * Un evento entrante, ya traducido a nuestro vocabulario.
 *
 * El worker trabaja con esto y no con el JSON de Meta. Es lo que permite que
 * la lógica de ingesta —deduplicar, resolver contacto, abrir conversación— sea
 * la misma para los tres canales.
 */
export type EventoEntrante =
  EventoDeMensaje | EventoDeEstado | EventoDeComentario | EventoDePlantilla;

export interface EventoBase {
  canal: Canal;
  /** Identificador de la cuenta en el proveedor, para resolver el inquilino. */
  externalAccountId: string;
  /** Momento del proveedor, no el nuestro. Puede venir con retraso. */
  ocurridoEn: Date;
}

export interface EventoDeMensaje extends EventoBase {
  clase: 'mensaje';
  /** Clave de idempotencia (ADR-006). */
  externalMessageId: string;
  externalUserId: string;
  /** Nombre de perfil, cuando el proveedor lo manda. */
  nombreDeContacto?: string | undefined;
  telefonoE164?: string | undefined;
  tipo: TipoDeMensaje;
  texto?: string | undefined;
  /** Identificador del medio en el proveedor, a descargar antes de que caduque. */
  mediaId?: string | undefined;
  /** Si llegó por anuncio Click-to-WhatsApp: abre ventana de 72 h. */
  entradaGratuita?: boolean | undefined;
  respondeA?: string | undefined;
}

export interface EventoDeEstado extends EventoBase {
  clase: 'estado';
  externalMessageId: string;
  estado: 'sent' | 'delivered' | 'read' | 'failed';
  error?: { codigo: string; mensaje: string } | undefined;
}

export interface EventoDeComentario extends EventoBase {
  clase: 'comentario';
  externalCommentId: string;
  externalUserId: string;
  externalPostId: string;
  texto: string;
  respondeAComentario?: string | undefined;
  /** @usuario público, cuando el proveedor lo manda (Instagram sí). */
  nombreDeUsuario?: string | undefined;
}

export interface EventoDePlantilla extends EventoBase {
  clase: 'plantilla';
  nombre: string;
  idioma: string;
  estado: 'aprobada' | 'rechazada' | 'pausada' | 'deshabilitada';
  motivoDeRechazo?: string | undefined;
  categoriaEfectiva?: string | undefined;
}

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

export interface PeticionDeWebhook {
  /**
   * Cuerpo **en bytes crudos**, no el JSON ya parseado.
   *
   * La firma se calcula sobre los bytes exactos que envió el proveedor. Si se
   * vuelve a serializar el objeto parseado, el orden de las claves o el
   * escapado de Unicode cambian y la firma deja de coincidir — con un error
   * que parece un problema de clave y no lo es. Es el bug clásico de este
   * camino, y por eso el tipo pide un Buffer.
   */
  cuerpoCrudo: Buffer;
  cabeceras: Record<string, string | undefined>;
}

export interface AdaptadorDeIngesta {
  readonly canal: Canal;

  /**
   * Comprueba que el webhook viene de verdad del proveedor.
   *
   * Devuelve booleano y no lanza: una firma inválida es un caso esperado
   * —escaneos, peticiones perdidas— y no una excepción del sistema.
   */
  verificarFirma(peticion: PeticionDeWebhook, secreto: string): boolean;

  /**
   * Traduce el payload a eventos normalizados.
   *
   * Devuelve una lista porque los proveedores agrupan: un solo webhook de Meta
   * puede traer varios mensajes de varias cuentas.
   */
  parsearEventos(cuerpo: unknown): EventoEntrante[];

  /**
   * Responde al reto de verificación con que el proveedor da de alta el
   * webhook. Devuelve el texto a contestar, o `null` si no procede.
   */
  responderAlDesafio(
    parametros: Record<string, string | undefined>,
    verifyToken: string,
  ): string | null;
}

// ---------------------------------------------------------------------------
// Verificación de firma estilo Meta
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 sobre el cuerpo crudo, en la cabecera `x-hub-signature-256`
 * con el prefijo `sha256=`.
 *
 * Lo comparten WhatsApp e Instagram porque son la misma plataforma, así que
 * vive aquí y no duplicado en cada adaptador.
 */
export function verificarFirmaMeta(peticion: PeticionDeWebhook, appSecret: string): boolean {
  const recibida = peticion.cabeceras['x-hub-signature-256'];
  if (!recibida || !recibida.startsWith('sha256=')) return false;

  const esperada =
    'sha256=' + createHmac('sha256', appSecret).update(peticion.cuerpoCrudo).digest('hex');

  const a = Buffer.from(recibida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  // Longitudes distintas antes de timingSafeEqual, que lanza si no coinciden.
  // Comparar con === filtraría por tiempo cuántos caracteres iniciales
  // acertó quien lo intenta.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reto de alta del webhook de Meta.
 *
 * Meta llama con `hub.mode=subscribe` y un `hub.verify_token` que elegimos
 * nosotros; hay que devolver `hub.challenge` tal cual. Si se responde
 * cualquier otra cosa, el alta falla sin decir por qué.
 */
export function responderAlDesafioMeta(
  parametros: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  if (parametros['hub.mode'] !== 'subscribe') return null;
  // Sin token configurado no hay reto que superar: un token vacio aceptaria
  // cualquier alta cuyo verify_token tambien viniera vacio. Fallar cerrado.
  if (!verifyToken) return null;

  const recibido = parametros['hub.verify_token'] ?? '';
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(verifyToken, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return parametros['hub.challenge'] ?? null;
}

// ---------------------------------------------------------------------------
// Ingesta de pruebas
// ---------------------------------------------------------------------------

/**
 * Ingesta del sandbox. Usa el mismo esquema de firma que Meta para que el
 * camino ejercitado en desarrollo sea el mismo que en producción.
 */
export class IngestaSandbox implements AdaptadorDeIngesta {
  constructor(readonly canal: Canal = 'whatsapp') {}

  verificarFirma(peticion: PeticionDeWebhook, secreto: string): boolean {
    return verificarFirmaMeta(peticion, secreto);
  }

  responderAlDesafio(
    parametros: Record<string, string | undefined>,
    verifyToken: string,
  ): string | null {
    return responderAlDesafioMeta(parametros, verifyToken);
  }

  /**
   * Acepta un formato propio y sencillo: `{ cuenta, eventos: [...] }`.
   *
   * No imita el formato anidado de Meta a propósito. Ese lo traducirá el
   * adaptador real, y hacer que el sandbox lo imitara solo daría una falsa
   * sensación de haberlo probado.
   */
  parsearEventos(cuerpo: unknown): EventoEntrante[] {
    if (typeof cuerpo !== 'object' || cuerpo === null) return [];
    const raiz = cuerpo as { cuenta?: unknown; eventos?: unknown };
    if (typeof raiz.cuenta !== 'string' || !Array.isArray(raiz.eventos)) return [];

    const salida: EventoEntrante[] = [];
    for (const bruto of raiz.eventos) {
      if (typeof bruto !== 'object' || bruto === null) continue;
      const e = bruto as Record<string, unknown>;
      const base = {
        canal: this.canal,
        externalAccountId: raiz.cuenta,
        ocurridoEn: e['ocurridoEn'] ? new Date(String(e['ocurridoEn'])) : new Date(),
      };

      if (e['clase'] === 'mensaje' && typeof e['externalMessageId'] === 'string') {
        salida.push({
          ...base,
          clase: 'mensaje',
          externalMessageId: e['externalMessageId'],
          externalUserId: String(e['externalUserId'] ?? ''),
          tipo: (e['tipo'] as TipoDeMensaje) ?? 'text',
          texto: typeof e['text'] === 'string' ? e['text'] : undefined,
          mediaId: typeof e['mediaId'] === 'string' ? e['mediaId'] : undefined,
          nombreDeContacto: typeof e['nombre'] === 'string' ? e['nombre'] : undefined,
          telefonoE164: typeof e['telefono'] === 'string' ? e['telefono'] : undefined,
          entradaGratuita: e['entradaGratuita'] === true,
        });
      } else if (e['clase'] === 'estado' && typeof e['externalMessageId'] === 'string') {
        salida.push({
          ...base,
          clase: 'estado',
          externalMessageId: e['externalMessageId'],
          estado: (e['estado'] as EventoDeEstado['estado']) ?? 'sent',
        });
      } else if (e['clase'] === 'comentario' && typeof e['externalCommentId'] === 'string') {
        salida.push({
          ...base,
          clase: 'comentario',
          externalCommentId: e['externalCommentId'],
          externalUserId: String(e['externalUserId'] ?? ''),
          externalPostId: String(e['externalPostId'] ?? 'post'),
          texto: typeof e['texto'] === 'string' ? e['texto'] : '',
          respondeAComentario:
            typeof e['respondeAComentario'] === 'string' ? e['respondeAComentario'] : undefined,
          nombreDeUsuario: typeof e['nombre'] === 'string' ? e['nombre'] : undefined,
        });
      } else if (e['clase'] === 'plantilla' && typeof e['nombre'] === 'string') {
        salida.push({
          ...base,
          clase: 'plantilla',
          nombre: e['nombre'],
          idioma: typeof e['idioma'] === 'string' ? e['idioma'] : 'es',
          estado: (e['estado'] as EventoDePlantilla['estado']) ?? 'aprobada',
          motivoDeRechazo:
            typeof e['motivoDeRechazo'] === 'string' ? e['motivoDeRechazo'] : undefined,
          categoriaEfectiva:
            typeof e['categoriaEfectiva'] === 'string' ? e['categoriaEfectiva'] : undefined,
        });
      }
      // Los eventos que no se reconocen se ignoran en silencio a propósito:
      // Meta añade tipos nuevos sin avisar, y fallar ante uno desconocido
      // haría que un webhook con un evento nuevo tumbara los demás del lote.
    }
    return salida;
  }
}
