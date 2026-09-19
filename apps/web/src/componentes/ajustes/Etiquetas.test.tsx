/**
 * Administrar etiquetas: renombrar, recolorear, crear y borrar. Lo que se
 * prueba es lo que protege al usuario: que antes de borrar se diga cuánto se
 * pierde, que la que usa un bot no se pueda borrar, y que un agente vea pero
 * no toque.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { EtiquetaConUso } from '../../api/tipos.ts';
import { Etiquetas } from './Etiquetas.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VIP: EtiquetaConUso = {
  id: 't1',
  nombre: 'VIP',
  color: '#ff9500',
  usos: { conversaciones: 12, clientes: 3, leads: 1 },
  bots: [],
  creadaEn: '2026-09-01T12:00:00Z',
};
const BIENVENIDA: EtiquetaConUso = {
  id: 't2',
  nombre: 'Nuevo',
  color: '#34c759',
  usos: { conversaciones: 0, clientes: 0, leads: 0 },
  bots: ['Bienvenida'],
  creadaEn: '2026-09-01T12:00:00Z',
};

function pintar(extra: Record<string, unknown> = {}, gestor = true) {
  const api = {
    etiquetasConUso: vi.fn().mockResolvedValue([VIP, BIENVENIDA]),
    editarEtiqueta: vi.fn().mockResolvedValue(undefined),
    borrarEtiqueta: vi.fn().mockResolvedValue(undefined),
    crearEtiqueta: vi.fn().mockResolvedValue({ id: 't3' }),
    ...extra,
  };
  render(<Etiquetas api={api as unknown as Api} gestor={gestor} />);
  return api;
}

describe('Ajustes → Etiquetas', () => {
  it('dice dónde se usa cada una y qué bot la usa', async () => {
    pintar();
    expect(await screen.findByText('12 conversaciones · 3 clientes · 1 lead')).toBeTruthy();
    expect(screen.getByText(/Sin usar · la usa el bot «Bienvenida»/)).toBeTruthy();
  });

  it('renombrar solo ofrece Guardar cuando cambia algo, y guarda el nombre nuevo', async () => {
    const api = pintar();
    const campo = await screen.findByLabelText('Nombre de VIP');
    expect(screen.queryByRole('button', { name: 'Guardar' })).toBeNull();
    await userEvent.clear(campo);
    await userEvent.type(campo, 'Cliente VIP');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(api.editarEtiqueta).toHaveBeenCalledWith('t1', { nombre: 'Cliente VIP' });
  });

  it('borrar avisa de lo que se pierde antes de hacerlo', async () => {
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = pintar();
    await screen.findByLabelText('Nombre de VIP');
    const [borrarVip] = screen.getAllByRole('button', { name: 'Borrar' });
    await userEvent.click(borrarVip!);
    expect(confirmar.mock.calls[0]![0]).toContain('12 conversaciones · 3 clientes · 1 lead');
    expect(api.borrarEtiqueta).toHaveBeenCalledWith('t1');
  });

  it('la que usa un bot no se puede borrar', async () => {
    pintar();
    await screen.findByLabelText('Nombre de Nuevo');
    const botones = screen.getAllByRole('button', { name: 'Borrar' }) as HTMLButtonElement[];
    expect(botones[1]!.disabled).toBe(true);
  });

  it('crear una etiqueta nueva con su color', async () => {
    const api = pintar();
    await userEvent.type(await screen.findByLabelText('Nombre de la etiqueta nueva'), 'Grupo');
    await userEvent.click(screen.getByRole('button', { name: 'Crear' }));
    expect(api.crearEtiqueta).toHaveBeenCalledWith('Grupo', '#007aff');
  });

  it('un agente las ve pero no puede cambiarlas', async () => {
    pintar({}, false);
    expect(((await screen.findByLabelText('Nombre de VIP')) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Borrar' })).toBeNull();
    expect(screen.queryByLabelText('Nombre de la etiqueta nueva')).toBeNull();
  });
});

/**
 * Buscar, filtrar por fecha, contar y paginar (PR-84).
 *
 * Lo que se prueba es lo que se pidió y lo que puede romperse sin ruido: que
 * el contador diga la verdad, que el buscador mire también los bots, y que
 * pasar de 20 parta la lista en vez de hacerla infinita.
 */
