/**
 * Conectar con la app de Meta de la PLATAFORMA (ADR-015).
 *
 * Hasta aquí cada hotel traía su propia app de Meta y pegaba token y clave
 * secreta (ADR-004). Esto añade la otra forma, la de Kommo: un botón abre la
 * ventana de Meta, el dueño inicia sesión —o escanea un QR desde su WhatsApp
 * Business, que es la «coexistencia»— y Meta devuelve un **código** de un solo
 * uso. Aquí se cambia por un token.
 *
 * Solo endpoints documentados por Meta:
 *
 * - `GET /oauth/access_token?client_id&client_secret&code` — el código por un
 *   token de negocio. Sin `redirect_uri`: el código viene del SDK de JS.
 * - `GET /{phone-number-id}?fields=is_on_biz_app,platform_type` — si el número
 *   sigue además en la app del celular (coexistencia).
 * - `POST /{phone-number-id}/register` con `pin` — registrar en la Cloud API
 *   un número NUEVO. Uno en coexistencia ya está registrado y no se toca.
 * - `POST /{phone-number-id}/smb_app_data` con `sync_type` — pedir la agenda
 *   (`smb_app_state_sync`) y los chats (`history`) de la app del celular.
 *   Primero la agenda; cada una se puede pedir UNA vez, y dentro de las 24 h
 *   siguientes a conectar. Pasado ese plazo hay que desconectar y volver a
 *   conectar para tenerlos.
 *
 * ## La credencial sellada
 *
 * El alta tiene dos pasos —ver qué cuentas hay, elegir una— y el código de
 * Meta solo vale una vez. Entre un paso y otro el token tiene que estar en
 * algún sitio. No viaja en claro al navegador: se **sella** con la clave
 * maestra, atado a la cuenta que lo pidió y con caducidad corta. Lo que el
 * navegador guarda es un sobre que no puede abrir ni usar en otra cuenta, y
 * así no hace falta una tabla de sesiones a medio conectar.
 */
import type { Cifrador, SecretoCifrado } from '@crmapp/crypto';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface ConfigDeMeta {
  appId: string;
  appSecret: string;
  /** Configuración de Embedded Signup de WhatsApp (Facebook Login for Business). */
  configWhatsapp?: string | undefined;
  /** Configuración de inicio de sesión para páginas de Facebook e Instagram. */
  configPaginas?: string | undefined;
  graphVersion?: string | undefined;
}

/** Lo que la web necesita para abrir la ventana de Meta. Nunca la clave secreta. */
export interface PlataformaMetaVisible {
  disponible: boolean;
  appId: string | null;
  version: string;
  /** `null` = esa forma de conectar no está configurada. */
  configWhatsapp: string | null;
  configPaginas: string | null;
}

export interface ClienteDePlataformaMeta {
  /** El código de la ventana de Meta por un token. El código vale UNA vez. */
  intercambiarCodigo(code: string): Promise<string>;
  /** Si el número sigue además en la app WhatsApp Business del celular. */
  estaEnLaApp(p: { phoneNumberId: string; accessToken: string }): Promise<boolean>;
  /** Registra un número nuevo en la Cloud API. `false` si Meta no lo aceptó. */
  registrarNumero(p: { phoneNumberId: string; accessToken: string; pin: string }): Promise<boolean>;
  /**
   * Pide a Meta la agenda o los chats de la app del celular. Lo que llegue,
   * llega después y por webhook. `false` si Meta no aceptó la petición.
   */
  pedirSincronizacion(p: {
    phoneNumberId: string;
    accessToken: string;
    tipo: 'smb_app_state_sync' | 'history';
  }): Promise<boolean>;
}

const VERSION_POR_DEFECTO = 'v21.0';

export function plataformaVisible(config: ConfigDeMeta | null): PlataformaMetaVisible {
  return {
    disponible: config !== null,
    appId: config?.appId ?? null,
    version: config?.graphVersion ?? VERSION_POR_DEFECTO,
    configWhatsapp: config?.configWhatsapp ?? null,
    configPaginas: config?.configPaginas ?? null,
  };
}

