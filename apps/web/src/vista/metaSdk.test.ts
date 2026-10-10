/**
 * La ventana de Meta (ADR-015). Se prueba lo que no se ve hasta producción:
 * que el código y la cuenta llegan por caminos distintos y en cualquier orden,
 * que un mensaje de otro origen no cuela una cuenta falsa, y que cerrar la
 * ventana no es un error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirVentanaDeMeta } from './metaSdk.ts';

type Callback = (r: { authResponse?: { code?: string } | null }) => void;

function conSdk() {
  let callback: Callback = () => undefined;
  const login = vi.fn((cb: Callback, _opciones: unknown) => {
    callback = cb;
  });
  window.FB = { init: vi.fn(), login } as unknown as NonNullable<Window['FB']>;
  return {
    login,
    responder: (code?: string) => callback({ authResponse: code ? { code } : null }),
  };
}

const mensaje = (data: unknown, origin = 'https://www.facebook.com') =>
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin }));

const finDeCoexistencia = (extra: Record<string, unknown> = {}) => ({
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  data: { waba_id: 'WABA-1', ...extra },
  version: 3,
});

afterEach(() => {
  delete window.FB;
  vi.useRealTimers();
});

describe('abrirVentanaDeMeta', () => {
  it('pide coexistencia a Meta: es lo que enseña el código QR', () => {
    const { login } = conSdk();
    void abrirVentanaDeMeta({ configId: 'CFG-WA', whatsapp: true });
    expect(login.mock.calls[0]![1]).toEqual({
      config_id: 'CFG-WA',
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' },
    });
  });

  it('para páginas no manda nada de WhatsApp', () => {
    const { login } = conSdk();
    void abrirVentanaDeMeta({ configId: 'CFG-PG', whatsapp: false });
    expect(login.mock.calls[0]![1]).not.toHaveProperty('extras');
  });

  it('junta el código y la cuenta, lleguen en el orden que lleguen', async () => {
    const a = conSdk();
    const primeroElMensaje = abrirVentanaDeMeta({ configId: 'C', whatsapp: true });
    mensaje(finDeCoexistencia({ phone_number_id: 'PN-1' }));
    a.responder('CODIGO-1');
    expect(await primeroElMensaje).toEqual({
      code: 'CODIGO-1',
      wabaId: 'WABA-1',
      phoneNumberId: 'PN-1',
    });

    const b = conSdk();
    const primeroElCodigo = abrirVentanaDeMeta({ configId: 'C', whatsapp: true });
    b.responder('CODIGO-2');
    mensaje(finDeCoexistencia());
    // En coexistencia Meta puede no decir el número: se busca después.
    expect(await primeroElCodigo).toEqual({
      code: 'CODIGO-2',
      wabaId: 'WABA-1',
      phoneNumberId: null,
    });
  });

  it('cerrar la ventana sin terminar no es un error: devuelve null', async () => {
    const { responder } = conSdk();
    const r = abrirVentanaDeMeta({ configId: 'C', whatsapp: true });
    responder();
    expect(await r).toBeNull();
  });

  it('si Meta avisa de que se canceló, el código que llegue no vale', async () => {
    const { responder } = conSdk();
    const r = abrirVentanaDeMeta({ configId: 'C', whatsapp: true });
    mensaje({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE' } });
    responder('CODIGO');
    expect(await r).toBeNull();
  });

  it('un mensaje de otro sitio no cuela una cuenta', async () => {
    vi.useFakeTimers();
    const { responder } = conSdk();
    const r = abrirVentanaDeMeta({ configId: 'C', whatsapp: true });
    mensaje(finDeCoexistencia({ waba_id: 'WABA-DE-OTRO' }), 'https://sitio-malicioso.example');
    responder('CODIGO');
    await vi.advanceTimersByTimeAsync(5000);
    // Llega el código, pero sin cuenta: la pantalla pedirá repetir.
    expect(await r).toEqual({ code: 'CODIGO', wabaId: null, phoneNumberId: null });
  });

  it('en páginas no espera ningún mensaje: con el código basta', async () => {
    const { responder } = conSdk();
    const r = abrirVentanaDeMeta({ configId: 'C', whatsapp: false });
    responder('CODIGO-PG');
    expect(await r).toEqual({ code: 'CODIGO-PG', wabaId: null, phoneNumberId: null });
  });

  it('sin el SDK cargado se dice, en vez de abrir una ventana que el navegador bloquearía', async () => {
    await expect(abrirVentanaDeMeta({ configId: 'C', whatsapp: true })).rejects.toThrow(
      /no ha cargado/,
    );
  });
});