describe('Etiquetas · buscar y paginar', () => {
  const muchas = (n: number): EtiquetaConUso[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      nombre: `Etiqueta ${String(i).padStart(2, '0')}`,
      color: '#888888',
      usos: { conversaciones: 0, clientes: 0, leads: 0 },
      bots: [],
      creadaEn: '2026-09-01T12:00:00Z',
    }));

  it('el contador dice cuántas hay', async () => {
    pintar();
    expect(await screen.findByText('2 etiquetas')).toBeTruthy();
  });

  it('buscar filtra y el contador pasa a decir «X de Y»', async () => {
    pintar();
    await screen.findByDisplayValue('VIP');
    await userEvent.type(screen.getByRole('searchbox'), 'vip');

    expect(await screen.findByText('1 de 2 etiquetas')).toBeTruthy();
    expect(screen.queryByDisplayValue('Nuevo')).toBeNull();
  });

  it('encuentra por el bot que la usa, no solo por el nombre', async () => {
    pintar();
    await screen.findByDisplayValue('VIP');
    await userEvent.type(screen.getByRole('searchbox'), 'bienvenida');
    // «Nuevo» no se llama así; la pone el bot Bienvenida.
    expect(await screen.findByDisplayValue('Nuevo')).toBeTruthy();
    expect(screen.queryByDisplayValue('VIP')).toBeNull();
  });

  it('si no coincide ninguna, se dice — y no se confunde con «no hay»', async () => {
    pintar();
    await screen.findByDisplayValue('VIP');
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(await screen.findByText(/Ninguna etiqueta coincide/)).toBeTruthy();
    expect(screen.queryByText(/Todavía no hay etiquetas/)).toBeNull();
  });

  it('con pocas, ni buscador de páginas ni ruido', async () => {
    pintar();
    await screen.findByText('2 etiquetas');
    expect(screen.queryByRole('button', { name: 'Siguiente' })).toBeNull();
  });

  it('a partir de 20 se parte en páginas', async () => {
    pintar({ etiquetasConUso: vi.fn().mockResolvedValue(muchas(25)) });
    expect(await screen.findByText(/25 etiquetas · página 1 de 2/)).toBeTruthy();
    // La 00 está en la primera página; la 20 no.
    expect(screen.getByDisplayValue('Etiqueta 00')).toBeTruthy();
    expect(screen.queryByDisplayValue('Etiqueta 20')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByDisplayValue('Etiqueta 20')).toBeTruthy();
    expect(screen.queryByDisplayValue('Etiqueta 00')).toBeNull();
  });

  it('buscar desde la página 2 no deja la lista vacía', async () => {
    pintar({ etiquetasConUso: vi.fn().mockResolvedValue(muchas(25)) });
    await userEvent.click(await screen.findByRole('button', { name: 'Siguiente' }));
    await screen.findByDisplayValue('Etiqueta 20');

    // Sin volver a la página 1, el resultado caería fuera de rango y la lista
    // saldría vacía sin explicar por qué.
    // Se teclea «03» y no «Etiqueta 03»: lo segundo dejaría al propio
    // buscador con ese valor y la búsqueda del test encontraría dos campos.
    await userEvent.type(screen.getByRole('searchbox'), '03');
    expect(await screen.findByDisplayValue('Etiqueta 03')).toBeTruthy();
  });

  it('«Quitar filtros» solo sale cuando hay algo que quitar', async () => {
    pintar();
    await screen.findByDisplayValue('VIP');
    expect(screen.queryByRole('button', { name: 'Quitar filtros' })).toBeNull();

    await userEvent.type(screen.getByRole('searchbox'), 'vip');
    await userEvent.click(await screen.findByRole('button', { name: 'Quitar filtros' }));
    expect(await screen.findByDisplayValue('Nuevo')).toBeTruthy();
  });

  it('el filtro de fechas esconde lo que cae fuera', async () => {
    pintar();
    await screen.findByDisplayValue('VIP');
    // Todas son del 1 de septiembre: pedir desde octubre no deja ninguna.
    await userEvent.type(screen.getByLabelText('Desde'), '2026-10-01');
    expect(await screen.findByText(/Ninguna etiqueta coincide/)).toBeTruthy();
  });
});
