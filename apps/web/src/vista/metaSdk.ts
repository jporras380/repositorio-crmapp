/**
 * La ventana de Meta para «Conectar con Meta» (ADR-015).
 *
 * Es el SDK de JavaScript de Facebook, cargado solo cuando alguien abre la
 * pantalla de conectar un canal: es un script de terceros, y no tiene por qué
 * viajar con cada visita a la bandeja.
 *
 * ## Dos señales, no una
 *
 * Al terminar, Meta avisa por dos caminos distintos y hacen falta los dos:
 *
 * 1. El **callback** de `FB.login` trae el `code`, que el servidor cambia por
 *    un token. Vale una sola vez y dura minutos.
 * 2. Un **mensaje** `WA_EMBEDDED_SIGNUP` a la ventana trae QUÉ se compartió:
 *    la cuenta de WhatsApp y, a veces, el número. El `code` no lo dice.
 *
 * Pueden llegar en cualquier orden, así que se espera un momento al segundo.
 *
 * ## El clic
 *
 * `FB.login` tiene que llamarse EN el clic, sin ningún `await` antes: si no,
 * el navegador trata la ventana como emergente no pedida y la bloquea. Por eso
 * el SDK se carga al abrir la pantalla y `abrirVentanaDeMeta` es síncrona
 * hasta que llama a Meta.
 */

interface RespuestaDeLogin {
  authResponse?: { code?: string } | null;
}

interface SdkDeFacebook {
  init(opciones: {
    appId: string;
    version: string;
    xfbml: boolean;
    autoLogAppEvents: boolean;
  }): void;
  login(
    alTerminar: (r: RespuestaDeLogin) => void,
    opciones: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras?: Record<string, unknown>;
    },
  ): void;
}

declare global {
  interface Window {
    FB?: SdkDeFacebook;
    fbAsyncInit?: () => void;
  }
}

export interface ResultadoDeMeta {
  code: string;
  /** Solo en WhatsApp: la cuenta que el dueño compartió. */
  wabaId: string | null;
  phoneNumberId: string | null;
}

let cargando: Promise<void> | null = null;

/** Carga el SDK una vez. Se puede llamar las veces que haga falta. */
export function cargarSdkDeMeta(appId: string, version: string): Promise<void> {
  if (window.FB) return Promise.resolve();
  cargando ??= new Promise<void>((ok, mal) => {
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, version, xfbml: false, autoLogAppEvents: false });
      ok();
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/es_LA/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      cargando = null; // que se pueda reintentar
      mal(new Error('No se pudo cargar la ventana de Meta.'));
    };
    document.head.append(script);
  });
  return cargando;
}

/** Cuánto se espera al mensaje de Meta después del callback, o al revés. */
const ESPERA_MS = 4000;

const ORIGENES = new Set(['https://www.facebook.com', 'https://web.facebook.com']);

/**
 * Abre la ventana de Meta. **Llamar directamente desde el `onClick`.**
 *
 * Devuelve `null` si la persona cerró la ventana sin terminar.
 *
 * `coexistencia` pide a Meta que ofrezca conectar un número que ya está en la
 * app WhatsApp Business del celular: es lo que enseña el código QR.
 */
export function abrirVentanaDeMeta(p: {
  configId: string;
  whatsapp: boolean;
}): Promise<ResultadoDeMeta | null> {
  const sdk = window.FB;
  if (!sdk) return Promise.reject(new Error('La ventana de Meta todavía no ha cargado.'));

  return new Promise((ok) => {
    let code: string | null | undefined; // undefined = el callback aún no llegó
    let wabaId: string | null = null;
    let phoneNumberId: string | null = null;
    let cancelado = false;
    let temporizador: ReturnType<typeof setTimeout> | null = null;

    const terminar = () => {
      window.removeEventListener('message', alMensaje);
      if (temporizador) clearTimeout(temporizador);
      ok(code && !cancelado ? { code, wabaId, phoneNumberId } : null);
    };
    const comprobar = () => {
      if (code === undefined) return; // falta el callback
      if (!code || cancelado) return terminar();
      // En páginas no hay mensaje que esperar; en WhatsApp sí, y sin la
      // cuenta no se puede seguir, pero tampoco se espera para siempre.
      if (!p.whatsapp || wabaId) return terminar();
      temporizador ??= setTimeout(terminar, ESPERA_MS);
    };

    function alMensaje(evento: MessageEvent) {
      if (!ORIGENES.has(evento.origin)) return;
      let datos: { type?: string; event?: string; data?: Record<string, unknown> };
      try {
        datos = typeof evento.data === 'string' ? JSON.parse(evento.data) : evento.data;
      } catch {
        return;
      }
      if (datos?.type !== 'WA_EMBEDDED_SIGNUP') return;
      const nombre = String(datos.event ?? '').toUpperCase();
      if (nombre === 'CANCEL' || nombre === 'ERROR') cancelado = true;
      const id = (v: unknown) => (typeof v === 'string' && v ? v : null);
      wabaId = id(datos.data?.['waba_id']) ?? wabaId;
      phoneNumberId = id(datos.data?.['phone_number_id']) ?? phoneNumberId;
      comprobar();
    }
    window.addEventListener('message', alMensaje);

    sdk.login(
      (r) => {
        code = r.authResponse?.code ?? null;
        comprobar();
      },
      {
        config_id: p.configId,
        response_type: 'code',
        override_default_response_type: true,
        ...(p.whatsapp
          ? { extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' } }
          : {}),
      },
    );
  });
}
