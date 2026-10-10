/**
 * Conexión BYO de canales (ADR-004): el cliente trae su propia cuenta de
 * WhatsApp Cloud API y pega aquí sus credenciales.
 *
 * Es el único sitio del sistema donde un token de canal existe en claro más
 * allá de una variable local: entra por la petición, se verifica contra Meta
 * y se guarda cifrado. No se devuelve nunca, ni en la respuesta de alta ni en
 * el listado. Si el cliente lo pierde, lo vuelve a pegar.
 *
 * Desde ADR-015 hay otra forma, que convive con esta: conectar con la app de
 * Meta de la plataforma —inicio de sesión, o el QR de WhatsApp Business—. El
 * alta es la MISMA; lo que cambia es de dónde salen el token y la clave. Ver
 * `plataforma-meta.ts`.
 */
import type { PoolClient } from 'pg';
import type { Cifrador } from '@crmapp/crypto';
import {
  borrarSecretosDeCanal,
  crearResolverDeCredencialesFacebook,
  crearResolverDeCredencialesInstagram,
  crearResolverDeCredencialesWhatsapp,
  crearResolverDeCuenta,
  guardarSecretoDeCanal,
  topeDelPlan,
} from '@crmapp/db';
import { cabeUnoMas } from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { randomInt } from 'node:crypto';
import {
  abrirCredencial,
  clienteGraphDePlataforma,
  generarPin,
  plataformaVisible,
  sellarCredencial,
  type ClienteDePlataformaMeta,
  type ConfigDeMeta,
  type PlataformaMetaVisible,
} from './plataforma-meta.js';
import {
  CAMPOS_DE_WEBHOOK,
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

export interface PaginaDeFacebookVisible {
  paginaId: string;
  pagina: string;
  yaConectado: boolean;
}

/**
 * De dónde salen el token y la clave secreta. O los pega el cliente (ADR-004),
 * o trae la `credencial` sellada que le dio «Conectar con Meta» (ADR-015) y
 * la clave es la de la app de la plataforma. Una de las dos formas.
 */
export interface OrigenDeCredenciales {
  accessToken?: string | undefined;
  appSecret?: string | undefined;
  credencial?: string | undefined;
}

export interface CredencialesDeAlta extends OrigenDeCredenciales {
  phoneNumberId: string;
  wabaId: string;
  displayName?: string | undefined;
}

export interface CredencialesDeAltaInstagram extends OrigenDeCredenciales {
  /** Id de la cuenta profesional de Instagram (IG User). */
  igUserId: string;
  displayName?: string | undefined;
}

export interface CredencialesDeAltaFacebook extends OrigenDeCredenciales {
  /** Id de la página, elegida de la lista que trae Meta. */
  paginaId: string;
  displayName?: string | undefined;
}

export type VerificadorDeInstagram = (cred: {
  igUserId: string;
  accessToken: string;
}) => Promise<{ nombreDeUsuario: string }>;

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
export type VerificadorDeCredenciales = (cred: {
  phoneNumberId: string;
  accessToken: string;
}) => Promise<IdentidadVerificada>;

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
  /** `credenciales` pegadas (ADR-004) o `plataforma`, con un botón (ADR-015). */
  conectadoVia: 'credenciales' | 'plataforma';
  lastEventAt: Date | null;
  createdAt: Date;
}

/**
 * Un WhatsApp recién conectado. Con coexistencia dice además si se pidió el
 * historial: lo que el dueño compartió desde su celular llega después, por
 * tandas, y la pantalla tiene que avisarlo en vez de parecer vacía.
 */
export interface WhatsappConectado extends CuentaDeCanal {
  /** `null` si no es coexistencia; `false` si Meta no aceptó la petición. */
  historialPedido: boolean | null;
}

/** Lo que devuelve «Conectar con Meta» para WhatsApp: los números y el sobre. */
export interface SesionDeWhatsapp extends DescubrimientoWhatsappVisible {
  credencial: string;
}

