/**
 * Descubrimiento de cuentas con un solo token (P-26, opción A).
 *
 * El cliente pega su token y la clave secreta de su app; el sistema pregunta a
 * Meta qué cuentas ve ese token y le deja ELEGIR, en vez de pedirle que copie
 * `phone_number_id`, id de WABA o id de Instagram del panel de desarrolladores.
 *
 * Solo endpoints documentados por Meta — nada inventado:
 *
 * - WhatsApp: `GET /debug_token` (sus `granular_scopes` de
 *   `whatsapp_business_management` traen los ids de WABA en `target_ids`),
 *   `GET /{waba-id}?fields=name` y `GET /{waba-id}/phone_numbers`.
 * - Instagram con inicio de sesión de Facebook: `GET /me/accounts` con el
 *   campo `instagram_business_account` de cada página, y el token de página que
 *   devuelve ese mismo listado.
 *
 * No es el Embedded Signup de Kommo: el token lo sigue sacando el cliente de su
 * propia app (ADR-004). Pero deja de copiar identificadores.
 *
 * `debug_token` admite como llamante un token de desarrollador de la app; si el
 * token del cliente no lo es (o no trae permisos granulares), no hay forma
 * documentada de listar sus WABA y se le pide ESE único dato. Se dice, no se
 * adivina.
 */
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface NumeroDescubierto {
  phoneNumberId: string;
  numero: string;
  nombreVerificado: string;
  /** GREEN / YELLOW / RED según Meta, o null si no lo dice. */
  calidad: string | null;
}

export interface WabaDescubierta {
  wabaId: string;
  nombre: string | null;
  numeros: NumeroDescubierto[];
}

export interface DescubrimientoWhatsapp {
  cuentas: WabaDescubierta[];
  /** true = Meta no deja listar las cuentas con este token: hace falta el id de WABA. */
  necesitaWaba: boolean;
  /** Cuándo caduca el token; null = no caduca (o Meta no lo dijo). */
  caducaEn: Date | null;
}

export interface CuentaDeInstagramDescubierta {
  igUserId: string;
  usuario: string | null;
  paginaId: string;
  pagina: string;
}

/** Lo que el servidor necesita y la web NO recibe nunca: el token de página. */
export interface PaginaConToken extends CuentaDeInstagramDescubierta {
  tokenDePagina: string;
}

