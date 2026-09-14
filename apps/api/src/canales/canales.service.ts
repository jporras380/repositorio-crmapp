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
import {
  descubridorGraph,
  type CuentaDeInstagramDescubierta,
  type DescubridorDeMeta,
  type NumeroDescubierto,
  type WabaDescubierta,
} from './descubrimiento.js';

/** Lo que ve la web al descubrir: nunca tokens, y qué está ya conectado aquí. */
export interface DescubrimientoWhatsappVisible {
  cuentas: (Omit<WabaDescubierta, 'numeros'> & {
    numeros: (NumeroDescubierto & { yaConectado: boolean })[];
  })[];
  necesitaWaba: boolean;
  caducaEn: Date | null;
}

export type CuentaDeInstagramVisible = CuentaDeInstagramDescubierta & { yaConectado: boolean };

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

/**
 * Suscribe la WABA a NUESTRA app. Sin esto el número queda conectado y sordo:
 * la lista de apps suscritas es de la WABA, no de la app, y el número de
 * prueba viene atado a la app interna del panel de Meta.
 *
 * Devuelve `false` en vez de lanzar cuando el token no tiene permiso: el canal
 * se conecta igual y el aviso se muestra, porque un cliente que ya suscribió
 * su WABA por su cuenta no debe quedarse sin conectar.
 */
export type SuscriptorDeWebhook = (cred: {
  providerAccountId: string;
  accessToken: string;
}) => Promise<boolean>;

