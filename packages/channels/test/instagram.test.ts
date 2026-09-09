/**
 * Adaptador e ingesta de Instagram, sin red. Igual que con WhatsApp: se
 * prueba la FORMA de lo que sale hacia Meta y el mapeo de lo que vuelve.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AdaptadorInstagram, IngestaInstagram, type ErrorDeCanal } from '../src/index.js';

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
  const cuerpo = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  peticiones.push({ url, metodo: init?.method ?? 'GET', cabeceras, cuerpo });
  const r = respuestas.shift() ?? { status: 200, json: {} };
  return new Response(r.bytes ?? JSON.stringify(r.json ?? {}), {
    status: r.status,
    headers: { 'content-type': r.bytes ? 'image/jpeg' : 'application/json', ...(r.headers ?? {}) },
  });
};

const cred = { igUserId: 'IG777', accessToken: 'EAAP-token-de-pagina' };
const adaptador = () =>
  new AdaptadorInstagram({ resolverCredenciales: async () => cred, fetch: fetchFalso });
const destino = { externalUserId: 'IGSID-ana', channelAccountId: 'ca-ig' };

beforeEach(() => {
  peticiones = [];
  respuestas = [];
});

describe('capacidades', () => {
  it('declara lo que Instagram es: sin plantillas, con comentarios, medios solo por URL', () => {
    const c = adaptador().capacidades();
    expect(c.soportaPlantillas).toBe(false);
    expect(c.soportaComentarios).toBe(true);
    expect(c.respuestasPrivadasPorComentario).toBe(1);
    expect(c.requiereUrlPublicaParaMedios).toBe(true);
    expect(c.tiposSoportados).not.toContain('template');
    expect(adaptador().politicaDeVentana()).toEqual({ duracionHoras: 24, salienteReinicia: false });
  });
});

describe('envío', () => {
  it('texto: POST /{ig-user-id}/messages con recipient.id y token de página', async () => {
    respuestas.push({ status: 200, json: { recipient_id: 'IGSID-ana', message_id: 'mid.1' } });
    const r = await adaptador().sendText({ ...destino, texto: 'Hola' });
    expect(r.externalMessageId).toBe('mid.1');
    const p = peticiones[0]!;
    expect(p.url).toBe('https://graph.facebook.com/v21.0/IG777/messages');
    expect(p.cabeceras['authorization']).toBe('Bearer EAAP-token-de-pagina');
    expect(p.cuerpo).toEqual({ recipient: { id: 'IGSID-ana' }, message: { text: 'Hola' } });
  });

  it('medio por URL con pie: adjunto y luego el texto', async () => {
    respuestas.push(
      { status: 200, json: { message_id: 'mid.2' } },
      { status: 200, json: { message_id: 'mid.3' } },
    );
    await adaptador().sendMedia({
      ...destino,
      tipo: 'image',
      origen: { tipo: 'url', url: 'https://r2.example/firmada.jpg' },
      pieDeFoto: 'Catálogo',
    });
    expect(peticiones).toHaveLength(2);
    expect(peticiones[0]!.cuerpo).toEqual({
      recipient: { id: 'IGSID-ana' },
      message: {
        attachment: { type: 'image', payload: { url: 'https://r2.example/firmada.jpg' } },
      },
    });
    expect(peticiones[1]!.cuerpo).toEqual({
      recipient: { id: 'IGSID-ana' },
      message: { text: 'Catálogo' },
    });
  });

  it('medio por bytes se rechaza antes de llamar a Meta', async () => {
    const e = await adaptador()
      .sendMedia({
        ...destino,
        tipo: 'image',
        origen: { tipo: 'buffer', datos: Buffer.alloc(10), mime: 'image/jpeg' },
      })
      .catch((x: ErrorDeCanal) => x);
    expect((e as ErrorDeCanal).tipo).toBe('tipo_no_soportado');
    expect(peticiones).toHaveLength(0);
  });

  it('las plantillas no existen en Instagram', async () => {
    const e = await adaptador()
      .sendTemplate({ ...destino, nombre: 'x', idioma: 'es', parametros: [] })
      .catch((x: ErrorDeCanal) => x);
    expect((e as ErrorDeCanal).tipo).toBe('tipo_no_soportado');
    expect(await adaptador().syncTemplates('ca-ig')).toEqual([]);
  });

  it('respuesta privada a comentario: recipient.comment_id; pública: /{comment-id}/replies', async () => {
    respuestas.push(
      { status: 200, json: { message_id: 'mid.9' } },
      { status: 200, json: { id: 'c.reply' } },
    );
    const a = adaptador();
    const priv = await a.replyToComment({
      channelAccountId: 'ca-ig',
      comentarioId: 'c1',
      texto: 'Te escribo',
      modo: 'privada',
    });
    expect(priv.externalMessageId).toBe('mid.9');
    expect(peticiones[0]!.cuerpo).toEqual({
      recipient: { comment_id: 'c1' },
      message: { text: 'Te escribo' },
    });
    const pub = await a.replyToComment({
      channelAccountId: 'ca-ig',
      comentarioId: 'c1',
      texto: 'Gracias',
      modo: 'publica',
    });
    expect(pub.externalMessageId).toBe('c.reply');
    expect(peticiones[1]!.url).toBe('https://graph.facebook.com/v21.0/c1/replies');
    expect(peticiones[1]!.cuerpo).toEqual({ message: 'Gracias' });
  });

  it('texto de más de 1000 caracteres lo paran las capacidades', async () => {
    const e = await adaptador()
      .sendText({ ...destino, texto: 'a'.repeat(1001) })
      .catch((x: ErrorDeCanal) => x);
    expect((e as ErrorDeCanal).tipo).toBe('rechazado_por_proveedor');
    expect(peticiones).toHaveLength(0);
  });
});

describe('errores de Meta → reintentable', () => {
  const error = async (
    status: number,
    code: number,
    sub?: number,
    headers?: Record<string, string>,
  ) => {
    respuestas.push({
      status,
      json: { error: { message: 'x', code, error_subcode: sub } },
      ...(headers ? { headers } : {}),
    });
    return adaptador()
      .sendText({ ...destino, texto: 'hola' })
      .catch((x: ErrorDeCanal) => x) as Promise<ErrorDeCanal>;
  };
  it('token caducado: no reintentable', async () => {
    expect(await error(400, 190)).toMatchObject({ tipo: 'token_invalido', reintentable: false });
  });
  it('límite de tasa: reintentable con espera', async () => {
    const e = await error(429, 4, undefined, { 'retry-after': '45' });
    expect(e).toMatchObject({
      tipo: 'limite_de_tasa',
      reintentable: true,
      reintentarEnSegundos: 45,
    });
  });
  it('fuera de la ventana de 24 h: no reintentable', async () => {
    expect(await error(400, 10, 2534022)).toMatchObject({
      tipo: 'fuera_de_ventana',
      reintentable: false,
    });
  });
  it('destinatario que no existe: no reintentable', async () => {
    expect(await error(400, 100, 2534014)).toMatchObject({
      tipo: 'destinatario_invalido',
      reintentable: false,
    });
  });
  it('caída de Meta: reintentable', async () => {
    expect(await error(500, 2)).toMatchObject({
      tipo: 'proveedor_no_disponible',
      reintentable: true,
    });
  });
});

describe('fetchMedia', () => {
  it('descarga la URL del CDN tal cual, sin token', async () => {
    respuestas.push({ status: 200, bytes: Buffer.from('jpg-bytes') });
    const m = await adaptador().fetchMedia(
      'https://scontent.cdninstagram.com/x.jpg?sig=1',
      'ca-ig',
    );
    expect(peticiones[0]!.url).toBe('https://scontent.cdninstagram.com/x.jpg?sig=1');
    expect(peticiones[0]!.cabeceras['authorization']).toBeUndefined();
    expect(m).toMatchObject({ mime: 'image/jpeg', bytes: 9 });
  });
  it('una URL caducada (403) no se reintenta', async () => {
    respuestas.push({ status: 403, json: {} });
    const e = await adaptador()
      .fetchMedia('https://cdn/x', 'ca-ig')
      .catch((x: ErrorDeCanal) => x);
    expect((e as ErrorDeCanal).reintentable).toBe(false);
  });
});

describe('ingesta', () => {
  const ingesta = new IngestaInstagram();
  const cuerpo = {
    object: 'instagram',
    entry: [
      {
        id: 'IG777',
        time: 1757440000000,
        messaging: [
          {
            sender: { id: 'IGSID-ana' },
            recipient: { id: 'IG777' },
            timestamp: 1757440000123,
            message: { mid: 'mid.a', text: 'Hola, hacen envíos?' },
          },
          {
            sender: { id: 'IG777' },
            recipient: { id: 'IGSID-ana' },
            timestamp: 1757440001000,
            message: { mid: 'mid.eco', text: 'Sí', is_echo: true },
          },
          {
            sender: { id: 'IGSID-beto' },
            recipient: { id: 'IG777' },
            timestamp: 1757440002000,
            message: {
              mid: 'mid.b',
              attachments: [
                { type: 'image', payload: { url: 'https://scontent.cdninstagram.com/foto.jpg' } },
              ],
            },
          },
        ],
        changes: [
          {
            field: 'comments',
            value: {
              id: 'c.100',
              text: 'Precio?',
              from: { id: 'IGSID-caro', username: 'caro.rp' },
              media: { id: 'post.1', media_product_type: 'FEED' },
              timestamp: 1757440003,
            },
          },
          {
            field: 'comments',
            value: {
              id: 'c.101',
              text: 'Gracias!',
              from: { id: 'IG777', username: 'nippon' },
              media: { id: 'post.1' },
            },
          },
        ],
      },
    ],
  };

  it('DMs, adjuntos y comentarios, sin ecos ni comentarios propios', () => {
    const eventos = ingesta.parsearEventos(cuerpo);
    expect(eventos.map((e) => e.clase)).toEqual(['mensaje', 'mensaje', 'comentario']);
    expect(eventos[0]).toMatchObject({
      externalAccountId: 'IG777',
      externalUserId: 'IGSID-ana',
      externalMessageId: 'mid.a',
      tipo: 'text',
      texto: 'Hola, hacen envíos?',
    });
    expect((eventos[0] as { ocurridoEn: Date }).ocurridoEn.toISOString()).toBe(
      '2025-09-09T17:46:40.123Z',
    );
    expect(eventos[1]).toMatchObject({
      tipo: 'image',
      mediaId: 'https://scontent.cdninstagram.com/foto.jpg',
    });
    expect(eventos[2]).toMatchObject({
      clase: 'comentario',
      externalCommentId: 'c.100',
      externalUserId: 'IGSID-caro',
      externalPostId: 'post.1',
      texto: 'Precio?',
      nombreDeUsuario: 'caro.rp',
    });
  });

  it('firma y reto son los de Meta', () => {
    expect(
      ingesta.responderAlDesafio(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': '9' },
        't',
      ),
    ).toBe('9');
    expect(
      ingesta.verificarFirma({ cuerpoCrudo: Buffer.from('{}'), cabeceras: {} }, 'secreto'),
    ).toBe(false);
  });
});