/** Y para páginas: las de Facebook, las cuentas de Instagram, y el sobre. */
export interface SesionDePaginas {
  credencial: string;
  facebook: PaginaDeFacebookVisible[];
  instagram: CuentaDeInstagramVisible[];
}

export interface OpcionesDeCanales {
  db: BaseDeDatos;
  cifrador: Cifrador;
  verificar: VerificadorDeCredenciales;
  verificarInstagram?: VerificadorDeInstagram;
  suscribir?: SuscriptorDeWebhook;
  descubridor?: DescubridorDeMeta;
  /** La app de Meta de la plataforma. Sin ella no hay «Conectar con Meta». */
  meta?: ConfigDeMeta | undefined;
  plataformaMeta?: ClienteDePlataformaMeta | undefined;
  ahora?: () => Date;
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
  readonly #meta: ConfigDeMeta | null;
  readonly #plataforma: ClienteDePlataformaMeta | null;
  readonly #ahora: () => Date;

  constructor(o: OpcionesDeCanales) {
    this.#db = o.db;
    this.#cifrador = o.cifrador;
    this.#verificar = o.verificar;
    this.#verificarInstagram = o.verificarInstagram ?? verificadorGraphInstagram();
    this.#suscribir = o.suscribir ?? suscriptorGraph();
    this.#descubridor = o.descubridor ?? descubridorGraph();
    this.#meta = o.meta ?? null;
    this.#plataforma = o.plataformaMeta ?? (o.meta ? clienteGraphDePlataforma(o.meta) : null);
    this.#ahora = o.ahora ?? (() => new Date());
    this.resolverCuenta = crearResolverDeCuenta(o.db.poolAuth, o.cifrador);
    this.resolverCredencialesWhatsapp = crearResolverDeCredencialesWhatsapp(
      o.db.poolAuth,
      o.cifrador,
    );
    this.resolverCredencialesInstagram = crearResolverDeCredencialesInstagram(
      o.db.poolAuth,
      o.cifrador,
    );
    this.resolverCredencialesFacebook = crearResolverDeCredencialesFacebook(
      o.db.poolAuth,
      o.cifrador,
    );
  }

  // -------------------------------------------------------------------------
  // Conectar con la app de Meta de la plataforma (ADR-015)
  // -------------------------------------------------------------------------

