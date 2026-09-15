/**
 * Cliente de IA con la clave del propio hotel (BYOK, P-11).
 *
 * Una interfaz pequeña para poder probar sin red, y su implementación con el
 * SDK oficial de Anthropic. La clave llega en cada llamada: no se guarda en
 * el cliente ni en memoria entre peticiones, porque cada inquilino tiene la
 * suya.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface PeticionDeSugerencia {
  apiKey: string;
  modelo: string;
  /** Instrucciones estables: rol, reglas, contexto del hotel. */
  sistema: string;
  /** La conversación ya formateada, y lo que se pide. */
  mensaje: string;
}

export interface ClienteDeIa {
  /** Comprueba que la clave es válida y que el modelo existe para ella. */
  verificar(p: { apiKey: string; modelo: string }): Promise<void>;
  /** Devuelve el borrador de respuesta. Nunca envía nada. */
  sugerir(p: PeticionDeSugerencia): Promise<string>;
}

/** Modelos que se ofrecen en Ajustes. El primero es el que se usa por defecto. */
export const MODELOS_DE_IA = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

/** Traduce los errores del SDK a errores de negocio que la web sabe explicar. */
function traducir(error: unknown): never {
  if (error instanceof Anthropic.AuthenticationError) {
    throw new ErrorDeNegocio(
      'ia_clave_rechazada',
      'Anthropic rechazó la clave de API. Revisa que esté completa y activa.',
      422,
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    throw new ErrorDeNegocio(
      'ia_sin_permiso',
      'La clave no tiene permiso para usar ese modelo.',
      422,
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    throw new ErrorDeNegocio(
      'ia_modelo_no_encontrado',
      'Ese modelo no existe para esta clave.',
      422,
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    throw new ErrorDeNegocio(
      'ia_limite',
      'La cuenta de Anthropic del hotel alcanzó su límite de uso. Prueba en un momento.',
      429,
    );
  }
  if (error instanceof Anthropic.APIError || error instanceof Anthropic.APIConnectionError) {
    throw new ErrorDeNegocio(
      'ia_no_disponible',
      'El proveedor de IA no respondió. Prueba de nuevo en un momento.',
      503,
    );
  }
  throw error;
}

export function clienteAnthropic(opciones: { timeoutMs?: number } = {}): ClienteDeIa {
  const cliente = (apiKey: string) =>
    new Anthropic({ apiKey, timeout: opciones.timeoutMs ?? 60_000, maxRetries: 1 });

  return {
    async verificar({ apiKey, modelo }) {
      try {
        // Models API: no consume tokens y falla con 401 si la clave no vale,
        // o con 404 si el modelo no existe.
        await cliente(apiKey).models.retrieve(modelo);
      } catch (error) {
        traducir(error);
      }
    },

    async sugerir({ apiKey, modelo, sistema, mensaje }) {
      try {
        const r = await cliente(apiKey).beta.messages.create({
          model: modelo,
          // Una respuesta de chat es corta; el tope evita pagar de más si el
          // modelo se alarga, sin cortar una respuesta normal.
          max_tokens: 2000,
          // Es un borrador de chat, no un razonamiento difícil: esfuerzo bajo
          // responde antes y gasta menos de la cuenta del hotel. Haiku 4.5 no
          // acepta `effort` (devuelve error): a ese no se le manda.
          ...(modelo === 'claude-haiku-4-5' ? {} : { output_config: { effort: 'low' as const } }),
          // En Opus 5, si el modelo declina, el API reintenta en otro dentro de
          // la misma llamada en vez de dejar al agente sin borrador.
          ...(modelo === 'claude-opus-5'
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
          system: sistema,
          messages: [{ role: 'user', content: mensaje }],
        });
        if (r.stop_reason === 'refusal') {
          throw new ErrorDeNegocio(
            'ia_rechazo',
            'La IA no quiso redactar una respuesta para esta conversación. Escríbela a mano.',
            422,
          );
        }
        const texto = r.content
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join('')
          .trim();
        if (!texto) {
          throw new ErrorDeNegocio('ia_vacia', 'La IA no devolvió ningún texto.', 502);
        }
        return texto;
      } catch (error) {
        if (error instanceof ErrorDeNegocio) throw error;
        traducir(error);
      }
    },
  };
}
