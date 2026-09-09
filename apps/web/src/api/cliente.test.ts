import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearApi, ErrorDeApi, peticion } from './cliente.ts';

function respuesta(status: number, cuerpo: unknown) {
  return new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('peticion', () => {
  it('manda la sesión y devuelve el JSON', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuesta(200, { ok: 1 }));
    const r = await peticion<{ ok: number }>('/v1/yo', { token: 'abc' });
    expect(r).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/v1/yo');
    expect((init!.headers as Record<string, string>)['authorization']).toBe('Bearer abc');
  });

  it('un error de negocio llega como ErrorDeApi con código y detalle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuesta(409, {
        codigo: 'fuera_de_ventana',
        mensaje: 'La ventana está cerrada.',
        plantillasSugeridas: [{ id: '1', nombre: 'bienvenida', idioma: 'es' }],
      }),
    );
    const e = (await peticion('/v1/x', { metodo: 'POST', cuerpo: {} }).catch(
      (x) => x,
    )) as ErrorDeApi;
    expect(e).toBeInstanceOf(ErrorDeApi);
    expect(e.estado).toBe(409);
    expect(e.codigo).toBe('fuera_de_ventana');
    expect(e.message).toBe('La ventana está cerrada.');
    expect(e.detalle.plantillasSugeridas).toHaveLength(1);
  });

  it('204 devuelve undefined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    expect(await peticion('/v1/x', { metodo: 'DELETE' })).toBeUndefined();
  });
});

describe('crearApi', () => {
  it('construye la consulta de la bandeja sin filtros vacíos', async () => {
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => respuesta(200, { items: [], siguienteCursor: null }));
    await crearApi('t').conversaciones({
      canal: 'whatsapp',
      sinRespuesta: true,
      etiquetaId: undefined,
    });
    expect(f.mock.calls[0]![0]).toBe('/api/v1/conversaciones?canal=whatsapp&sinRespuesta=true');
    await crearApi('t').conversaciones({ sinRespuesta: false });
    expect(f.mock.calls[1]![0]).toBe('/api/v1/conversaciones');
  });
});
