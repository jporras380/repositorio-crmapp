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

/** Una página de Facebook que ve el token, con su Instagram si lo tiene. */
export interface PaginaDescubierta {
  paginaId: string;
  pagina: string;
  tokenDePagina: string;
  igUserId: string | null;
  usuario: string | null;
}

export interface DescubridorDeMeta {
  whatsapp(p: {
    accessToken: string;
    wabaId?: string | undefined;
  }): Promise<DescubrimientoWhatsapp>;
  /** Todas las páginas de Facebook que ve el token, con su token de página. */
  paginas(p: { accessToken: string }): Promise<PaginaDescubierta[]>;
  /** Páginas con cuenta profesional de Instagram vinculada, con su token de página. */
  instagram(p: { accessToken: string }): Promise<PaginaConToken[]>;
  /**
   * Suscribe la página a los campos de webhook dados. Sin esto la cuenta
   * queda conectada y sorda, igual que la WABA (PR-21). Meta REEMPLAZA la
   * lista de campos de la app en cada llamada: quien llama pasa todos los que
   * necesita esa página, no solo los del canal que conecta.
   */
  suscribirPagina(p: {
    paginaId: string;
    tokenDePagina: string;
    campos: readonly string[];
  }): Promise<boolean>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

/** Campos que se piden a Meta al listar números. */
const CAMPOS_DE_NUMERO = 'id,display_phone_number,verified_name,quality_rating';
/** Campos de webhook que cada canal necesita de la página (documentación de Meta). */
/**
 * Lo mínimo para ver y atender una página. Sin `pages_show_list` la lista
 * llega vacía; sin `pages_messaging` no se puede responder un Messenger, y sin
 * `pages_read_engagement` no llegan los comentarios del muro.
 */
const PERMISOS_DE_PAGINA = ['pages_show_list', 'pages_messaging', 'pages_read_engagement'];

export const CAMPOS_DE_WEBHOOK = {
  instagram: ['messages', 'comments'],
  facebook: ['messages', 'feed'],
} as const;

function aPagina(pagina: Obj, paginaId: string, tokenDePagina: string): PaginaDescubierta {
  const ig = obj(pagina['instagram_business_account']);
  const username = str(ig['username']);
  return {
    paginaId,
    pagina: str(pagina['name']) ?? paginaId,
    tokenDePagina,
    igUserId: str(ig['id']) ?? null,
    usuario: username ? `@${username}` : null,
  };
}

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

  /** Permisos que Meta dice que tiene el token, o `null` si no se puede saber. */
  async function permisosDe(accessToken: string): Promise<string[] | null> {
    const d = await pedir(
      `/debug_token?input_token=${encodeURIComponent(accessToken)}`,
      accessToken,
    );
    if (!d.ok) return null;
    const scopes = arr(obj(d.json['data'])['scopes']).flatMap((x) => str(x) ?? []);
    return scopes;
  }

  /**
   * Por qué no salió ninguna página, dicho con nombres y apellidos.
   *
   * Cuando a un token le faltan los permisos de páginas, Meta **no devuelve un
   * error**: devuelve `data: []` y un 200. El cliente ve «no tienes páginas»,
   * que es mentira, y se queda mirando su página de Facebook sin entender
   * nada. Preguntando por los permisos se puede decir lo que de verdad pasa.
   */
  async function porQueNingunaPagina(accessToken: string): Promise<never | void> {
    const permisos = await permisosDe(accessToken);
    if (!permisos) return;
    const faltan = PERMISOS_DE_PAGINA.filter((p) => !permisos.includes(p));
    if (faltan.length === 0) return;
    throw new ErrorDeNegocio(
      'permisos_insuficientes',
      `Este token no tiene ${faltan.join(', ')}. Sin esos permisos Meta devuelve la lista ` +
        `de páginas vacía aunque administres alguna. Genera el token otra vez marcándolos.`,
      422,
    );
  }

  /**
   * Una página asignada a un usuario del sistema, con su token de página.
   *
   * `assigned_pages` puede devolver `access_token` o no, según cómo esté
   * concedido el acceso; cuando no viene, se pide a la propia página. Sin ese
   * token no se puede ni suscribir la página ni responder, así que no vale
   * devolverla a medias y descubrirlo al enviar.
   */
  async function conTokenDePagina(
    pagina: Obj,
    paginaId: string,
    tokenDeUsuario: string,
  ): Promise<PaginaDescubierta> {
    const suyo = str(pagina['access_token']);
    if (suyo) return aPagina(pagina, paginaId, suyo);
    const r = await pedir(`/${encodeURIComponent(paginaId)}?fields=access_token`, tokenDeUsuario);
    const token = r.ok ? str(r.json['access_token']) : null;
    if (!token) throw rechazado(r.status, `obtener el token de la página "${paginaId}"`);
    return aPagina(pagina, paginaId, token);
  }

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

