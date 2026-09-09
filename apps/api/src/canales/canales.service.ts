/**
 * Conexión BYO de canales (ADR-004): el cliente trae su propia cuenta de
 * WhatsApp Cloud API y pega aquí sus credenciales.
 *
 * Es el único sitio del sistema donde un token de canal existe en claro más
 * allá de una variable local: entra por la petición, se verifica contra Meta
 * y se guarda cifrado. No se devuelve nunca, ni en la respuesta de alta ni en
 * el listado. Si el cliente lo pierde, lo vuelve a pegar.
 */
import type { PoolClient } from 'pg';
import type { Cifrador } from '@crmapp/crypto';
import {
  borrarSecretosDeCanal,
  crearResolverDeCredencialesInstagram,
  crearResolverDeCredencialesWhatsapp,
  crearResolverDeCuenta,
  guardarSecretoDeCanal,
} from '@crmapp/db';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface CredencialesDeAlta {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
  displayName?: string | undefined;
}

export interface CredencialesDeAltaInstagram {
  /** Id de la cuenta profesional de Instagram (IG User). */
  igUserId: string;
  accessToken: string;
  appSecret: string;
  displayName?: string | undefined;
}

export type VerificadorDeInstagram = (
  cred: Pick<CredencialesDeAltaInstagram, 'igUserId' | 'accessToken'>,
) => Promise<{ nombreDeUsuario: string }>;

