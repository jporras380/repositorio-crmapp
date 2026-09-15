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
};
const BIENVENIDA: EtiquetaConUso = {
  id: 't2',
  nombre: 'Nuevo',
  color: '#34c759',
  usos: { conversaciones: 0, clientes: 0, leads: 0 },
  bots: ['Bienvenida'],
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
