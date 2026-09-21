/**
 * Qué proveedores de IA acepta el CRM, y qué hay que saber de cada uno.
 *
 * Todos van con la clave del propio hotel (BYOK, P-11): el CRM no revende IA
 * ni paga por ella. Quien elige, paga y responde de sus datos.
 *
 * ## Por qué el proveedor se guarda aparte del modelo
 *
 * Se podría deducir del nombre —«gemini-…» es de Google— y funcionaría hasta
 * el primer modelo afinado que alguien llame `hotel-v2`. Guardarlo explícito
 * cuesta una columna y quita para siempre la adivinanza.
 *
 * ## Por qué los modelos son sugerencias y no una lista cerrada
 *
 * Los nombres de modelo cambian cada pocos meses. Una lista cerrada envejece
 * y obliga a desplegar el CRM para poder usar el modelo que salió ayer. Así
 * que se sugieren los conocidos y se deja escribir cualquier otro: al guardar,
 * el CRM lo comprueba contra el proveedor, y un nombre inventado se rechaza
 * ahí mismo con su motivo.
 */

import type { TipoDeSecretoDeInquilino } from '@crmapp/db';

export const PROVEEDORES = ['anthropic', 'google', 'openai', 'xai'] as const;
export type Proveedor = (typeof PROVEEDORES)[number];

export interface DatosDeProveedor {
  id: Proveedor;
  nombre: string;
  /** `tenant_secrets.kind` donde vive su clave. Cada uno tiene la suya. */
  claveKind: TipoDeSecretoDeInquilino;
  /** Sugerencias para el desplegable; se puede escribir otro. */
  modelos: readonly string[];
  /** Dónde se saca la clave, para no tener que buscarlo. */
  dondeSacarLaClave: string;
  /**
   * Lo que hay que saber ANTES de mandarle conversaciones de huéspedes.
   * Vacío si no hay nada que advertir.
   */
  aviso: string;
}

export const PROVEEDORES_DE_IA: Record<Proveedor, DatosDeProveedor> = {
  anthropic: {
    id: 'anthropic',
    nombre: 'Claude (Anthropic)',
    claveKind: 'anthropic_api_key',
    modelos: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    dondeSacarLaClave: 'console.anthropic.com → API keys',
    aviso: '',
  },
  google: {
    id: 'google',
    nombre: 'Gemini (Google)',
    claveKind: 'google_api_key',
    modelos: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    dondeSacarLaClave: 'aistudio.google.com → Get API key',
    // Esto no es letra pequeña: son conversaciones de huéspedes con su
    // teléfono, sus fechas y a veces su tarjeta. El plan gratuito de Gemini
    // usa lo que se le manda para mejorar sus modelos; el de pago, no. Quien
    // lo elija tiene que saberlo antes, no después.
    aviso:
      'El plan GRATUITO de Gemini usa lo que se le envía para mejorar los modelos de Google, ' +
      'y eso incluiría los mensajes de tus huéspedes. Para uso real, usa una clave de pago ' +
      '(facturación activada en Google Cloud).',
  },
  openai: {
    id: 'openai',
    nombre: 'GPT (OpenAI)',
    claveKind: 'openai_api_key',
    modelos: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'],
    dondeSacarLaClave: 'platform.openai.com → API keys',
    aviso: '',
  },
  xai: {
    id: 'xai',
    nombre: 'Grok (xAI)',
    claveKind: 'xai_api_key',
    modelos: ['grok-4', 'grok-3', 'grok-3-mini'],
    dondeSacarLaClave: 'console.x.ai → API keys',
    aviso: '',
  },
};

export function esProveedor(v: string): v is Proveedor {
  return (PROVEEDORES as readonly string[]).includes(v);
}

/** El catálogo tal cual lo necesita la pantalla de ajustes. */
export function catalogoDeProveedores() {
  return PROVEEDORES.map((p) => {
    const d = PROVEEDORES_DE_IA[p];
    return {
      id: d.id,
      nombre: d.nombre,
      modelos: d.modelos,
      dondeSacarLaClave: d.dondeSacarLaClave,
      aviso: d.aviso,
    };
  });
}
