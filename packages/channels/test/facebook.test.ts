/**
 * Adaptador e ingesta de Facebook (Messenger y comentarios de página), sin red.
 * Igual que Instagram: se prueba la FORMA de lo que sale hacia Meta —según la
 * documentación de la Send API, respuestas privadas y comentarios— y el mapeo
 * de lo que vuelve.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AdaptadorFacebook, IngestaFacebook, type ErrorDeCanal } from '../src/index.js';

interface Registro {
  url: string;
  metodo: string;
  cabeceras: Record<string, string>;
  cuerpo: unknown;
}
let peticiones: Registro[];
let respuestas: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>;

const fetchFalso: typeof fetch = async (entrada, init) => {
  const url =
    typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  const cabeceras = Object.fromEntries(new Headers(init?.headers).entries());
  const cuerpo = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  peticiones.push({ url, metodo: init?.method ?? 'GET', cabeceras, cuerpo });
  const r = respuestas.shift() ?? { status: 200, json: {} };
  return new Response(JSON.stringify(r.json ?? {}), {
    status: r.status,
    headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
  });
};

const cred = { pageId: 'PAGE1', accessToken: 'EAAP-token-de-pagina' };
const adaptador = () =>
  new AdaptadorFacebook({ resolverCredenciales: async () => cred, fetch: fetchFalso });
const destino = { externalUserId: 'PSID-rosa', channelAccountId: 'ca-fb' };

beforeEach(() => {
  peticiones = [];
  respuestas = [];
});

describe('capacidades', () => {
  it('sin plantillas, con comentarios (una privada), medios por URL y ventana de 24 h', () => {
    const c = adaptador().capacidades();
    expect(c.canal).toBe('facebook');
    expect(c.soportaPlantillas).toBe(false);
    expect(c.soportaComentarios).toBe(true);
    expect(c.respuestasPrivadasPorComentario).toBe(1);
    expect(c.requiereUrlPublicaParaMedios).toBe(true);
    expect(adaptador().politicaDeVentana()).toEqual({ duracionHoras: 24, salienteReinicia: false });
  });
});

describe('envío', () => {
  it('texto: POST /{page-id}/messages con recipient.id, RESPONSE y token de página', async () => {
    respuestas.push({ status: 200, json: { recipient_id: 'PSID-rosa', message_id: 'm_1' } });
    const r = await adaptador().sendText({ ...destino, texto: 'Hola Rosa' });
    expect(r).toMatchObject({ externalMessageId: 'm_1', estado: 'sent' });
    expect(peticiones[0]).toMatchObject({
      url: 'https://graph.facebook.com/v21.0/PAGE1/messages',
      metodo: 'POST',
      cuerpo: {
        recipient: { id: 'PSID-rosa' },
        messaging_type: 'RESPONSE',
        message: { text: 'Hola Rosa' },
      },
    });
    expect(peticiones[0]!.cabeceras['authorization']).toBe('Bearer EAAP-token-de-pagina');
  });

  it('un documento sale como attachment de tipo file, y el pie como segundo mensaje', async () => {
    respuestas.push({ status: 200, json: { message_id: 'm_2' } }, { status: 200, json: {} });
    await adaptador().sendMedia({
      ...destino,
      tipo: 'document',
      origen: { tipo: 'url', url: 'https://s3.example/tarifa.pdf' },
      pieDeFoto: 'Nuestra tarifa',
    });
    expect(peticiones[0]!.cuerpo).toMatchObject({
      message: {
        attachment: { type: 'file', payload: { url: 'https://s3.example/tarifa.pdf' } },
      },
    });
    expect(peticiones[1]!.cuerpo).toMatchObject({ message: { text: 'Nuestra tarifa' } });
  });

  it('bytes sin URL no llegan a la red', async () => {
    await expect(
      adaptador().sendMedia({
        ...destino,
        tipo: 'image',
        origen: { tipo: 'buffer', datos: Buffer.from('x'), mime: 'image/png' },
      }),
    ).rejects.toMatchObject({ tipo: 'tipo_no_soportado' });
    expect(peticiones).toHaveLength(0);
  });

  it('las plantillas no existen en Messenger', async () => {
    await expect(
      adaptador().sendTemplate({ ...destino, nombre: 'x', idioma: 'es', parametros: [] }),
    ).rejects.toMatchObject({ tipo: 'tipo_no_soportado' });
  });
});

describe('comentarios', () => {
  it('respuesta privada: /{page-id}/messages con recipient.comment_id', async () => {
    respuestas.push({ status: 200, json: { message_id: 'm_priv' } });
    await adaptador().replyToComment({
      channelAccountId: 'ca-fb',
      comentarioId: '123_456',
      modo: 'privada',
      texto: 'Te escribimos por privado',
    });
    expect(peticiones[0]).toMatchObject({
      url: 'https://graph.facebook.com/v21.0/PAGE1/messages',
      cuerpo: {
        recipient: { comment_id: '123_456' },
        message: { text: 'Te escribimos por privado' },
      },
    });
    expect(peticiones[0]!.cuerpo).not.toHaveProperty('messaging_type');
  });

  it('respuesta pública: POST /{comment-id}/comments con message', async () => {
    respuestas.push({ status: 200, json: { id: '123_789' } });
    const r = await adaptador().replyToComment({
      channelAccountId: 'ca-fb',
      comentarioId: '123_456',
      modo: 'publica',
      texto: 'Gracias',
    });
    expect(r.externalMessageId).toBe('123_789');
    expect(peticiones[0]).toMatchObject({
      url: 'https://graph.facebook.com/v21.0/123_456/comments',
      cuerpo: { message: 'Gracias' },
    });
  });
});

describe('errores', () => {
  const fallo = async (status: number, error: unknown) => {
    respuestas.push({ status, json: { error } });
    try {
      await adaptador().sendText({ ...destino, texto: 'x' });
    } catch (e) {
      return e as ErrorDeCanal;
    }
    throw new Error('no falló');
  };

  it('token caducado (190) no se reintenta', async () => {
    expect(await fallo(400, { code: 190 })).toMatchObject({
      tipo: 'token_invalido',
      reintentable: false,
    });
  });
  it('persona no disponible (551) no se reintenta', async () => {
    expect(await fallo(400, { code: 551 })).toMatchObject({
      tipo: 'destinatario_invalido',
      reintentable: false,
    });
  });
  it('límite de tasa se reintenta', async () => {
    expect(await fallo(400, { code: 613 })).toMatchObject({
      tipo: 'limite_de_tasa',
      reintentable: true,
    });
  });
  it('lo desconocido no se reintenta y lleva el mensaje de Meta', async () => {
    const e = await fallo(400, { code: 10, error_subcode: 99, message: 'Fuera de la ventana' });
    expect(e).toMatchObject({ tipo: 'rechazado_por_proveedor', reintentable: false });
    expect(e.message).toContain('Fuera de la ventana');
  });
});

describe('ingesta', () => {
  const ingesta = new IngestaFacebook();

  it('un mensaje de Messenger con la forma documentada: PSID, mid y texto', () => {
    const [e] = ingesta.parsearEventos({
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          time: 1458692752478,
          messaging: [
            {
              sender: { id: 'PSID-rosa' },
              recipient: { id: 'PAGE1' },
              timestamp: 1458692752478,
              message: { mid: 'mid.1457764197618:41d102a3e1ae206a38', text: 'hello, world!' },
            },
          ],
        },
      ],
    });
    expect(e).toMatchObject({
      clase: 'mensaje',
      canal: 'facebook',
      externalAccountId: 'PAGE1',
      externalUserId: 'PSID-rosa',
      externalMessageId: 'mid.1457764197618:41d102a3e1ae206a38',
      tipo: 'text',
      texto: 'hello, world!',
    });
    expect((e as { ocurridoEn: Date }).ocurridoEn.getTime()).toBe(1458692752478);
  });

  it('una imagen trae su URL como mediaId; el eco de lo nuestro se ignora', () => {
    const eventos = ingesta.parsearEventos({
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          messaging: [
            {
              sender: { id: 'PSID-rosa' },
              timestamp: 1,
              message: {
                mid: 'm.img',
                attachments: [{ type: 'image', payload: { url: 'https://cdn.fb/x.jpg' } }],
              },
            },
            {
              sender: { id: 'PAGE1' },
              timestamp: 2,
              message: { mid: 'm.eco', text: 'nuestro', is_echo: true },
            },
          ],
        },
      ],
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ tipo: 'image', mediaId: 'https://cdn.fb/x.jpg' });
  });

  it('un comentario nuevo del feed abre hilo; reacciones, ediciones y los de la página no', () => {
    const cambio = (value: Record<string, unknown>) => ({ field: 'feed', value });
    const eventos = ingesta.parsearEventos({
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          changes: [
            cambio({
              item: 'comment',
              verb: 'add',
              comment_id: 'P_C1',
              post_id: 'PAGE1_POST9',
              parent_id: 'PAGE1_POST9',
              from: { id: 'U-rosa', name: 'Rosa Quispe' },
              message: 'Precio por noche?',
              created_time: 1757440000,
            }),
            cambio({ item: 'reaction', verb: 'add', post_id: 'PAGE1_POST9', from: { id: 'U-x' } }),
            cambio({
              item: 'comment',
              verb: 'edited',
              comment_id: 'P_C1',
              post_id: 'PAGE1_POST9',
              from: { id: 'U-rosa' },
            }),
            cambio({
              item: 'comment',
              verb: 'add',
              comment_id: 'P_C2',
              post_id: 'PAGE1_POST9',
              parent_id: 'P_C1',
              from: { id: 'PAGE1', name: 'El Paraiso' },
              message: 'Te escribimos',
            }),
          ],
        },
      ],
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      clase: 'comentario',
      canal: 'facebook',
      externalCommentId: 'P_C1',
      externalUserId: 'U-rosa',
      externalPostId: 'PAGE1_POST9',
      texto: 'Precio por noche?',
      nombreDeUsuario: 'Rosa Quispe',
    });
    // Comentario de primer nivel: su parent es la publicación, no otro comentario.
    expect((eventos[0] as { respondeAComentario?: string }).respondeAComentario).toBeUndefined();
  });
});