/** `GET /{ig-user-id}?fields=username`: si el token no ve la cuenta, no se guarda nada. */
export function verificadorGraphInstagram(
  opciones: { fetch?: typeof fetch; apiVersion?: string } = {},
): VerificadorDeInstagram {
  const f = opciones.fetch ?? globalThis.fetch;
  const v = opciones.apiVersion ?? 'v21.0';
  return async ({ igUserId, accessToken }) => {
    let r: Response;
    try {
      r = await f(`https://graph.facebook.com/${v}/${igUserId}?fields=username,name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      throw new ErrorDeNegocio(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        503,
      );
    }
    if (!r.ok) {
      throw new ErrorDeNegocio(
        'credenciales_rechazadas',
        `Meta rechazó las credenciales (HTTP ${r.status}). Revisa el token y el id de la cuenta de Instagram.`,
        422,
      );
    }
    const json = (await r.json()) as { username?: string; name?: string };
    return { nombreDeUsuario: json.username ? `@${json.username}` : (json.name ?? igUserId) };
  };
}

export interface IdentidadVerificada {
  numeroMostrado: string;
  nombreVerificado: string;
}

/**
 * Comprueba las credenciales contra el proveedor ANTES de guardarlas.
 *
 * Se inyecta para poder probar sin red. La implementación real pide
 * `GET /{phone_number_id}?fields=display_phone_number,verified_name`: si el
 * token no sirve o no corresponde a ese número, Meta responde error y no se
 * guarda nada. Guardar credenciales sin verificar es el fallo típico: el
 * cliente pega mal el token y se entera dos días después, cuando nadie
 * recibe nada.
 */
export type VerificadorDeCredenciales = (
  cred: Pick<CredencialesDeAlta, 'phoneNumberId' | 'accessToken'>,
) => Promise<IdentidadVerificada>;

export function verificadorGraph(
  opciones: { fetch?: typeof fetch; apiVersion?: string } = {},
): VerificadorDeCredenciales {
  const f = opciones.fetch ?? globalThis.fetch;
  const v = opciones.apiVersion ?? 'v21.0';
  return async ({ phoneNumberId, accessToken }) => {
    let r: Response;
    try {
      r = await f(
        `https://graph.facebook.com/${v}/${phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
    } catch (error) {
      throw new ErrorDeNegocio(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        503,
      );
    }
    if (!r.ok) {
      throw new ErrorDeNegocio(
        'credenciales_rechazadas',
        `Meta rechazó las credenciales (HTTP ${r.status}). Revisa el token y el phone_number_id.`,
        422,
      );
    }
    const json = (await r.json()) as { display_phone_number?: string; verified_name?: string };
    return {
      numeroMostrado: json.display_phone_number ?? phoneNumberId,
      nombreVerificado: json.verified_name ?? '',
    };
  };
}

export interface CuentaDeCanal {
  id: string;
  canal: string;
  externalId: string;
  providerAccountId: string | null;
  displayName: string;
  status: string;
  lastEventAt: Date | null;
  createdAt: Date;
}

export interface OpcionesDeCanales {
  db: BaseDeDatos;
  cifrador: Cifrador;
  verificar: VerificadorDeCredenciales;
  verificarInstagram?: VerificadorDeInstagram;
}

export class CanalesService {
  readonly #db: BaseDeDatos;
  readonly #cifrador: Cifrador;
  readonly #verificar: VerificadorDeCredenciales;
  readonly #verificarInstagram: VerificadorDeInstagram;

  constructor(o: OpcionesDeCanales) {
    this.#db = o.db;
    this.#cifrador = o.cifrador;
    this.#verificar = o.verificar;
    this.#verificarInstagram = o.verificarInstagram ?? verificadorGraphInstagram();
    this.resolverCuenta = crearResolverDeCuenta(o.db.poolAuth, o.cifrador);
    this.resolverCredencialesWhatsapp = crearResolverDeCredencialesWhatsapp(
      o.db.poolAuth,
      o.cifrador,
    );
    this.resolverCredencialesInstagram = crearResolverDeCredencialesInstagram(
      o.db.poolAuth,
      o.cifrador,
    );
  }

  /** Conexión BYO de Instagram: mismo camino que WhatsApp, sin WABA. */
  async conectarInstagram(cred: CredencialesDeAltaInstagram): Promise<CuentaDeCanal> {
    const ctx = this.#exigirAdmin();
    const identidad = await this.#verificarInstagram(cred);

    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO channel_accounts
             (id, tenant_id, channel, external_id, display_name, status, last_synced_at)
           VALUES ($1, $2, 'instagram', $3, $4, 'connected', now())`,
          [id, ctx.tenantId, cred.igUserId, cred.displayName ?? identidad.nombreDeUsuario],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'numero_ya_conectado',
            'Esa cuenta de Instagram ya está conectada a una cuenta.',
            409,
          );
        }
        throw error;
      }
      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'access_token',
        valor: cred.accessToken,
      });
      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'app_secret',
        valor: cred.appSecret,
      });
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'canal.conectado', 'channel_account', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          id,
          JSON.stringify({ canal: 'instagram', cuenta: identidad.nombreDeUsuario }),
        ],
      );
      return (await this.#leer(c, id))!;
    });
  }

  async conectarWhatsapp(cred: CredencialesDeAlta): Promise<CuentaDeCanal> {
    const ctx = this.#exigirAdmin();

    // Verificar ANTES de abrir la transacción: es una llamada de red y no debe
    // retener conexión ni bloqueos mientras Meta responde.
    const identidad = await this.#verificar(cred);

    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO channel_accounts
             (id, tenant_id, channel, external_id, provider_account_id, display_name, status, last_synced_at)
           VALUES ($1, $2, 'whatsapp', $3, $4, $5, 'connected', now())`,
          [
            id,
            ctx.tenantId,
            cred.phoneNumberId,
            cred.wabaId,
            cred.displayName ?? identidad.numeroMostrado,
          ],
        );
      } catch (error) {
        // Unicidad GLOBAL (channel, external_id): un número no puede estar en
        // dos cuentas. El mensaje no dice en cuál está: sería filtrar datos
        // de otro inquilino.
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'numero_ya_conectado',
            'Ese número ya está conectado a una cuenta.',
            409,
          );
        }
        throw error;
      }

      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'access_token',
        valor: cred.accessToken,
      });
      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'app_secret',
        valor: cred.appSecret,
      });

      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'canal.conectado', 'channel_account', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          id,
          JSON.stringify({ canal: 'whatsapp', numero: identidad.numeroMostrado }),
        ],
      );

      return (await this.#leer(c, id))!;
    });
  }

  async listar(): Promise<CuentaDeCanal[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<FilaCuenta>(
        `SELECT id, channel, external_id, provider_account_id, display_name, status, last_event_at, created_at
           FROM channel_accounts ORDER BY created_at`,
      );
      return rows.map(aCuenta);
    });
  }

  /** Desconecta: estado, y los secretos se BORRAN, no se dejan por si acaso. */
  async desconectar(id: string): Promise<void> {
    const ctx = this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const cuenta = await this.#leer(c, id);
      if (!cuenta) throw new ErrorDeNegocio('canal_no_encontrado', 'El canal no existe.', 404);
      await borrarSecretosDeCanal(c, id);
      await c.query(
        `UPDATE channel_accounts SET status = 'disconnected', updated_at = now() WHERE id = $1`,
        [id],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'canal.desconectado', 'channel_account', $3)`,
        [ctx.tenantId, ctx.userId, id],
      );
    });
  }

  // -------------------------------------------------------------------------
  // Resolvers, para los webhooks y para el adaptador. Viven en @crmapp/db
  // porque el worker tambien los usa; aqui solo se exponen.
  // -------------------------------------------------------------------------

  readonly resolverCuenta: ReturnType<typeof crearResolverDeCuenta>;
  readonly resolverCredencialesWhatsapp: ReturnType<typeof crearResolverDeCredencialesWhatsapp>;
  readonly resolverCredencialesInstagram: ReturnType<typeof crearResolverDeCredencialesInstagram>;

  // -------------------------------------------------------------------------

  async #leer(c: PoolClient, id: string): Promise<CuentaDeCanal | null> {
    const { rows } = await c.query<FilaCuenta>(
      `SELECT id, channel, external_id, provider_account_id, display_name, status, last_event_at, created_at
         FROM channel_accounts WHERE id = $1`,
      [id],
    );
    return rows[0] ? aCuenta(rows[0]) : null;
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  #exigirAdmin() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden conectar canales.',
        403,
      );
    }
    return ctx;
  }
}

interface FilaCuenta {
  id: string;
  channel: string;
  external_id: string;
  provider_account_id: string | null;
  display_name: string;
  status: string;
  last_event_at: Date | null;
  created_at: Date;
}

function aCuenta(f: FilaCuenta): CuentaDeCanal {
  return {
    id: f.id,
    canal: f.channel,
    externalId: f.external_id,
    providerAccountId: f.provider_account_id,
    displayName: f.display_name,
    status: f.status,
    lastEventAt: f.last_event_at,
    createdAt: f.created_at,
  };
}
