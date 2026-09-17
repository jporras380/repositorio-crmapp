/**
 * Descubrimiento de cuentas con un solo token, sin red.
 *
 * Las respuestas falsas tienen la forma documentada por Meta. Lo que se prueba
 * es lo que decide qué ve el cliente: de dónde salen las WABA, qué pasa cuando
 * Meta no deja listarlas, que el token de página sustituya al de usuario, y que
 * un token caducado no se confunda con «no tengo permiso».
 */
import { describe, expect, it } from 'vitest';
import { descubridorGraph } from '../src/canales/descubrimiento.js';
import { ErrorDeNegocio } from '../src/auth/auth.service.js';

type Ruta = { status?: number; json: unknown };

/** fetch falso: responde por prefijo de ruta y apunta cada llamada. */
function redFalsa(rutas: Record<string, Ruta>) {
  const llamadas: { metodo: string; ruta: string; token: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const ruta = url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '');
    const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';
    llamadas.push({ metodo: init?.method ?? 'GET', ruta, token: auth.replace('Bearer ', '') });
    const clave = Object.keys(rutas)
      .filter((k) => ruta.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const r = clave ? rutas[clave]! : { status: 404, json: { error: { code: 803 } } };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

const NUMEROS = {
  json: {
    data: [
      {
        id: '111',
        display_phone_number: '+51 929 833 609',
        verified_name: 'El Paraíso',
        quality_rating: 'GREEN',
      },
    ],
  },
};

describe('WhatsApp', () => {
  it('saca las WABA de los permisos granulares del token y lista sus números', async () => {
    const { f, llamadas } = redFalsa({
      '/debug_token': {
        json: {
          data: {
            is_valid: true,
            expires_at: 0,
            granular_scopes: [
              { scope: 'whatsapp_business_messaging', target_ids: ['999'] },
              { scope: 'whatsapp_business_management', target_ids: ['999'] },
            ],
          },
        },
      },
      '/999?fields=name': { json: { id: '999', name: 'Paraíso Barranca' } },
      '/999/phone_numbers': NUMEROS,
    });
    const d = await descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' });
    expect(d).toEqual({
      necesitaWaba: false,
      caducaEn: null,
      cuentas: [
        {
          wabaId: '999',
          nombre: 'Paraíso Barranca',
          numeros: [
            {
              phoneNumberId: '111',
              numero: '+51 929 833 609',
              nombreVerificado: 'El Paraíso',
              calidad: 'GREEN',
            },
          ],
        },
      ],
    });
    // El token nunca va en la URL, siempre en la cabecera… salvo como
    // `input_token` de debug_token, que es como Meta lo define.
    expect(llamadas.every((l) => l.token === 'EAAG-token')).toBe(true);
    expect(
      llamadas
        .filter((l) => !l.ruta.startsWith('/debug_token'))
        .map((l) => l.ruta)
        .join(),
    ).not.toContain('EAAG');
  });

  it('un token temporal dice cuándo caduca', async () => {
    const { f } = redFalsa({
      '/debug_token': {
        json: { data: { is_valid: true, expires_at: 1_800_000_000, granular_scopes: [] } },
      },
    });
    const d = await descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' });
    expect(d.caducaEn).toEqual(new Date(1_800_000_000_000));
  });

  it('token de usuario del sistema sin ids granulares: usa sus WABA asignadas', async () => {
    const { f } = redFalsa({
      '/debug_token': {
        json: {
          data: {
            is_valid: true,
            type: 'SYSTEM_USER',
            granular_scopes: [{ scope: 'whatsapp_business_management' }],
          },
        },
      },
      '/me/assigned_whatsapp_business_accounts': { json: { data: [{ id: '777' }] } },
      '/777?fields=name': { json: { name: 'Hotel' } },
      '/777/phone_numbers': NUMEROS,
    });
    const d = await descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' });
    expect(d.necesitaWaba).toBe(false);
    expect(d.cuentas.map((c) => c.wabaId)).toEqual(['777']);
  });

  it('si Meta no deja listar las cuentas, pide el id de WABA en vez de inventar', async () => {
    const { f } = redFalsa({
      '/debug_token': { status: 400, json: { error: { code: 100 } } },
    });
    const d = await descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' });
    expect(d).toEqual({ cuentas: [], necesitaWaba: true, caducaEn: null });
  });

  it('con el id de WABA dado a mano, lista sus números aunque debug_token falle', async () => {
    const { f } = redFalsa({
      '/debug_token': { status: 400, json: { error: { code: 100 } } },
      '/555?fields=name': { json: { name: 'A mano' } },
      '/555/phone_numbers': NUMEROS,
    });
    const d = await descubridorGraph({ fetch: f }).whatsapp({
      accessToken: 'EAAG-token',
      wabaId: '555',
    });
    expect(d.necesitaWaba).toBe(false);
    expect(d.cuentas.map((c) => [c.wabaId, c.numeros.length])).toEqual([['555', 1]]);
  });

  it('un token caducado (código 190) es un rechazo, no «falta el id de WABA»', async () => {
    const { f } = redFalsa({
      '/debug_token': { status: 400, json: { error: { code: 190 } } },
    });
    await expect(
      descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' }),
    ).rejects.toMatchObject({ codigo: 'credenciales_rechazadas', httpStatus: 422 });
  });

  it('debug_token con is_valid=false también es rechazo', async () => {
    const { f } = redFalsa({ '/debug_token': { json: { data: { is_valid: false } } } });
    await expect(
      descubridorGraph({ fetch: f }).whatsapp({ accessToken: 'EAAG-token' }),
    ).rejects.toBeInstanceOf(ErrorDeNegocio);
  });
});

describe('Instagram', () => {
  it('lista las páginas con Instagram vinculado y trae el token de PÁGINA', async () => {
    const { f } = redFalsa({
      '/me/accounts': {
        json: {
          data: [
            {
              id: 'P1',
              name: 'Paraíso Barranca',
              access_token: 'TOKEN-DE-PAGINA',
              instagram_business_account: { id: '1784', username: 'paraisobarranca' },
            },
            // Página sin Instagram: no es una opción.
            { id: 'P2', name: 'Otra', access_token: 'X' },
          ],
        },
      },
    });
    expect(await descubridorGraph({ fetch: f }).instagram({ accessToken: 'USUARIO' })).toEqual([
      {
        igUserId: '1784',
        usuario: '@paraisobarranca',
        paginaId: 'P1',
        pagina: 'Paraíso Barranca',
        tokenDePagina: 'TOKEN-DE-PAGINA',
      },
    ]);
  });

  it('si ya pegaron un token de página, /me es la página y se usa ese mismo token', async () => {
    const { f } = redFalsa({
      '/me/accounts': { status: 400, json: { error: { code: 100 } } },
      '/me?fields': {
        json: { id: 'P1', name: 'Paraíso', instagram_business_account: { id: '1784' } },
      },
    });
    const r = await descubridorGraph({ fetch: f }).instagram({ accessToken: 'YA-DE-PAGINA' });
    expect(r).toEqual([
      {
        igUserId: '1784',
        usuario: null,
        paginaId: 'P1',
        pagina: 'Paraíso',
        tokenDePagina: 'YA-DE-PAGINA',
      },
    ]);
  });

  it('suscribe la página a messages y comments con su token', async () => {
    const { f, llamadas } = redFalsa({ '/P1/subscribed_apps': { json: { success: true } } });
    const ok = await descubridorGraph({ fetch: f }).suscribirPagina({
      paginaId: 'P1',
      tokenDePagina: 'TOKEN-DE-PAGINA',
      campos: ['messages', 'comments'],
    });
    expect(ok).toBe(true);
    expect(llamadas).toEqual([
      {
        metodo: 'POST',
        ruta: '/P1/subscribed_apps?subscribed_fields=messages,comments',
        token: 'TOKEN-DE-PAGINA',
      },
    ]);
  });

  it('una suscripción rechazada devuelve false, no lanza', async () => {
    const { f } = redFalsa({
      '/P1/subscribed_apps': { status: 403, json: { error: { code: 200 } } },
    });
    expect(
      await descubridorGraph({ fetch: f }).suscribirPagina({
        paginaId: 'P1',
        tokenDePagina: 'T',
        campos: ['messages'],
      }),
    ).toBe(false);
  });
});

describe('páginas con un token de usuario del sistema', () => {
  const PAGINA = { id: 'PG1', name: 'Tik o Cos' };

  it('cuando /me/accounts viene vacío, se miran las páginas ASIGNADAS', async () => {
    // Es el caso real: `/me/accounts` es de tokens de usuario y con uno de
    // usuario del sistema devuelve `data: []` y un 200, o sea «no tienes
    // páginas» sin ningún error.
    const { f, llamadas } = redFalsa({
      '/me/accounts': { json: { data: [] } },
      '/me/assigned_pages': { json: { data: [{ ...PAGINA, access_token: 'TOKEN_PAGINA' }] } },
    });
    const paginas = await descubridorGraph({ fetch: f }).paginas({ accessToken: 'SISTEMA' });
    expect(paginas).toEqual([
      {
        paginaId: 'PG1',
        pagina: 'Tik o Cos',
        tokenDePagina: 'TOKEN_PAGINA',
        igUserId: null,
        usuario: null,
      },
    ]);
    expect(llamadas.map((l) => l.ruta.split('?')[0])).toContain('/me/assigned_pages');
  });

  it('si la página asignada no trae su token, se le pide a ella', async () => {
    // Sin token de página no se puede ni suscribirla ni responder: devolverla
    // a medias sería descubrirlo al enviar, delante de un cliente.
    const { f } = redFalsa({
      '/me/accounts': { json: { data: [] } },
      '/me/assigned_pages': { json: { data: [PAGINA] } },
      '/PG1': { json: { access_token: 'TOKEN_PEDIDO' } },
    });
    const paginas = await descubridorGraph({ fetch: f }).paginas({ accessToken: 'SISTEMA' });
    expect(paginas[0]!.tokenDePagina).toBe('TOKEN_PEDIDO');
  });

  it('sin permisos de páginas lo DICE, en vez de «no tienes ninguna»', async () => {
    // Meta responde 200 con la lista vacía cuando faltan los permisos. Decir
    // «no tienes páginas» a quien está mirando la suya es la peor respuesta.
    const { f } = redFalsa({
      '/me/accounts': { json: { data: [] } },
      '/me/assigned_pages': { json: { data: [] } },
      '/debug_token': {
        json: { data: { scopes: ['public_profile', 'whatsapp_business_messaging'] } },
      },
    });
    await expect(
      descubridorGraph({ fetch: f }).paginas({ accessToken: 'SOLO_WA' }),
    ).rejects.toMatchObject({
      codigo: 'permisos_insuficientes',
      message: expect.stringContaining('pages_show_list'),
    });
  });

  it('con los permisos puestos y sin páginas, la lista vacía es la verdad', async () => {
    const { f } = redFalsa({
      '/me/accounts': { json: { data: [] } },
      '/me/assigned_pages': { json: { data: [] } },
      '/debug_token': {
        json: {
          data: { scopes: ['pages_show_list', 'pages_messaging', 'pages_read_engagement'] },
        },
      },
    });
    expect(await descubridorGraph({ fetch: f }).paginas({ accessToken: 'OK' })).toEqual([]);
  });
});
