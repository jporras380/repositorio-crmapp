/**
 * Crear y borrar plantillas HSM en Meta.
 *
 * Vive aquí y NO en `ChannelAdapter` a propósito: ese contrato está en la
 * lista de parada, y crear plantillas es gestión de la WABA, no envío por un
 * canal. El adaptador sigue haciendo lo suyo (enviar y sincronizar).
 *
 * Endpoints documentados por Meta:
 * - `POST /{waba-id}/message_templates` con `name`, `language`, `category` y
 *   `components`; responde `{ id, status, category }`.
 * - `DELETE /{waba-id}/message_templates?name=…` (con `hsm_id` cuando se
 *   quiere borrar solo un idioma); responde `{ success: true }`.
 */
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface PlantillaCreadaEnMeta {
  metaTemplateId: string;
  /** Lo que dice Meta al crearla: casi siempre `PENDING`. */
  estado: string;
  /** La categoría que Meta FIJA, que puede no ser la declarada (y decide el costo). */
  categoriaEfectiva: string | null;
}

export interface EditorDePlantillasDeMeta {
  crear(p: {
    wabaId: string;
    accessToken: string;
    nombre: string;
    idioma: string;
    categoria: string;
    componentes: unknown[];
  }): Promise<PlantillaCreadaEnMeta>;
  borrar(p: {
    wabaId: string;
    accessToken: string;
    nombre: string;
    metaTemplateId?: string | undefined;
  }): Promise<void>;
}

interface RespuestaGraph {
  id?: string;
  status?: string;
  category?: string;
  success?: boolean;
  error?: { message?: string; code?: number; error_user_msg?: string };
}

export function editorGraph(
  opciones: { fetch?: typeof fetch; apiVersion?: string } = {},
): EditorDePlantillasDeMeta {
  const f = opciones.fetch ?? globalThis.fetch;
  const v = opciones.apiVersion ?? 'v21.0';
  const base = `https://graph.facebook.com/${v}`;

  async function pedir(
    ruta: string,
    token: string,
    metodo: 'POST' | 'DELETE',
    cuerpo?: unknown,
  ): Promise<RespuestaGraph> {
    let r: Response;
    try {
      r = await f(`${base}${ruta}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
      });
    } catch (error) {
      throw new ErrorDeNegocio(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        503,
      );
    }
    let json: RespuestaGraph = {};
    try {
      json = (await r.json()) as RespuestaGraph;
    } catch {
      /* decide el status */
    }
    if (!r.ok) {
      // `error_user_msg` es el motivo en lenguaje llano; es lo que corrige el
      // usuario. Si no viene, el mensaje técnico, que es mejor que nada.
      const detalle = json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${r.status}`;
      throw new ErrorDeNegocio(
        r.status === 401 || json.error?.code === 190
          ? 'token_invalido'
          : 'plantilla_rechazada_por_meta',
        `Meta no aceptó la plantilla: ${detalle}`,
        r.status === 401 ? 422 : 422,
      );
    }
    return json;
  }

  return {
    async crear({ wabaId, accessToken, nombre, idioma, categoria, componentes }) {
      const json = await pedir(
        `/${encodeURIComponent(wabaId)}/message_templates`,
        accessToken,
        'POST',
        { name: nombre, language: idioma, category: categoria, components: componentes },
      );
      if (!json.id) {
        throw new ErrorDeNegocio(
          'plantilla_sin_id',
          'Meta aceptó la plantilla pero no devolvió su identificador.',
          502,
        );
      }
      return {
        metaTemplateId: json.id,
        estado: json.status ?? 'PENDING',
        categoriaEfectiva: json.category ?? null,
      };
    },

    async borrar({ wabaId, accessToken, nombre, metaTemplateId }) {
      const cola = new URLSearchParams({ name: nombre });
      if (metaTemplateId) cola.set('hsm_id', metaTemplateId);
      await pedir(
        `/${encodeURIComponent(wabaId)}/message_templates?${cola.toString()}`,
        accessToken,
        'DELETE',
      );
    },
  };
}