  /** Lo que la pantalla necesita para abrir la ventana de Meta. Sin secretos. */
  plataforma(): PlataformaMetaVisible {
    this.#exigirContexto();
    return plataformaVisible(this.#meta);
  }

  /**
   * Vuelta de la ventana de Meta para WhatsApp (Embedded Signup, que incluye
   * el QR de coexistencia). Cambia el código por un token y enseña los números
   * de la cuenta que el dueño acaba de compartir. No guarda nada todavía.
   *
   * El cupo se mira ANTES de gastar el código: vale una sola vez, y gastarlo
   * para decir «no cabe» obligaría al dueño a repetir el QR.
   */
  async sesionDeWhatsapp(p: { code: string; wabaId: string }): Promise<SesionDeWhatsapp> {
    const ctx = this.#exigirAdmin();
    const plataforma = this.#exigirPlataforma();
    await this.#db.enTransaccion((c) => this.#exigirCupoDeCanal(c, ctx.tenantId));
    const accessToken = await plataforma.intercambiarCodigo(p.code);
    const d = await this.#descubridor.whatsapp({ accessToken, wabaId: p.wabaId });
    const conectados = await this.#conectadosAqui('whatsapp');
    return {
      ...d,
      cuentas: d.cuentas.map((w) => ({
        ...w,
        numeros: w.numeros.map((n) => ({ ...n, yaConectado: conectados.has(n.phoneNumberId) })),
      })),
      credencial: this.#sellar(ctx.tenantId, accessToken),
    };
  }

  /** Lo mismo para páginas: las de Facebook y las cuentas de Instagram que ve. */
  async sesionDePaginas(p: { code: string }): Promise<SesionDePaginas> {
    const ctx = this.#exigirAdmin();
    const plataforma = this.#exigirPlataforma();
    await this.#db.enTransaccion((c) => this.#exigirCupoDeCanal(c, ctx.tenantId));
    const accessToken = await plataforma.intercambiarCodigo(p.code);
    const paginas = await this.#descubridor.paginas({ accessToken });
    const [enFacebook, enInstagram] = await Promise.all([
      this.#conectadosAqui('facebook'),
      this.#conectadosAqui('instagram'),
    ]);
    return {
      credencial: this.#sellar(ctx.tenantId, accessToken),
      facebook: paginas.map((pg) => ({
        paginaId: pg.paginaId,
        pagina: pg.pagina,
        yaConectado: enFacebook.has(pg.paginaId),
      })),
      instagram: paginas
        .filter((pg) => pg.igUserId !== null)
        .map((pg) => ({
          igUserId: pg.igUserId!,
          usuario: pg.usuario,
          paginaId: pg.paginaId,
          pagina: pg.pagina,
          yaConectado: enInstagram.has(pg.igUserId!),
        })),
    };
  }

  #sellar(tenantId: string, accessToken: string): string {
    return sellarCredencial(this.#cifrador, { accessToken, tenantId, ahora: this.#ahora() });
  }

  #exigirPlataforma(): ClienteDePlataformaMeta {
    if (!this.#meta || !this.#plataforma) {
      throw new ErrorDeNegocio(
        'plataforma_no_configurada',
        '«Conectar con Meta» no está disponible todavía. Conecta pegando tus credenciales.',
        503,
      );
    }
    return this.#plataforma;
  }