export interface DescubridorDeMeta {
  whatsapp(p: {
    accessToken: string;
    wabaId?: string | undefined;
  }): Promise<DescubrimientoWhatsapp>;
  /** Páginas con cuenta profesional de Instagram vinculada, con su token de página. */
  instagram(p: { accessToken: string }): Promise<PaginaConToken[]>;
  /**
   * Suscribe la página a los webhooks de Instagram (`messages` y `comments`).
   * Sin esto la cuenta queda conectada y sorda, igual que la WABA (PR-21).
   */
  suscribirPagina(p: { paginaId: string; tokenDePagina: string }): Promise<boolean>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

/** Campos que se piden a Meta al listar números. */
const CAMPOS_DE_NUMERO = 'id,display_phone_number,verified_name,quality_rating';
/** Campos de webhook de Instagram que el CRM consume. */
export const CAMPOS_DE_WEBHOOK_INSTAGRAM = 'messages,comments';

export function descubridorGraph(
  opciones: { fetch?: typeof fetch; apiVersion?: string } = {},
): DescubridorDeMeta {
  const f = opciones.fetch ?? globalThis.fetch;
  const v = opciones.apiVersion ?? 'v21.0';
  const base = `https://graph.facebook.com/${v}`;

  async function pedir(
    ruta: string,
    token: string,
    metodo: 'GET' | 'POST' = 'GET',
  ): Promise<{ ok: boolean; status: number; json: Obj }> {
    let r: Response;
    try {
      r = await f(`${base}${ruta}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throw new ErrorDeNegocio(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        503,
      );
    }
    let json: Obj = {};
    try {
      json = obj(await r.json());
    } catch {
      /* sin cuerpo: decide el status */
    }
    return { ok: r.ok, status: r.status, json };
  }

  const rechazado = (status: number, que: string) =>
    new ErrorDeNegocio(
      'credenciales_rechazadas',
      `Meta rechazó el token (HTTP ${status}) al ${que}. Revisa que esté completo y no haya caducado.`,
      422,
    );

  async function numerosDe(wabaId: string, token: string): Promise<WabaDescubierta> {
    const [cuenta, numeros] = await Promise.all([
      pedir(`/${encodeURIComponent(wabaId)}?fields=name`, token),
      pedir(`/${encodeURIComponent(wabaId)}/phone_numbers?fields=${CAMPOS_DE_NUMERO}`, token),
    ]);
    if (!numeros.ok) throw rechazado(numeros.status, 'listar los números de la cuenta');
    return {
      wabaId,
      nombre: cuenta.ok ? (str(cuenta.json['name']) ?? null) : null,
      numeros: arr(numeros.json['data']).flatMap((n) => {
        const o = obj(n);
        const id = str(o['id']);
        if (!id) return [];
        return [
          {
            phoneNumberId: id,
            numero: str(o['display_phone_number']) ?? id,
            nombreVerificado: str(o['verified_name']) ?? '',
            calidad: str(o['quality_rating']) ?? null,
          },
        ];
      }),
    };
  }

  return {
    async whatsapp({ accessToken, wabaId }) {
      let caducaEn: Date | null = null;
      let wabas: string[] = [];

      const d = await pedir(
        `/debug_token?input_token=${encodeURIComponent(accessToken)}`,
        accessToken,
      );
      if (d.ok) {
        const datos = obj(d.json['data']);
        if (datos['is_valid'] === false) throw rechazado(d.status, 'comprobar el token');
        const expira = Number(datos['expires_at']);
        caducaEn = Number.isFinite(expira) && expira > 0 ? new Date(expira * 1000) : null;
        const alcance = arr(datos['granular_scopes'])
          .map(obj)
          .find((s) => s['scope'] === 'whatsapp_business_management');
        wabas = arr(alcance?.['target_ids']).flatMap((t) => str(t) ?? []);
      } else if (d.status === 401 || obj(d.json['error'])['code'] === 190) {
        // 190 = token inválido o caducado: no tiene sentido pedir la WABA.
        throw rechazado(d.status, 'comprobar el token');
      }

      if (wabaId) wabas = [wabaId, ...wabas.filter((w) => w !== wabaId)];
      if (wabas.length === 0) return { cuentas: [], necesitaWaba: true, caducaEn };

      const cuentas = await Promise.all(wabas.map((w) => numerosDe(w, accessToken)));
      return { cuentas, necesitaWaba: false, caducaEn };
    },

    async instagram({ accessToken }) {
      const campos = 'id,name,access_token,instagram_business_account{id,username}';
      const r = await pedir(`/me/accounts?fields=${encodeURIComponent(campos)}`, accessToken);
      if (r.ok) {
        return arr(r.json['data']).flatMap((p) => {
          const pagina = obj(p);
          const ig = obj(pagina['instagram_business_account']);
          const igUserId = str(ig['id']);
          const paginaId = str(pagina['id']);
          const tokenDePagina = str(pagina['access_token']);
          if (!igUserId || !paginaId || !tokenDePagina) return [];
          return [
            {
              igUserId,
              usuario: str(ig['username']) ? `@${str(ig['username'])}` : null,
              paginaId,
              pagina: str(pagina['name']) ?? paginaId,
              tokenDePagina,
            },
          ];
        });
      }
      if (r.status === 401 || obj(r.json['error'])['code'] === 190) {
        throw rechazado(r.status, 'listar tus páginas');
      }

      // `/me/accounts` solo existe para tokens de USUARIO. Si el cliente pegó
      // ya un token de página, `/me` ES la página: se lee su Instagram.
      const yo = await pedir(
        `/me?fields=${encodeURIComponent('id,name,instagram_business_account{id,username}')}`,
        accessToken,
      );
      if (!yo.ok) throw rechazado(yo.status, 'leer la cuenta del token');
      const ig = obj(yo.json['instagram_business_account']);
      const igUserId = str(ig['id']);
      const paginaId = str(yo.json['id']);
      if (!igUserId || !paginaId) return [];
      return [
        {
          igUserId,
          usuario: str(ig['username']) ? `@${str(ig['username'])}` : null,
          paginaId,
          pagina: str(yo.json['name']) ?? paginaId,
          tokenDePagina: accessToken,
        },
      ];
    },

    async suscribirPagina({ paginaId, tokenDePagina }) {
      try {
        const r = await pedir(
          `/${encodeURIComponent(paginaId)}/subscribed_apps?subscribed_fields=${CAMPOS_DE_WEBHOOK_INSTAGRAM}`,
          tokenDePagina,
          'POST',
        );
        return r.ok && r.json['success'] === true;
      } catch {
        return false;
      }
    },
  };
}