export function suscriptorGraph(
  opciones: { fetch?: typeof fetch; apiVersion?: string } = {},
): SuscriptorDeWebhook {
  const f = opciones.fetch ?? globalThis.fetch;
  const v = opciones.apiVersion ?? 'v21.0';
  return async ({ providerAccountId, accessToken }) => {
    if (!providerAccountId) return false;
    try {
      const r = await f(`https://graph.facebook.com/${v}/${providerAccountId}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return false;
      const json = (await r.json()) as { success?: boolean };
      return json.success === true;
    } catch {
      return false;
    }
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
  /** `false` = conectado pero el proveedor no nos envía sus webhooks (0014). */
  webhookSuscrito: boolean | null;
  lastEventAt: Date | null;
  createdAt: Date;
}

export interface OpcionesDeCanales {
  db: BaseDeDatos;
  cifrador: Cifrador;
  verificar: VerificadorDeCredenciales;
  verificarInstagram?: VerificadorDeInstagram;
  suscribir?: SuscriptorDeWebhook;
  descubridor?: DescubridorDeMeta;
}

/** Cómo queda una cuenta de Instagram tras resolver el token que pegó el cliente. */
interface InstagramResuelto {
  tokenAGuardar: string;
  paginaId: string | null;
  nombre: string;
  suscrito: boolean | null;
}

export class CanalesService {
  readonly #db: BaseDeDatos;
  readonly #cifrador: Cifrador;
  readonly #verificar: VerificadorDeCredenciales;
  readonly #verificarInstagram: VerificadorDeInstagram;
  readonly #suscribir: SuscriptorDeWebhook;
  readonly #descubridor: DescubridorDeMeta;

  constructor(o: OpcionesDeCanales) {
    this.#db = o.db;
    this.#cifrador = o.cifrador;
    this.#verificar = o.verificar;
    this.#verificarInstagram = o.verificarInstagram ?? verificadorGraphInstagram();
    this.#suscribir = o.suscribir ?? suscriptorGraph();
    this.#descubridor = o.descubridor ?? descubridorGraph();
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

  /**
   * Qué números ve este token, para elegir en vez de copiar ids. No guarda
   * nada: el alta sigue siendo `conectarWhatsapp`, que verifica otra vez.
   */
  async descubrirWhatsapp(p: {
    accessToken: string;
    wabaId?: string | undefined;
  }): Promise<DescubrimientoWhatsappVisible> {
    this.#exigirAdmin();
    const d = await this.#descubridor.whatsapp(p);
    const conectados = await this.#conectadosAqui('whatsapp');
    return {
      ...d,
      cuentas: d.cuentas.map((w) => ({
        ...w,
        numeros: w.numeros.map((n) => ({ ...n, yaConectado: conectados.has(n.phoneNumberId) })),
      })),
    };
  }

  /** Cuentas de Instagram que ve el token. Los tokens de página no salen de aquí. */
  async descubrirInstagram(p: { accessToken: string }): Promise<CuentaDeInstagramVisible[]> {
    this.#exigirAdmin();
    const paginas = await this.#descubridor.instagram(p);
    const conectados = await this.#conectadosAqui('instagram');
    return paginas.map(({ tokenDePagina: _t, ...visible }) => ({
      ...visible,
      yaConectado: conectados.has(visible.igUserId),
    }));
  }

  /**
   * Conexión BYO de Instagram: mismo camino que WhatsApp, sin WABA.
   *
   * Si el token es de USUARIO y ve la página vinculada a esa cuenta, se guarda
   * el token de PÁGINA —el que exige la API de mensajes— y se suscribe la
   * página a `messages` y `comments`. Si no (ya era de página y Meta no deja
   * listar, o es de otro tipo), se verifica y se guarda tal cual, como antes.
   */
  async conectarInstagram(cred: CredencialesDeAltaInstagram): Promise<CuentaDeCanal> {
    const ctx = this.#exigirAdmin();
    const r = await this.#resolverInstagram(cred.igUserId, cred.accessToken);

    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO channel_accounts
             (id, tenant_id, channel, external_id, provider_account_id, display_name, status,
              last_synced_at, webhook_subscribed)
           VALUES ($1, $2, 'instagram', $3, $4, $5, 'connected', now(), $6)`,
          [id, ctx.tenantId, cred.igUserId, r.paginaId, cred.displayName ?? r.nombre, r.suscrito],
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
        valor: r.tokenAGuardar,
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
          JSON.stringify({
            canal: 'instagram',
            cuenta: r.nombre,
            tokenDePagina: r.paginaId !== null,
            webhookSuscrito: r.suscrito,
          }),
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

    // Y suscribir la WABA a nuestra app, o el número quedaría conectado y
    // sordo. No aborta si falla: se guarda el estado y se avisa.
    const suscrito = await this.#suscribir({
      providerAccountId: cred.wabaId,
      accessToken: cred.accessToken,
    });

    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO channel_accounts
             (id, tenant_id, channel, external_id, provider_account_id, display_name, status,
              last_synced_at, webhook_subscribed)
           VALUES ($1, $2, 'whatsapp', $3, $4, $5, 'connected', now(), $6)`,
          [
            id,
            ctx.tenantId,
            cred.phoneNumberId,
            cred.wabaId,
            cred.displayName ?? identidad.numeroMostrado,
            suscrito,
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
          JSON.stringify({
            canal: 'whatsapp',
            numero: identidad.numeroMostrado,
            webhookSuscrito: suscrito,
          }),
        ],
      );

      return (await this.#leer(c, id))!;
    });
  }

  async listar(): Promise<CuentaDeCanal[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<FilaCuenta>(
        `SELECT id, channel, external_id, provider_account_id, display_name, status,
                webhook_subscribed, last_event_at, created_at
           FROM channel_accounts ORDER BY created_at`,
      );
      return rows.map(aCuenta);
    });
  }

  /** Desconecta: estado, y los secretos se BORRAN, no se dejan por si acaso. */
  /**
   * Renueva las credenciales de un canal ya conectado.
   *
   * Existe porque el token de Meta caduca —el temporal del panel, en 24 h— y
   * la alternativa era desconectar y volver a conectar, que borra los
   * secretos y crea una cuenta nueva: se perderían las conversaciones y las
   * plantillas sincronizadas. Aquí la cuenta es la misma; solo cambian sus
   * secretos.
   *
   * Se verifica contra Meta ANTES de guardar, igual que al conectar: pegar un
   * token malo no puede dejar el canal peor de lo que estaba. Y si la cuenta
   * estaba desconectada, renovar la reconecta: es lo que el usuario quiere.
   */
  async renovarCredenciales(
    id: string,
    datos: { accessToken: string; appSecret?: string | undefined },
  ): Promise<CuentaDeCanal> {
    const ctx = this.#exigirAdmin();

    const cuenta = await this.#db.enTransaccion((c) => this.#leer(c, id));
    if (!cuenta) throw new ErrorDeNegocio('canal_no_encontrado', 'El canal no existe.', 404);

    // Fuera de la transacción: es una llamada de red.
    let suscrito: boolean | null = cuenta.webhookSuscrito;
    let tokenAGuardar = datos.accessToken;
    let paginaId = cuenta.providerAccountId;
    if (cuenta.canal === 'whatsapp') {
      await this.#verificar({ phoneNumberId: cuenta.externalId, accessToken: datos.accessToken });
      // Renovar es la ocasión de arreglar una suscripción que faltaba: el
      // token nuevo puede tener el permiso que al anterior le faltaba.
      if (cuenta.providerAccountId) {
        suscrito = await this.#suscribir({
          providerAccountId: cuenta.providerAccountId,
          accessToken: datos.accessToken,
        });
      }
    } else if (cuenta.canal === 'instagram') {
      // Mismo camino que al conectar: un token de usuario se cambia por el de
      // la página, y renovar es la ocasión de suscribir lo que faltaba.
      const r = await this.#resolverInstagram(cuenta.externalId, datos.accessToken);
      tokenAGuardar = r.tokenAGuardar;
      if (r.paginaId) {
        paginaId = r.paginaId;
        suscrito = r.suscrito;
      }
    } else {
      throw new ErrorDeNegocio(
        'canal_no_soportado',
        `No se sabe verificar credenciales de "${cuenta.canal}".`,
        422,
      );
    }

    return this.#db.enTransaccion(async (c) => {
      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'access_token',
        valor: tokenAGuardar,
      });
      if (datos.appSecret) {
        await guardarSecretoDeCanal(c, this.#cifrador, {
          tenantId: ctx.tenantId,
          channelAccountId: id,
          kind: 'app_secret',
          valor: datos.appSecret,
        });
      }
      await c.query(
        `UPDATE channel_accounts
            SET status = 'connected', last_synced_at = now(), updated_at = now(),
                webhook_subscribed = $2, provider_account_id = $3
          WHERE id = $1`,
        [id, suscrito, paginaId],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'canal.credenciales_renovadas', 'channel_account', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          id,
          JSON.stringify({ canal: cuenta.canal, appSecretTambien: Boolean(datos.appSecret) }),
        ],
      );
      return (await this.#leer(c, id))!;
    });
  }

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

  async #resolverInstagram(igUserId: string, accessToken: string): Promise<InstagramResuelto> {
    let paginas: Awaited<ReturnType<DescubridorDeMeta['instagram']>> = [];
    try {
      paginas = await this.#descubridor.instagram({ accessToken });
    } catch (error) {
      // Un token que no sirve para listar páginas puede servir para la cuenta
      // (token de Instagram, o de página sin permiso de lectura): lo decide el
      // verificador de abajo, que es el que ya se usaba.
      if (!(error instanceof ErrorDeNegocio) || error.codigo !== 'credenciales_rechazadas') {
        throw error;
      }
    }
    const pagina = paginas.find((p) => p.igUserId === igUserId);
    if (pagina) {
      const suscrito = await this.#descubridor.suscribirPagina(pagina);
      return {
        tokenAGuardar: pagina.tokenDePagina,
        paginaId: pagina.paginaId,
        nombre: pagina.usuario ?? pagina.pagina,
        suscrito,
      };
    }
    const identidad = await this.#verificarInstagram({ igUserId, accessToken });
    return {
      tokenAGuardar: accessToken,
      paginaId: null,
      nombre: identidad.nombreDeUsuario,
      suscrito: null,
    };
  }

  /** Ids externos ya conectados en ESTA cuenta (RLS): de otras no se sabe ni se dice. */
  async #conectadosAqui(canal: string): Promise<Set<string>> {
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ external_id: string }>(
        `SELECT external_id FROM channel_accounts WHERE channel = $1 AND status <> 'disconnected'`,
        [canal],
      );
      return new Set(rows.map((r) => r.external_id));
    });
  }

  async #leer(c: PoolClient, id: string): Promise<CuentaDeCanal | null> {
    const { rows } = await c.query<FilaCuenta>(
      `SELECT id, channel, external_id, provider_account_id, display_name, status,
              webhook_subscribed, last_event_at, created_at
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
  webhook_subscribed: boolean | null;
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
    webhookSuscrito: f.webhook_subscribed,
    lastEventAt: f.last_event_at,
    createdAt: f.created_at,
  };
}