export function clienteGraphDePlataforma(
  config: ConfigDeMeta,
  opciones: { fetch?: typeof fetch } = {},
): ClienteDePlataformaMeta {
  const f = opciones.fetch ?? globalThis.fetch;
  const base = `https://graph.facebook.com/${config.graphVersion ?? VERSION_POR_DEFECTO}`;

  const pedir = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return await f(url, init);
    } catch (error) {
      throw new ErrorDeNegocio(
        'proveedor_no_disponible',
        `No se pudo contactar con Meta: ${(error as Error).message}`,
        503,
      );
    }
  };

  return {
    async intercambiarCodigo(code) {
      const q = new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
      });
      const r = await pedir(`${base}/oauth/access_token?${q.toString()}`);
      const json = (await r.json().catch(() => ({}))) as { access_token?: string };
      if (!r.ok || !json.access_token) {
        // Lo normal: el código ya se usó o caducó (dura minutos). No se
        // reintenta: Meta no vuelve a aceptar el mismo.
        throw new ErrorDeNegocio(
          'codigo_de_meta_rechazado',
          'Meta no aceptó la conexión. Suele pasar si la ventana estuvo abierta mucho rato: vuelve a pulsar «Conectar».',
          422,
        );
      }
      return json.access_token;
    },

    async estaEnLaApp({ phoneNumberId, accessToken }) {
      const r = await pedir(`${base}/${phoneNumberId}?fields=is_on_biz_app,platform_type`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return false;
      const json = (await r.json().catch(() => ({}))) as { is_on_biz_app?: boolean };
      return json.is_on_biz_app === true;
    },

    async registrarNumero({ phoneNumberId, accessToken, pin }) {
      const r = await pedir(`${base}/${phoneNumberId}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      });
      if (!r.ok) return false;
      const json = (await r.json().catch(() => ({}))) as { success?: boolean };
      return json.success === true;
    },

    async pedirSincronizacion({ phoneNumberId, accessToken, tipo }) {
      const r = await pedir(`${base}/${phoneNumberId}/smb_app_data`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: tipo }),
      });
      return r.ok;
    },
  };
}

// ---------------------------------------------------------------------------
// Credencial sellada
// ---------------------------------------------------------------------------

/** Lo justo para elegir una cuenta de la lista; más sería dejar una llave por ahí. */
const MINUTOS_DE_VIDA = 15;

interface Sobre {
  /** Token de Meta. */
  t: string;
  /** Inquilino que lo pidió. Un sobre no sirve en otra cuenta. */
  i: string;
  /** Caducidad, en milisegundos. */
  e: number;
}

export function sellarCredencial(
  cifrador: Cifrador,
  p: { accessToken: string; tenantId: string; ahora: Date },
): string {
  const sobre: Sobre = {
    t: p.accessToken,
    i: p.tenantId,
    e: p.ahora.getTime() + MINUTOS_DE_VIDA * 60_000,
  };
  const s = cifrador.cifrar(JSON.stringify(sobre));
  return Buffer.from(
    JSON.stringify({
      c: s.ciphertext.toString('base64'),
      d: s.dekWrapped.toString('base64'),
      v: s.keyVersion,
    }),
  ).toString('base64url');
}

/** Abre el sobre. Cualquier cosa rara —manipulado, de otra cuenta, caducado— es el mismo error. */
export function abrirCredencial(
  cifrador: Cifrador,
  p: { credencial: string; tenantId: string; ahora: Date },
): string {
  const caducada = () =>
    new ErrorDeNegocio(
      'conexion_caducada',
      'La conexión con Meta caducó. Vuelve a pulsar «Conectar».',
      422,
    );
  let sobre: Sobre;
  try {
    const crudo = JSON.parse(Buffer.from(p.credencial, 'base64url').toString('utf8')) as {
      c: string;
      d: string;
      v: number;
    };
    const secreto: SecretoCifrado = {
      ciphertext: Buffer.from(crudo.c, 'base64'),
      dekWrapped: Buffer.from(crudo.d, 'base64'),
      keyVersion: crudo.v,
    };
    sobre = JSON.parse(cifrador.descifrarTexto(secreto)) as Sobre;
  } catch {
    throw caducada();
  }
  if (sobre.i !== p.tenantId || sobre.e < p.ahora.getTime() || !sobre.t) throw caducada();
  return sobre.t;
}

/** PIN de seis cifras para registrar un número nuevo. Aleatorio de verdad, no `Math.random`. */
export function generarPin(aleatorio: (max: number) => number): string {
  return String(aleatorio(1_000_000)).padStart(6, '0');
}
