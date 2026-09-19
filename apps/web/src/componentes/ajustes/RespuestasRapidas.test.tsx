/**
 * Respuestas rápidas.
 *
 * Lo que se prueba es lo que se pidió —buscar, filtrar por fecha, contar,
 * paginar y adjuntar una imagen— y lo que puede romperse sin hacer ruido: que
 * el contador diga la verdad y que quitar la imagen la quite de verdad, en vez
 * de dejarla porque «no se tocó el campo».
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { RespuestaRapida } from '../../api/tipos.ts';
import { RespuestasRapidas } from './RespuestasRapidas.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BIENVENIDA: RespuestaRapida = {
  id: 'q1',
  atajo: '/bienvenida',
  titulo: 'Saludo inicial',
  cuerpo: 'Hola, gracias por escribir al Paraíso de Barranca.',
  medioId: null,
  version: 1,
  actualizadoEn: '2026-09-01T12:00:00Z',
};
const ENVIO: RespuestaRapida = {
  id: 'q2',
  atajo: '/envio',
  titulo: 'Cómo llegar',
  cuerpo: 'Estamos a diez minutos de la plaza; hacemos envío a Trujillo.',
  medioId: 'm9',
  version: 3,
  actualizadoEn: '2026-09-18T12:00:00Z',
};

function pintar(extra: Record<string, unknown> = {}, gestor = true) {
  const api = {
    respuestasRapidas: vi.fn().mockResolvedValue([BIENVENIDA, ENVIO]),
    crearRapida: vi.fn().mockResolvedValue(BIENVENIDA),
    editarRapida: vi.fn().mockResolvedValue(BIENVENIDA),
    archivarRapida: vi.fn().mockResolvedValue(undefined),
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'blob:foto', expiraEnSegundos: 300, mime: null }),
    prepararSubida: vi.fn().mockResolvedValue({ mediaAssetId: 'nuevo1', urlDeSubida: 'http://s3' }),
    confirmarSubida: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as Api;
  render(<RespuestasRapidas api={api} gestor={gestor} />);
  return api;
}

describe('Respuestas rápidas · buscar, contar y paginar', () => {
  const muchas = (n: number): RespuestaRapida[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      atajo: `/atajo${String(i).padStart(2, '0')}`,
      titulo: `Respuesta ${String(i).padStart(2, '0')}`,
      cuerpo: 'texto',
      medioId: null,
      version: 1,
      actualizadoEn: '2026-09-01T12:00:00Z',
    }));

  it('el contador dice cuántas hay', async () => {
    pintar();
    expect(await screen.findByText('2 respuestas')).toBeTruthy();
  });

  it('con una sola, lo dice en singular: «1 respuestas» canta', async () => {
    pintar({ respuestasRapidas: vi.fn().mockResolvedValue([BIENVENIDA]) });
    expect(await screen.findByText('1 respuesta')).toBeTruthy();
  });

  it('busca en el TEXTO, no solo en el atajo', async () => {
    pintar();
    await screen.findByText('Saludo inicial');
    // Quien se acuerda de «Trujillo» está pensando en lo que dice la
    // respuesta, no en cómo la llamó hace tres meses.
    await userEvent.type(screen.getByRole('searchbox'), 'trujillo');

    expect(await screen.findByText('Cómo llegar')).toBeTruthy();
    expect(screen.queryByText('Saludo inicial')).toBeNull();
    expect(screen.getByText('1 de 2 respuestas')).toBeTruthy();
  });

  it('encuentra sin tildes y con palabras sueltas', async () => {
    pintar();
    await screen.findByText('Saludo inicial');
    await userEvent.type(screen.getByRole('searchbox'), 'paraiso gracias');
    expect(await screen.findByText('Saludo inicial')).toBeTruthy();
  });

  it('el filtro por fechas deja solo lo del rango', async () => {
    pintar();
    await screen.findByText('Saludo inicial');
    await userEvent.type(screen.getByLabelText('Desde'), '2026-09-10');
    // «Cómo llegar» es del 18; el saludo, del 1.
    expect(await screen.findByText('Cómo llegar')).toBeTruthy();
    expect(screen.queryByText('Saludo inicial')).toBeNull();
  });

  it('a partir de 20 se parte en páginas', async () => {
    pintar({ respuestasRapidas: vi.fn().mockResolvedValue(muchas(25)) });
    expect(await screen.findByText(/25 respuestas · página 1 de 2/)).toBeTruthy();
    expect(screen.queryByText('Respuesta 20')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByText('Respuesta 20')).toBeTruthy();
  });

  it('si no coincide ninguna se dice, y no es lo mismo que «todavía no hay»', async () => {
    pintar();
    await screen.findByText('Saludo inicial');
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(await screen.findByText(/Ninguna respuesta coincide/)).toBeTruthy();
    expect(screen.queryByText(/Todavía no hay/)).toBeNull();
  });
});

describe('Respuestas rápidas · imagen adjunta', () => {
  it('subir una imagen la guarda con la respuesta', async () => {
    const api = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Nueva respuesta' }));

    // El PUT del archivo va directo a S3 y no pasa por el cliente de la API.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const archivo = new File(['x'], 'mapa.png', { type: 'image/png' });
    await userEvent.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      archivo,
    );

    // Se sube ANTES de guardar: así una foto por datos móviles no parece un
    // formulario colgado al pulsar «Crear».
    await waitFor(() => expect(api.confirmarSubida).toHaveBeenCalledWith('nuevo1'));

    // La etiqueta lleva pegado su texto de ayuda, así que no coincide exacto.
    await userEvent.type(screen.getByLabelText(/^Atajo/), 'mapa');
    await userEvent.type(screen.getByLabelText('Título'), 'Cómo llegar');
    await userEvent.click(screen.getByRole('button', { name: 'Crear respuesta' }));

    expect(api.crearRapida).toHaveBeenCalledWith(
      expect.objectContaining({ mediaAssetId: 'nuevo1' }),
    );
  });

  it('la que ya tiene imagen enseña su miniatura', async () => {
    const api = pintar();
    await screen.findByText('Cómo llegar');
    const fila = screen.getByText('Cómo llegar').closest('article')!;
    await userEvent.click(fila.querySelector('button')!);

    await waitFor(() => expect(api.urlDeMedio).toHaveBeenCalledWith('m9'));
    expect(await screen.findByRole('button', { name: 'Cambiar imagen' })).toBeTruthy();
  });

  it('quitar la imagen la quita de verdad al guardar', async () => {
    const api = pintar();
    await screen.findByText('Cómo llegar');
    const fila = screen.getByText('Cómo llegar').closest('article')!;
    await userEvent.click(fila.querySelector('button')!);

    await userEvent.click(await screen.findByRole('button', { name: 'Quitar imagen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    // `null` y no «no lo toques»: el servidor distingue las dos cosas, y con
    // `undefined` la imagen se habría quedado puesta.
    expect(api.editarRapida).toHaveBeenCalledWith(
      'q2',
      expect.objectContaining({ mediaAssetId: null }),
    );
  });
});