  /**
   * El token y la clave secreta con que se da de alta, vengan de donde vengan.
   *
   * Con `credencial`, la clave es la de la app de la plataforma: los webhooks
   * de ese canal los firma esa app, no una del cliente.
   */
  #origen(
    tenantId: string,
    cred: OrigenDeCredenciales,
  ): { accessToken: string; appSecret: string; via: 'credenciales' | 'plataforma' } {
    if (cred.credencial) {
      this.#exigirPlataforma();
      return {
        accessToken: abrirCredencial(this.#cifrador, {
          credencial: cred.credencial,
          tenantId,
          ahora: this.#ahora(),
        }),
        appSecret: this.#meta!.appSecret,
        via: 'plataforma',
      };
    }
    if (!cred.accessToken || !cred.appSecret) {
      throw new ErrorDeNegocio('datos_invalidos', 'Faltan el token y la clave secreta.', 400);
    }
    return { accessToken: cred.accessToken, appSecret: cred.appSecret, via: 'credenciales' };
  }

  async #marcarVia(c: PoolClient, id: string, via: 'credenciales' | 'plataforma'): Promise<void> {
    if (via === 'credenciales') return; // es el valor por defecto de la columna
    await c.query(`UPDATE channel_accounts SET connected_via = 'plataforma' WHERE id = $1`, [id]);
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

  /** Páginas de Facebook que ve el token, sin tokens de página. */
  async descubrirFacebook(p: { accessToken: string }): Promise<PaginaDeFacebookVisible[]> {
    this.#exigirAdmin();
    const paginas = await this.#descubridor.paginas(p);
    const conectadas = await this.#conectadosAqui('facebook');
    return paginas.map((pg) => ({
      paginaId: pg.paginaId,
      pagina: pg.pagina,
      yaConectado: conectadas.has(pg.paginaId),
    }));
  }

  /**
   * Conexión de una página de Facebook: Messenger y comentarios. Se guarda el
   * token de PÁGINA y se suscribe la página a `messages` y `feed`.
   */
  async conectarFacebook(cred: CredencialesDeAltaFacebook): Promise<CuentaDeCanal> {
    const ctx = this.#exigirAdmin();
    // Antes de hablar con Meta: si no cabe, no tiene sentido verificar nada.
    await this.#db.enTransaccion((c) => this.#exigirCupoDeCanal(c, ctx.tenantId));
    const origen = this.#origen(ctx.tenantId, cred);
    const r = await this.#resolverFacebook(cred.paginaId, origen.accessToken);

    return this.#db.enTransaccion(async (c) => {
      // Otra vez dentro: entre la comprobación de arriba y esta, otra
      // pestaña ha podido conectar el canal que llenaba el cupo.
      await this.#exigirCupoDeCanal(c, ctx.tenantId);
      const id = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO channel_accounts
             (id, tenant_id, channel, external_id, display_name, status, last_synced_at,
              webhook_subscribed)
           VALUES ($1, $2, 'facebook', $3, $4, 'connected', now(), $5)`,
          [id, ctx.tenantId, cred.paginaId, cred.displayName ?? r.nombre, r.suscrito],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'numero_ya_conectado',
            'Esa página de Facebook ya está conectada a una cuenta.',
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
        valor: origen.appSecret,
      });
      await this.#marcarVia(c, id, origen.via);
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'canal.conectado', 'channel_account', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          id,
          JSON.stringify({ canal: 'facebook', pagina: r.nombre, webhookSuscrito: r.suscrito }),
        ],
      );
      return (await this.#leer(c, id))!;
    });
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
    // Antes de hablar con Meta: si no cabe, no tiene sentido verificar nada.
    await this.#db.enTransaccion((c) => this.#exigirCupoDeCanal(c, ctx.tenantId));
    const origen = this.#origen(ctx.tenantId, cred);
    const r = await this.#resolverInstagram(cred.igUserId, origen.accessToken);

    return this.#db.enTransaccion(async (c) => {
      // Otra vez dentro: entre la comprobación de arriba y esta, otra
      // pestaña ha podido conectar el canal que llenaba el cupo.
      await this.#exigirCupoDeCanal(c, ctx.tenantId);
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
        valor: origen.appSecret,
      });
      await this.#marcarVia(c, id, origen.via);
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

  async conectarWhatsapp(cred: CredencialesDeAlta): Promise<WhatsappConectado> {
    const ctx = this.#exigirAdmin();
    // Antes de verificar y de suscribir la WABA: si no cabe, no se toca Meta.
    await this.#db.enTransaccion((c) => this.#exigirCupoDeCanal(c, ctx.tenantId));

    // Verificar ANTES de abrir la transacción: es una llamada de red y no debe
    // retener conexión ni bloqueos mientras Meta responde.
    const origen = this.#origen(ctx.tenantId, cred);
    const identidad = await this.#verificar({
      phoneNumberId: cred.phoneNumberId,
      accessToken: origen.accessToken,
    });

    // Y suscribir la WABA a nuestra app, o el número quedaría conectado y
    // sordo. No aborta si falla: se guarda el estado y se avisa.
    const suscrito = await this.#suscribir({
      providerAccountId: cred.wabaId,
      accessToken: origen.accessToken,
    });

    // Con la app de la plataforma, el número puede venir de dos sitios:
    //
    // - **Coexistencia**: sigue en el WhatsApp Business del celular (el QR).
    //   Ya está registrado; registrarlo otra vez lo sacaría de la app.
    // - **Número nuevo** dado de alta en la ventana de Meta: hay que
    //   registrarlo en la Cloud API con un PIN, o no envía ni recibe.
    //
    // Se le pregunta a Meta cuál es, no al navegador. Si el registro falla el
    // canal se conecta igual y queda dicho: es mejor verlo conectado con un
    // aviso que repetir el alta sin saber qué pasó.
    let coexistencia: boolean | null = null;
    let pin: string | null = null;
    let registrado: boolean | null = null;
    if (origen.via === 'plataforma') {
      const plataforma = this.#exigirPlataforma();
      const destino = { phoneNumberId: cred.phoneNumberId, accessToken: origen.accessToken };
      coexistencia = await plataforma.estaEnLaApp(destino);
      if (!coexistencia) {
        pin = generarPin(randomInt);
        registrado = await plataforma.registrarNumero({ ...destino, pin });
      }
    }

    const cuenta = await this.#db.enTransaccion(async (c) => {
      // Otra vez dentro: entre la comprobación de arriba y esta, otra
      // pestaña ha podido conectar el canal que llenaba el cupo.
      await this.#exigirCupoDeCanal(c, ctx.tenantId);
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
        valor: origen.accessToken,
      });
      await guardarSecretoDeCanal(c, this.#cifrador, {
        tenantId: ctx.tenantId,
        channelAccountId: id,
        kind: 'app_secret',
        valor: origen.appSecret,
      });
      await this.#marcarVia(c, id, origen.via);
      // El PIN solo si Meta lo aceptó: guardar uno que no vale confundiría a
      // quien tenga que volver a registrar el número.
      if (pin && registrado) {
        await guardarSecretoDeCanal(c, this.#cifrador, {
          tenantId: ctx.tenantId,
          channelAccountId: id,
          kind: 'pin',
          valor: pin,
        });
      }

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
            via: origen.via,
            // Solo con la plataforma: si comparte número con la app del
            // celular, y si hubo que registrarlo. Nunca el PIN.
            ...(origen.via === 'plataforma' ? { coexistencia, registrado } : {}),
          }),
        ],
      );

      return (await this.#leer(c, id))!;
    });

    // Coexistencia: pedir la agenda y los chats que el dueño compartió desde
    // su celular. DESPUÉS de confirmar la transacción: lo que Meta mande
    // llega por webhook, y el webhook tiene que encontrar ya la cuenta.
    //
    // Primero la agenda —Meta lo exige, y así los chats llegan con nombre—.
    // Cada cosa se puede pedir una sola vez: si falla no se reintenta a
    // ciegas, se dice, y el canal queda conectado igual.
    let historialPedido: boolean | null = null;
    if (coexistencia) {
      const plataforma = this.#exigirPlataforma();
      const destino = { phoneNumberId: cred.phoneNumberId, accessToken: origen.accessToken };
      const agenda = await plataforma.pedirSincronizacion({
        ...destino,
        tipo: 'smb_app_state_sync',
      });
      historialPedido =
        agenda && (await plataforma.pedirSincronizacion({ ...destino, tipo: 'history' }));
      await this.#db.enTransaccion((c) =>
        c.query(
          `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
           VALUES ($1, $2, 'canal.historial_pedido', 'channel_account', $3, $4)`,
          [
            ctx.tenantId,
            ctx.userId,
            cuenta.id,
            JSON.stringify({ agenda, historial: historialPedido }),
          ],
        ),
      );
    }
    return { ...cuenta, historialPedido };
  }

  async listar(): Promise<CuentaDeCanal[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<FilaCuenta>(
        `SELECT id, channel, external_id, provider_account_id, display_name, status,
                webhook_subscribed, connected_via, last_event_at, created_at
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
    } else if (cuenta.canal === 'facebook') {
      const r = await this.#resolverFacebook(cuenta.externalId, datos.accessToken);
      tokenAGuardar = r.tokenAGuardar;
      suscrito = r.suscrito;
    } else {
      throw new ErrorDeNegocio(
        'canal_no_soportado',
        `No se sabe verificar credenciales de "${cuenta.canal}".`,
        422,
      );
    }

    return this.#db.enTransaccion(async (c) => {
      // Renovar una cuenta desconectada la vuelve a conectar, y entonces
      // ocupa plaza. Sin esto el tope se salta: conectar uno, desconectarlo,
      // conectar otro y renovar el primero.
      if (cuenta.status === 'disconnected') await this.#exigirCupoDeCanal(c, ctx.tenantId);
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
      // La agenda de la app del celular (0055) se va con la conexión: era
      // para nombrar a quien escribe por este canal, y ya no escribe nadie.
      await c.query(`DELETE FROM channel_contact_names WHERE channel_account_id = $1`, [id]);
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
  readonly resolverCredencialesFacebook: ReturnType<typeof crearResolverDeCredencialesFacebook>;

  /**
   * ¿Cabe un canal conectado más en el plan?
   *
   * Cuentan solo los que no están desconectados: desconectar deja la fila
   * —para no perder sus conversaciones— y tiene que liberar la plaza.
   *
   * El cerrojo de asesoría serializa a dos conexiones simultáneas de la misma
   * cuenta; sin él las dos ven «cabe uno» y entran las dos. Se usa uno de
   * asesoría y no `FOR UPDATE` porque el rol de la aplicación no puede
   * actualizar `subscriptions`, y no debe poder.
   */
  async #exigirCupoDeCanal(c: PoolClient, tenantId: string): Promise<void> {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('cupo-de-canales:' || $1))`, [tenantId]);
    const tope = await topeDelPlan(c, tenantId, 'canales');
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM channel_accounts
        WHERE tenant_id = $1 AND status <> 'disconnected'`,
      [tenantId],
    );
    const conectados = Number(rows[0]?.n ?? 0);
    if (!cabeUnoMas(conectados, tope)) {
      throw new ErrorDeNegocio(
        'limite_de_canales',
        `Tu plan incluye ${tope} ${tope === 1 ? 'canal' : 'canales'} y ya ${tope === 1 ? 'está conectado' : 'están conectados'}. Desconecta uno o sube de plan.`,
        402,
        { tope, conectados },
      );
    }
  }

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
      const suscrito = await this.#descubridor.suscribirPagina({
        ...pagina,
        campos: await this.#camposDePagina(pagina.paginaId, 'instagram'),
      });
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

  /**
   * Página de Facebook que ve el token. Con token de usuario se cambia por el
   * de la página; si ya era de página, `/me` es la página y vale tal cual.
   * A diferencia de Instagram no hay verificador de repuesto: si el token no
   * ve la página, no hay con qué enviar.
   */
  async #resolverFacebook(paginaId: string, accessToken: string) {
    const pagina = (await this.#descubridor.paginas({ accessToken })).find(
      (p) => p.paginaId === paginaId,
    );
    if (!pagina) {
      throw new ErrorDeNegocio(
        'credenciales_rechazadas',
        'Ese token no ve la página elegida. Revisa que tu usuario la administre y que el token tenga pages_messaging.',
        422,
      );
    }
    const suscrito = await this.#descubridor.suscribirPagina({
      ...pagina,
      campos: await this.#camposDePagina(pagina.paginaId, 'facebook'),
    });
    return { tokenAGuardar: pagina.tokenDePagina, nombre: pagina.pagina, suscrito };
  }

  /**
   * Campos de webhook que necesita la página: los del canal que se conecta MÁS
   * los de cualquier otro canal de esta cuenta que ya cuelgue de ella. Meta
   * reemplaza la lista en cada suscripción; conectar Facebook después de
   * Instagram con solo `messages,feed` dejaría de recibir los comentarios de
   * Instagram sin ningún error.
   */
  async #camposDePagina(paginaId: string, canal: 'instagram' | 'facebook'): Promise<string[]> {
    const otros = await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ channel: 'instagram' | 'facebook' }>(
        `SELECT DISTINCT channel FROM channel_accounts
          WHERE status <> 'disconnected'
            AND ((channel = 'instagram' AND provider_account_id = $1)
              OR (channel = 'facebook' AND external_id = $1))`,
        [paginaId],
      );
      return rows.map((r) => r.channel);
    });
    return [...new Set([canal, ...otros].flatMap((k) => [...CAMPOS_DE_WEBHOOK[k]]))];
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
              webhook_subscribed, connected_via, last_event_at, created_at
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
  connected_via: 'credenciales' | 'plataforma';
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
    conectadoVia: f.connected_via,
    lastEventAt: f.last_event_at,
    createdAt: f.created_at,
  };
}
