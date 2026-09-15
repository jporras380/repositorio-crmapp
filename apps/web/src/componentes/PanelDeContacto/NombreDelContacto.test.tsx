/**
 * Cambiar el nombre del contacto desde la ficha de la conversación.
 *
 * Lo que importa: que se guarde el nombre de la PERSONA (no el perfil de
 * WhatsApp), que la bandeja se refresque para enseñarlo, y que vaciarlo
 * devuelva el número o el @usuario en vez de dejar un hueco.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import { NombreDelContacto } from './NombreDelContacto.tsx';

afterEach(cleanup);

function pintar(editarCliente = vi.fn().mockResolvedValue({ editado: true })) {
  const alGuardar = vi.fn();
  render(
    <NombreDelContacto
      api={{ editarCliente } as unknown as Api}
      contactoId="c1"
      nombre="Rosa"
      handle="+51999888777 · @rosa.viajera"
      alGuardar={alGuardar}
    />,
  );
  return { editarCliente, alGuardar };
}

describe('NombreDelContacto', () => {
  it('guarda el nombre nuevo del contacto y avisa para refrescar la bandeja', async () => {
    const { editarCliente, alGuardar } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar el nombre' }));
    const campo = screen.getByLabelText('Nombre del contacto');
    await userEvent.clear(campo);
    await userEvent.type(campo, 'Rosa · reserva julio');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(editarCliente).toHaveBeenCalledWith('c1', { nombre: 'Rosa · reserva julio' });
    expect(alGuardar).toHaveBeenCalled();
  });

  it('vaciarlo quita el nombre propio: se vuelve a ver el número o el @usuario', async () => {
    const { editarCliente } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar el nombre' }));
    await userEvent.clear(screen.getByLabelText('Nombre del contacto'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(editarCliente).toHaveBeenCalledWith('c1', { nombre: null });
  });

  it('Escape cancela sin guardar', async () => {
    const { editarCliente } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar el nombre' }));
    await userEvent.type(screen.getByLabelText('Nombre del contacto'), ' algo{Escape}');
    expect(editarCliente).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Rosa' })).toBeTruthy();
  });

  it('si falla, lo dice y deja la edición abierta', async () => {
    pintar(vi.fn().mockRejectedValue(new Error('El contacto no existe.')));
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar el nombre' }));
    await userEvent.type(screen.getByLabelText('Nombre del contacto'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('El contacto no existe.');
    expect(screen.getByLabelText('Nombre del contacto')).toBeTruthy();
  });
});
