/**
 * Ficha de un tipo de habitación.
 *
 * Lo que se prueba es el borrado que faltaba —se podían crear tipos y no
 * quitarlos, y era la deuda con nombre más vieja de la guarda— y la línea
 * que lo hace seguro: solo se ofrece cuando no hay nada que perder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Habitacion, TipoDeHabitacion } from '../../api/tipos.ts';
import { FichaDeTipo } from './FichaDeTipo.tsx';

afterEach(cleanup);

function tipo(p: Partial<TipoDeHabitacion> = {}): TipoDeHabitacion {
  return {
    id: 't1',
    nombre: 'Bungalow Matrimonial',
    descripcion: null,
    capacidad: 2,
    precioBase: 18000,
    moneda: 'PEN',
    activo: true,
    habitaciones: [],
    tarifas: [],
    ...p,
  };
}

const HABITACION = { id: 'h1', nombre: '101', estado: 'disponible', notas: null } as Habitacion;

function pintar(t = tipo(), puedeEditar = true, extra: Record<string, unknown> = {}) {
  const api = {
    borrarTipo: vi.fn().mockResolvedValue(undefined),
    editarTipo: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as Api;
  const alBorrar = vi.fn();
  render(
    <FichaDeTipo
      api={api}
      tipo={t}
      puedeEditar={puedeEditar}
      alCambiar={vi.fn()}
      alBorrar={alBorrar}
    />,
  );
  return { api, alBorrar };
}

describe('Borrar un tipo de habitación', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('sin habitaciones se puede borrar', async () => {
    const { api, alBorrar } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Borrar tipo' }));
    await waitFor(() => expect(api.borrarTipo).toHaveBeenCalledWith('t1'));
    // Borrado deja de existir: la pantalla tiene que dejar de enseñarlo.
    await waitFor(() => expect(alBorrar).toHaveBeenCalled());
  });

  it('CON habitaciones no se ofrece: el servidor lo rechazaría igual', async () => {
    pintar(tipo({ habitaciones: [HABITACION] }));
    // Enseñar un botón que siempre falla con 409 es peor que no tenerlo.
    expect(screen.queryByRole('button', { name: 'Borrar tipo' })).toBeNull();
    // Y sigue estando la salida que sí funciona.
    expect(screen.getByRole('button', { name: 'Archivar tipo' })).toBeTruthy();
  });

  it('archivar sigue siendo la salida para uno que se usa', async () => {
    const { api } = pintar(tipo({ habitaciones: [HABITACION] }));
    await userEvent.click(screen.getByRole('button', { name: 'Archivar tipo' }));
    await waitFor(() => expect(api.editarTipo).toHaveBeenCalledWith('t1', { activo: false }));
  });

  it('cancelar no borra nada', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { api } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Borrar tipo' }));
    expect(api.borrarTipo).not.toHaveBeenCalled();
  });

  it('quien no administra no ve ninguno de los dos', () => {
    pintar(tipo(), false);
    expect(screen.queryByRole('button', { name: 'Borrar tipo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archivar/ })).toBeNull();
  });

  it('si el servidor lo rechaza, se dice con sus palabras', async () => {
    pintar(tipo(), true, {
      borrarTipo: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(409, 'tipo_con_habitaciones', 'Este tipo tiene 3 habitación(es).'),
        ),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Borrar tipo' }));
    expect(await screen.findByText(/3 habitación/)).toBeTruthy();
  });
});