      // Un token de usuario del sistema llegó SIN ids en `granular_scopes`
      // (Meta real, 2026-09-14). Sus WABA son las asignadas a ese usuario:
      // `/{user-id}/assigned_whatsapp_business_accounts`, documentado. La WABA
      // del número de prueba de Meta cuelga de la app y tampoco sale por aquí:
      // en ese caso se pide el id.
      if (wabas.length === 0 && !wabaId) {
        const asignadas = await pedir(
          '/me/assigned_whatsapp_business_accounts?fields=id',
          accessToken,
        );
        if (asignadas.ok) {
          wabas = arr(asignadas.json['data']).flatMap((w) => str(obj(w)['id']) ?? []);
        }
      }

      if (wabaId) wabas = [wabaId, ...wabas.filter((w) => w !== wabaId)];
      if (wabas.length === 0) return { cuentas: [], necesitaWaba: true, caducaEn };

      const cuentas = await Promise.all(wabas.map((w) => numerosDe(w, accessToken)));
      return { cuentas, necesitaWaba: false, caducaEn };
    },

    async paginas({ accessToken }) {
      const campos = 'id,name,access_token,instagram_business_account{id,username}';
      const r = await pedir(`/me/accounts?fields=${encodeURIComponent(campos)}`, accessToken);
      if (r.ok) {
        const suyas = arr(r.json['data']).flatMap((p) => {
          const pagina = obj(p);
          const paginaId = str(pagina['id']);
          const tokenDePagina = str(pagina['access_token']);
          if (!paginaId || !tokenDePagina) return [];
          return [aPagina(pagina, paginaId, tokenDePagina)];
        });
        if (suyas.length > 0) return suyas;

        // `/me/accounts` es de tokens de USUARIO. Con uno de usuario del
        // sistema devuelve `data: []` y un 200 — o sea «no tienes páginas»
        // sin ningún error, que es la peor forma de fallar. Sus páginas son
        // las ASIGNADAS en el Business Manager, y ese es otro borde. Mismo
        // caso que las WABA, arriba (Meta real, 2026-09-17).
        const asignadas = await pedir(
          `/me/assigned_pages?fields=${encodeURIComponent(campos)}`,
          accessToken,
        );
        if (asignadas.ok) {
          const deSistema = await Promise.all(
            arr(asignadas.json['data']).flatMap((p) => {
              const pagina = obj(p);
              const paginaId = str(pagina['id']);
              if (!paginaId) return [];
              return [conTokenDePagina(pagina, paginaId, accessToken)];
            }),
          );
          if (deSistema.length > 0) return deSistema;
        }
        // Ni por un camino ni por el otro: antes de decir «no tienes páginas»
        // hay que descartar que el problema sean los permisos.
        await porQueNingunaPagina(accessToken);
        return [];
      }
      if (r.status === 401 || obj(r.json['error'])['code'] === 190) {
        throw rechazado(r.status, 'listar tus páginas');
      }

      // `/me/accounts` solo existe para tokens de USUARIO. Si el cliente pegó
      // ya un token de página, `/me` ES la página.
      const yo = await pedir(
        `/me?fields=${encodeURIComponent('id,name,instagram_business_account{id,username}')}`,
        accessToken,
      );
      if (!yo.ok) throw rechazado(yo.status, 'leer la cuenta del token');
      const paginaId = str(yo.json['id']);
      if (!paginaId) return [];
      return [aPagina(yo.json, paginaId, accessToken)];
    },

    async instagram({ accessToken }) {
      return (await this.paginas({ accessToken })).flatMap((p) =>
        p.igUserId
          ? [
              {
                igUserId: p.igUserId,
                usuario: p.usuario,
                paginaId: p.paginaId,
                pagina: p.pagina,
                tokenDePagina: p.tokenDePagina,
              },
            ]
          : [],
      );
    },

    async suscribirPagina({ paginaId, tokenDePagina, campos }) {
      try {
        const r = await pedir(
          `/${encodeURIComponent(paginaId)}/subscribed_apps?subscribed_fields=${campos.join(',')}`,
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
