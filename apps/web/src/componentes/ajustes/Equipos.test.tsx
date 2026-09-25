/**
 * Equipos de la cuenta.
 *
 * Lo que se prueba es lo que los hace servir para algo: que se puedan montar,
 * que se vea cuáles llevan trabajo, y que borrar uno diga qué pasa con sus
 * conversaciones antes de hacerlo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EquipoDeLaCuenta } from '../../api/tipos.ts';
import { Equipos } from './Equipos.tsx';

afterEach(cleanup);

const PERSONAS = [
  { userId: 'u1', nombre: 'Rosa', rol: 'owner' },
  { userId: 'u2', nombre: 'Marta', rol: 'agent' },
];

const RECEPCION: EquipoDeLaCuenta = {
  id: 'e1',
  nombre: 'Recepción',
  miembros: [{ userId: 'u2', nombre: 'Marta', rol: 'agent' }],
  abiertas: 3,
};

function pintar(equipos: EquipoDeLaCuenta[], gestor = true, extra: Record<string, unknown> = {}) {
  const api = {
    equipos: vi.fn().mockResolvedValue(equipos),
    crearEquipo: vi.fn().mockResolvedValue(equipos),
    renombrarEquipo: vi.fn().mockResolvedValue(equipos),
    borrarEquipo: vi.fn().mockResolvedValue([]),
    cambiarMiembroDeEquipo: vi.fn().mockResolvedValue(equipos),
    ...extra,
  } as unknown as Api;
  render(<Equipos api={api} gestor={gestor} personas={PERSONAS} />);
  return api;
}

describe('Equipos', () => {
  it('sin ninguno, dice para qué sirven en vez de dejar un hueco', async () => {
    pintar([]);
    // Es la frase que conecta esta pantalla con la de visibilidad.
    expect(await screen.findByText(/no puede repartirse por equipos/)).toBeTruthy();
  });

  it('enseña cuántas conversaciones lleva: es lo que dice si está vivo', async () => {
    pintar([RECEPCION]);
    expect(await screen.findByText('Recepción')).toBeTruthy();
    expect(screen.getByText('3 abiertas')).toBeTruthy();
    expect(screen.getByText('1 persona')).toBeTruthy();
  });

  it('crear uno lo manda con su nombre', async () => {
    const api = pintar([]);
    await screen.findByText(/no puede repartirse/);
    await userEvent.type(screen.getByPlaceholderText('Recepción'), 'Reservas');
    await userEvent.click(screen.getByRole('button', { name: 'Crear equipo' }));
    await waitFor(() => expect(api.crearEquipo).toHaveBeenCalledWith('Reservas'));
  });

  it('desplegar enseña a quién se puede meter, y quién ya está', async () => {
    pintar([RECEPCION]);
    await userEvent.click(await screen.findByRole('button', { name: /^Recepción/ }));
    const marta = screen.getByRole('checkbox', { name: /Marta/ }) as HTMLInputElement;
    const rosa = screen.getByRole('checkbox', { name: /Rosa/ }) as HTMLInputElement;
    expect(marta.checked).toBe(true);
    expect(rosa.checked).toBe(false);
  });

  it('marcar a alguien lo mete en ESE equipo', async () => {
    const api = pintar([RECEPCION]);
    await userEvent.click(await screen.findByRole('button', { name: /^Recepción/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Rosa/ }));
    await waitFor(() => expect(api.cambiarMiembroDeEquipo).toHaveBeenCalledWith('e1', 'u1', true));
  });

  it('quien no gestiona los ve pero no los toca', async () => {
    pintar([RECEPCION], false);
    await screen.findByText('Recepción');
    expect(screen.queryByRole('button', { name: /^Borrar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Crear equipo' })).toBeNull();
  });

  it('un nombre repetido se dice con las palabras del servidor', async () => {
    pintar([RECEPCION], true, {
      crearEquipo: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(409, 'equipo_repetido', 'Ya hay un equipo con ese nombre.'),
        ),
    });
    await screen.findByText('Recepción');
    await userEvent.type(screen.getByPlaceholderText('Recepción'), 'Recepción');
    await userEvent.click(screen.getByRole('button', { name: 'Crear equipo' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Ya hay un equipo');
  });
});

describe('Borrar un equipo', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('avisa de QUÉ pasa con sus conversaciones antes de borrarlo', async () => {
    const api = pintar([RECEPCION]);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Borrar el equipo Recepción' }),
    );

    // Lo que se teme al borrar algo con trabajo encima es perderlo. No se
    // pierde, y el aviso lo dice antes, no después.
    const aviso = (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!;
    expect(aviso).toContain('3 conversaciones abiertas');
    expect(aviso).toContain('No se cierran');
    await waitFor(() => expect(api.borrarEquipo).toHaveBeenCalledWith('e1'));
  });

  it('uno sin conversaciones no asusta con un aviso largo', async () => {
    pintar([{ ...RECEPCION, abiertas: 0 }]);
    await userEvent.click(await screen.findByRole('button', { name: /Borrar el equipo/ }));
    const aviso = (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!;
    expect(aviso).not.toContain('No se cierran');
  });

  it('cancelar no borra nada', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = pintar([RECEPCION]);
    await userEvent.click(await screen.findByRole('button', { name: /Borrar el equipo/ }));
    expect(api.borrarEquipo).not.toHaveBeenCalled();
  });
});
