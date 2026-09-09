/**
 * Adaptador e ingesta de WhatsApp Cloud API, sin red.
 *
 * Un `fetch` falso registra cada petición y devuelve respuestas en cola. Lo
 * que se prueba es la FORMA exacta de lo que sale hacia Meta y el mapeo de lo
 * que vuelve —sobre todo los errores, que es donde `reintentable` decide si
 * un mensaje se pierde o se recupera.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AdaptadorWhatsapp, IngestaWhatsapp, type ErrorDeCanal } from '../src/index.js';

interface Registro {
  url: string;
  metodo: string;
  cabeceras: Record<string, string>;
  cuerpo: unknown;
}

let peticiones: Registro[];
let respuestas: Array<{
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  bytes?: Buffer;
}>;

const fetchFalso: typeof fetch = async (entrada, init) => {
  const url =
    typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  const cabeceras = Object.fromEntries(new Headers(init?.headers).entries());
  let cuerpo: unknown = undefined;
  if (typeof init?.body === 'string') cuerpo = JSON.parse(init.body);
  else if (init?.body instanceof FormData) {
    cuerpo = Object.fromEntries(
      [...init.body.entries()].map(([k, v]) => [k, v instanceof Blob ? `<blob ${v.size}>` : v]),
    );
  }
  peticiones.push({ url, metodo: init?.method ?? 'GET', cabeceras, cuerpo });
  const r = respuestas.shift() ?? { status: 200, json: {} };
  const body = r.bytes ?? JSON.stringify(r.json ?? {});
  return new Response(body, {
    status: r.status,
    headers: {
      'content-type': r.bytes ? 'application/octet-stream' : 'application/json',
      ...(r.headers ?? {}),
    },
  });
};

const cred = { phoneNumberId: 'PN123', wabaId: 'WABA9', accessToken: 'EAAG-token-secreto' };
const adaptador = () =>
  new AdaptadorWhatsapp({
    resolverCredenciales: async () => cred,
    fetch: fetchFalso,
    apiVersion: 'v21.0',
  });
const destino = { externalUserId: '34600111222', channelAccountId: 'ca-1' };

beforeEach(() => {
  peticiones = [];
  respuestas = [];
});

describe('sendText', () => {
  it('llama a /{phone_number_id}/messages con la forma de Cloud API y el token', async () => {
    respuestas.push({ status: 200, json: { messages: [{ id: 'wamid.HBg1' }] } });
    const r = await adaptador().sendText({ ...destino, texto: 'Hola' });

    expect(r.externalMessageId).toBe('wamid.HBg1');
    expect(r.estado).toBe('sent');
    expect(peticiones).toHaveLength(1);
    const p = peticiones[0]!;
    expect(p.url).toBe('https://graph.facebook.com/v21.0/PN123/messages');
    expect(p.metodo).toBe('POST');
    expect(p.cabeceras['authorization']).toBe('Bearer EAAG-token-secreto');
    expect(p.cuerpo).toMatchObject({
      messaging_product: 'whatsapp',
      to: '34600111222',
      type: 'text',
      text: { body: 'Hola' },
    });
  });

  it('cita el mensaje al que responde', async () => {
    respuestas.push({ status: 200, json: { messages: [{ id: 'x' }] } });
    await adaptador().sendText({ ...destino, texto: 'ok', respondeA: 'wamid.ORIG' });
    expect(peticiones[0]!.cuerpo).toMatchObject({ context: { message_id: 'wamid.ORIG' } });
  });

  it('un texto de más de 4096 caracteres no llega a la red', async () => {
    await expect(
      adaptador().sendText({ ...destino, texto: 'a'.repeat(4097) }),
    ).rejects.toMatchObject({
      tipo: 'rechazado_por_proveedor',
      reintentable: false,
    });
    expect(peticiones).toHaveLength(0);
  });
});

describe('sendMedia', () => {
  it('por enlace: link y caption', async () => {
    respuestas.push({ status: 200, json: { messages: [{ id: 'm1' }] } });
    await adaptador().sendMedia({
      ...destino,
      tipo: 'image',
      origen: { tipo: 'url', url: 'https://cdn.test/foto.jpg' },
      pieDeFoto: 'mira',
    });
    expect(peticiones[0]!.cuerpo).toMatchObject({
      type: 'image',
      image: { link: 'https://cdn.test/foto.jpg', caption: 'mira' },
    });
  });

  it('por bytes: sube primero a /media y envía el id', async () => {
    respuestas.push({ status: 200, json: { id: 'MEDIA77' } });
    respuestas.push({ status: 200, json: { messages: [{ id: 'm2' }] } });
    await adaptador().sendMedia({
      ...destino,
      tipo: 'document',
      origen: { tipo: 'buffer', datos: Buffer.from('%PDF-1.4'), mime: 'application/pdf' },
      nombreDeArchivo: 'factura.pdf',
    });
    expect(peticiones).toHaveLength(2);
    expect(peticiones[0]!.url).toBe('https://graph.facebook.com/v21.0/PN123/media');
    expect(peticiones[0]!.cuerpo).toMatchObject({
      messaging_product: 'whatsapp',
      type: 'application/pdf',
    });
    expect(peticiones[1]!.cuerpo).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA77', filename: 'factura.pdf' },
    });
  });

  it('una imagen por bytes que supera 5 MB se rechaza sin subir nada', async () => {
    await expect(
      adaptador().sendMedia({
        ...destino,
        tipo: 'image',
        origen: { tipo: 'buffer', datos: Buffer.alloc(6 * 1024 * 1024), mime: 'image/jpeg' },
      }),
    ).rejects.toMatchObject({ tipo: 'medio_demasiado_grande' });
    expect(peticiones).toHaveLength(0);
  });
});

describe('sendTemplate', () => {
  it('nombre, idioma, parámetros de cuerpo y cabecera de imagen', async () => {
    respuestas.push({ status: 200, json: { messages: [{ id: 't1' }] } });
    await adaptador().sendTemplate({
      ...destino,
      nombre: 'recordatorio_cita',
      idioma: 'es',
      parametros: ['Ana', 'lunes'],
      cabecera: { tipo: 'imagen' as never, url: 'https://cdn.test/h.jpg' },
    });
    const t = (peticiones[0]!.cuerpo as { template: Record<string, unknown> }).template;
    expect(t).toMatchObject({ name: 'recordatorio_cita', language: { code: 'es' } });
    const comps = t['components'] as Array<{ type: string; parameters: unknown[] }>;
    expect(comps.find((c) => c.type === 'body')?.parameters).toEqual([
      { type: 'text', text: 'Ana' },
      { type: 'text', text: 'lunes' },
    ]);
    expect(comps.find((c) => c.type === 'header')).toBeTruthy();
  });
});

describe('mapeo de errores: lo que decide el worker', () => {
  const error = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return e as ErrorDeCanal;
    }
    throw new Error('debería haber fallado');
  };

  it('190 / 401 → token inválido, NO reintentable', async () => {
    respuestas.push({
      status: 401,
      json: { error: { code: 190, message: 'Invalid OAuth access token' } },
    });
    const e = await error(() => adaptador().sendText({ ...destino, texto: 'x' }));
    expect(e.tipo).toBe('token_invalido');
    expect(e.reintentable).toBe(false);
  });

  it('429 → límite de tasa, reintentable, respeta Retry-After', async () => {
    respuestas.push({
      status: 429,
      headers: { 'retry-after': '17' },
      json: { error: { code: 130429 } },
    });
    const e = await error(() => adaptador().sendText({ ...destino, texto: 'x' }));
    expect(e.tipo).toBe('limite_de_tasa');
    expect(e.reintentable).toBe(true);
    expect(e.reintentarEnSegundos).toBe(17);
  });

  it('131047 → fuera de ventana, no reintentable', async () => {
    respuestas.push({
      status: 400,
      json: { error: { code: 131047, message: 'Re-engagement message' } },
    });
    const e = await error(() => adaptador().sendText({ ...destino, texto: 'x' }));
    expect(e.tipo).toBe('fuera_de_ventana');
    expect(e.reintentable).toBe(false);
  });

  it('132001 → plantilla no aprobada', async () => {
    respuestas.push({ status: 400, json: { error: { code: 132001 } } });
    const e = await error(() =>
      adaptador().sendTemplate({ ...destino, nombre: 'x', idioma: 'es', parametros: [] }),
    );
    expect(e.tipo).toBe('plantilla_no_aprobada');
  });

  it('5xx → proveedor no disponible, reintentable', async () => {
    respuestas.push({ status: 503, json: {} });
    const e = await error(() => adaptador().sendText({ ...destino, texto: 'x' }));
    expect(e.tipo).toBe('proveedor_no_disponible');
    expect(e.reintentable).toBe(true);
  });

  it('red caída → proveedor no disponible, reintentable', async () => {
    const roto = new AdaptadorWhatsapp({
      resolverCredenciales: async () => cred,
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const e = await error(() => roto.sendText({ ...destino, texto: 'x' }));
    expect(e.tipo).toBe('proveedor_no_disponible');
    expect(e.reintentable).toBe(true);
  });

  it('el mensaje de error conserva el código de Meta para diagnosticar', async () => {
    respuestas.push({
      status: 400,
      json: { error: { code: 100, error_subcode: 33, message: 'Unsupported post request' } },
    });
    const e = await error(() => adaptador().sendText({ ...destino, texto: 'x' }));
    expect(e.message).toMatch(/100\/33/);
  });
});

describe('fetchMedia', () => {
  it('dos pasos: metadatos y descarga con el mismo token', async () => {
    respuestas.push({
      status: 200,
      json: { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' },
    });
    respuestas.push({ status: 200, bytes: Buffer.from('JPEGDATA') });
    const m = await adaptador().fetchMedia('MEDIA1', 'ca-1');
    expect(m.mime).toBe('image/jpeg');
    expect(m.datos.toString()).toBe('JPEGDATA');
    expect(peticiones[0]!.url).toBe('https://graph.facebook.com/v21.0/MEDIA1');
    expect(peticiones[1]!.url).toBe('https://lookaside.fbsbx.com/x');
    expect(peticiones[1]!.cabeceras['authorization']).toBe('Bearer EAAG-token-secreto');
  });
});

describe('syncTemplates', () => {
  it('traduce estados y conserva el motivo de rechazo y la categoría efectiva', async () => {
    respuestas.push({
      status: 200,
      json: {
        data: [
          {
            id: '1',
            name: 'bienvenida',
            language: 'es',
            status: 'APPROVED',
            category: 'UTILITY',
            rejected_reason: 'NONE',
            quality_score: { score: 'GREEN' },
          },
          {
            id: '2',
            name: 'promo',
            language: 'es',
            status: 'REJECTED',
            category: 'MARKETING',
            rejected_reason: 'PROMOTIONAL',
          },
          { id: '3', name: 'otp', language: 'es', status: 'PAUSED', category: 'AUTHENTICATION' },
        ],
      },
    });
    const t = await adaptador().syncTemplates('ca-1');
    expect(peticiones[0]!.url).toContain('/WABA9/message_templates');
    expect(t[0]).toMatchObject({
      estado: 'aprobada',
      categoriaEfectiva: 'UTILITY',
      motivoDeRechazo: null,
      calidad: 'GREEN',
    });
    expect(t[1]).toMatchObject({ estado: 'rechazada', motivoDeRechazo: 'PROMOTIONAL' });
    expect(t[2]).toMatchObject({ estado: 'pausada' });
  });
});

describe('ingesta: payload con la forma real de Meta', () => {
  const ingesta = new IngestaWhatsapp();

  const webhook = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA9',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PN123' },
              contacts: [{ profile: { name: 'Ana Pérez' }, wa_id: '34600111222' }],
              messages: [
                {
                  from: '34600111222',
                  id: 'wamid.T1',
                  timestamp: '1757440000',
                  type: 'text',
                  text: { body: 'Hola' },
                },
                {
                  from: '34600111222',
                  id: 'wamid.I1',
                  timestamp: '1757440010',
                  type: 'image',
                  image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'mi coche' },
                  context: { from: '15550001111', id: 'wamid.PREV' },
                },
                {
                  from: '34600111222',
                  id: 'wamid.R1',
                  timestamp: '1757440020',
                  type: 'reaction',
                  reaction: { emoji: '👍' },
                },
                {
                  from: '34600333444',
                  id: 'wamid.AD1',
                  timestamp: '1757440030',
                  type: 'text',
                  text: { body: 'Vi el anuncio' },
                  referral: { source_type: 'ad', source_id: '123', headline: 'Oferta' },
                },
              ],
              statuses: [
                {
                  id: 'wamid.OUT1',
                  status: 'delivered',
                  timestamp: '1757440040',
                  recipient_id: '34600111222',
                },
                {
                  id: 'wamid.OUT2',
                  status: 'failed',
                  timestamp: '1757440050',
                  recipient_id: '34600999999',
                  errors: [{ code: 131026, title: 'Message undeliverable' }],
                },
              ],
            },
          },
          {
            field: 'message_template_status_update',
            value: {
              event: 'REJECTED',
              message_template_id: 55,
              message_template_name: 'promo',
              message_template_language: 'es',
              reason: 'PROMOTIONAL',
            },
          },
        ],
      },
    ],
  };

  it('aplana mensajes, estados y plantillas; ignora tipos desconocidos', () => {
    const eventos = ingesta.parsearEventos(webhook);
    const clases = eventos.map((e) => e.clase);
    // 3 mensajes (el reaction se ignora), 2 estados, 1 plantilla.
    expect(clases.filter((c) => c === 'mensaje')).toHaveLength(3);
    expect(clases.filter((c) => c === 'estado')).toHaveLength(2);
    expect(clases.filter((c) => c === 'plantilla')).toHaveLength(1);
  });

  it('el texto trae nombre de perfil, teléfono E.164 y fecha de Meta', () => {
    const e = ingesta
      .parsearEventos(webhook)
      .find((x) => x.clase === 'mensaje' && x.externalMessageId === 'wamid.T1');
    expect(e).toMatchObject({
      externalAccountId: 'PN123',
      externalUserId: '34600111222',
      nombreDeContacto: 'Ana Pérez',
      telefonoE164: '+34600111222',
      tipo: 'text',
      texto: 'Hola',
      entradaGratuita: false,
    });
    expect((e as { ocurridoEn: Date }).ocurridoEn.toISOString()).toBe('2025-09-09T17:46:40.000Z');
  });

  it('la imagen trae mediaId, caption como texto y el mensaje citado', () => {
    const e = ingesta
      .parsearEventos(webhook)
      .find((x) => x.clase === 'mensaje' && x.externalMessageId === 'wamid.I1');
    expect(e).toMatchObject({
      tipo: 'image',
      mediaId: 'MEDIA1',
      texto: 'mi coche',
      respondeA: 'wamid.PREV',
    });
  });

  it('un referral de anuncio marca la entrada gratuita de 72 h', () => {
    const e = ingesta
      .parsearEventos(webhook)
      .find((x) => x.clase === 'mensaje' && x.externalMessageId === 'wamid.AD1');
    expect(e).toMatchObject({ entradaGratuita: true });
  });

  it('los estados traen el error de entrega cuando fallan', () => {
    const estados = ingesta.parsearEventos(webhook).filter((x) => x.clase === 'estado');
    expect(estados[0]).toMatchObject({ externalMessageId: 'wamid.OUT1', estado: 'delivered' });
    expect(estados[1]).toMatchObject({
      externalMessageId: 'wamid.OUT2',
      estado: 'failed',
      error: { codigo: '131026', mensaje: 'Message undeliverable' },
    });
  });

  it('el cambio de estado de plantilla conserva el motivo', () => {
    const p = ingesta.parsearEventos(webhook).find((x) => x.clase === 'plantilla');
    expect(p).toMatchObject({
      externalAccountId: 'WABA9',
      nombre: 'promo',
      idioma: 'es',
      estado: 'rechazada',
      motivoDeRechazo: 'PROMOTIONAL',
    });
  });

  it('un payload vacío o raro devuelve lista vacía, no excepción', () => {
    expect(ingesta.parsearEventos(null)).toEqual([]);
    expect(ingesta.parsearEventos({ entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });
});
