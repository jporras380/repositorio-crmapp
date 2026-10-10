/**
 * La app de Meta de la plataforma (ADR-015), sin red y sin base.
 *
 * Dos cosas que un test de API no puede ver bien: que el sobre caduca —el
 * reloj de la API no se inyecta por HTTP—, y la FORMA exacta de lo que se le
 * pide a Meta, que es donde un parámetro de más o de menos falla en producción
 * con un error que no dice cuál.
 */
import { describe, expect, it } from 'vitest';
import { Cifrador, generarClaveMaestra, parsearClaveMaestra } from '@crmapp/crypto';
import {
  abrirCredencial,
  clienteGraphDePlataforma,
  generarPin,
  plataformaVisible,
  sellarCredencial,
} from '../src/canales/plataforma-meta.js';

const cifrador = new Cifrador({
  claves: { 1: parsearClaveMaestra(generarClaveMaestra()) },
  versionActual: 1,
});
const T0 = new Date('2026-10-10T15:00:00Z');
const minutos = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('la credencial sellada', () => {
  const sobre = () =>
    sellarCredencial(cifrador, { accessToken: 'EAAG-token-de-meta', tenantId: 't-1', ahora: T0 });

  it('quien la selló la abre, y saca el token', () => {
    expect(abrirCredencial(cifrador, { credencial: sobre(), tenantId: 't-1', ahora: T0 })).toBe(
      'EAAG-token-de-meta',
    );
  });

  it('no lleva el token en claro, ni decodificada', () => {
    expect(Buffer.from(sobre(), 'base64url').toString('utf8')).not.toContain('EAAG');
  });

  it('caduca a los quince minutos: lo justo para elegir una cuenta de la lista', () => {
    const abrir = (ahora: Date) => () =>
      abrirCredencial(cifrador, { credencial: sobre(), tenantId: 't-1', ahora });
    expect(abrir(minutos(14))).not.toThrow();
    expect(abrir(minutos(16))).toThrow(/caducó/);
  });

  it('no vale en otra cuenta, ni manipulada, ni si es cualquier cosa', () => {
    const abrir =
      (credencial: string, tenantId = 't-1') =>
      () =>
        abrirCredencial(cifrador, { credencial, tenantId, ahora: T0 });
    expect(abrir(sobre(), 't-2')).toThrow(/caducó/);
    expect(abrir('AAAAAA' + sobre().slice(6))).toThrow(/caducó/);
    expect(abrir('esto-no-es-un-sobre')).toThrow(/caducó/);
  });

  it('otra clave maestra no la abre', () => {
    const otro = new Cifrador({
      claves: { 1: parsearClaveMaestra(generarClaveMaestra()) },
      versionActual: 1,
    });
    expect(() =>
      abrirCredencial(otro, { credencial: sobre(), tenantId: 't-1', ahora: T0 }),
    ).toThrow(/caducó/);
  });
});

describe('lo que se le pide a Meta', () => {
  const config = { appId: 'APP1', appSecret: 'SECRETO', graphVersion: 'v25.0' };
  const conRespuesta = (status: number, json: unknown) => {
    const peticiones: { url: string; init: RequestInit | undefined }[] = [];
    const f: typeof fetch = async (entrada, init) => {
      peticiones.push({ url: String(entrada), init });
      return new Response(JSON.stringify(json), { status });
    };
    return { cliente: clienteGraphDePlataforma(config, { fetch: f }), peticiones };
  };

  it('el código se cambia con id y clave de la app, y SIN redirect_uri', async () => {
    const { cliente, peticiones } = conRespuesta(200, { access_token: 'TOKEN-DE-NEGOCIO' });
    expect(await cliente.intercambiarCodigo('CODIGO')).toBe('TOKEN-DE-NEGOCIO');
    const url = new URL(peticiones[0]!.url);
    expect(url.origin + url.pathname).toBe('https://graph.facebook.com/v25.0/oauth/access_token');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'APP1',
      client_secret: 'SECRETO',
      code: 'CODIGO',
    });
  });

  it('un código ya usado o caducado se explica, y no enseña el error de Meta', async () => {
    const { cliente } = conRespuesta(400, {
      error: { message: 'This authorization code has expired' },
    });
    await expect(cliente.intercambiarCodigo('VIEJO')).rejects.toMatchObject({
      codigo: 'codigo_de_meta_rechazado',
    });
  });

  it('coexistencia: se le pregunta a Meta si el número sigue en la app', async () => {
    const si = conRespuesta(200, { is_on_biz_app: true, platform_type: 'CLOUD_API' });
    expect(await si.cliente.estaEnLaApp({ phoneNumberId: '123', accessToken: 'T' })).toBe(true);
    expect(si.peticiones[0]!.url).toBe(
      'https://graph.facebook.com/v25.0/123?fields=is_on_biz_app,platform_type',
    );
    const no = conRespuesta(200, { is_on_biz_app: false });
    expect(await no.cliente.estaEnLaApp({ phoneNumberId: '123', accessToken: 'T' })).toBe(false);
  });

  it('registrar manda el producto y el PIN al número', async () => {
    const { cliente, peticiones } = conRespuesta(200, { success: true });
    expect(
      await cliente.registrarNumero({ phoneNumberId: '123', accessToken: 'T', pin: '004217' }),
    ).toBe(true);
    expect(peticiones[0]!.url).toBe('https://graph.facebook.com/v25.0/123/register');
    expect(peticiones[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(peticiones[0]!.init?.body))).toEqual({
      messaging_product: 'whatsapp',
      pin: '004217',
    });
  });

  it('la agenda y los chats se piden al mismo sitio, cambiando solo el tipo', async () => {
    const { cliente, peticiones } = conRespuesta(200, {
      messaging_product: 'whatsapp',
      request_id: 'r1',
    });
    expect(
      await cliente.pedirSincronizacion({
        phoneNumberId: '123',
        accessToken: 'T',
        tipo: 'history',
      }),
    ).toBe(true);
    expect(peticiones[0]!.url).toBe('https://graph.facebook.com/v25.0/123/smb_app_data');
    expect(JSON.parse(String(peticiones[0]!.init?.body))).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });

  it('si Meta no registra, se dice `false` en vez de lanzar: el canal se conecta con aviso', async () => {
    const { cliente } = conRespuesta(400, { error: { message: 'PIN mismatch' } });
    expect(
      await cliente.registrarNumero({ phoneNumberId: '1', accessToken: 'T', pin: '000000' }),
    ).toBe(false);
  });
});

describe('lo que ve la pantalla', () => {
  it('sin app configurada no hay botón, y se sigue conectando con credenciales', () => {
    expect(plataformaVisible(null)).toEqual({
      disponible: false,
      appId: null,
      version: 'v21.0',
      configWhatsapp: null,
      configPaginas: null,
    });
  });

  it('con app, salen sus ids públicos y nunca la clave', () => {
    const v = plataformaVisible({ appId: 'APP1', appSecret: 'SECRETO', configWhatsapp: 'CFG' });
    expect(v).toMatchObject({ disponible: true, appId: 'APP1', configWhatsapp: 'CFG' });
    expect(JSON.stringify(v)).not.toContain('SECRETO');
  });
});

describe('el PIN', () => {
  it('son siempre seis cifras, también cuando sale un número pequeño', () => {
    expect(generarPin(() => 42)).toBe('000042');
    expect(generarPin(() => 999_999)).toBe('999999');
  });
});
