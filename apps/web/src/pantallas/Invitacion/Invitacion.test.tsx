/**
 * Aceptar una invitación.
 *
 * Lo que se prueba es lo que hace que el enlace sirva para algo: que el token
 * del hash llegue al servidor tal cual, que no se pida el correo —ya lo
 * eligió quien invitó— y que un enlace muerto lo diga en vez de dejar a la
 * persona mirando un formulario que nunca va a funcionar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as cliente from '../../api/cliente.ts';
import { Invitacion } from './Invitacion.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pintar(aceptar = vi.fn().mockResolvedValue({ token: 't', rol: 'agent' })) {
  const alEntrar = vi.fn();
  vi.spyOn(cliente, 'crearApi').mockReturnValue({
    aceptarInvitacion: aceptar,
  } as unknown as cliente.Api);
  render(<Invitacion token="un-token-largo" alEntrar={alEntrar} alVolver={vi.fn()} />);
  return { aceptar, alEntrar };
}

describe('Aceptar una invitación', () => {
  it('no pide el correo: ya lo eligió quien invitó', () => {
    pintar();
    // Pedirlo otra vez solo abre la puerta a escribir uno distinto del que
    // se aprobó.
    expect(screen.queryByLabelText(/[Cc]orreo/)).toBeNull();
    expect(screen.getByLabelText(/Tu nombre/)).toBeTruthy();
  });

  it('manda el token del enlace, el nombre y la contraseña', async () => {
    const { aceptar } = pintar();
    await userEvent.type(screen.getByLabelText(/Tu nombre/), 'Marta Quispe');
    await userEvent.type(screen.getByLabelText(/Contraseña/), 'contrasena-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() =>
      expect(aceptar).toHaveBeenCalledWith({
        token: 'un-token-largo',
        contrasena: 'contrasena-larga',
        nombreCompleto: 'Marta Quispe',
      }),
    );
  });

  it('se entra directo: aceptar ya devuelve sesión', async () => {
    const { alEntrar } = pintar();
    await userEvent.type(screen.getByLabelText(/Tu nombre/), 'Marta');
    await userEvent.type(screen.getByLabelText(/Contraseña/), 'contrasena-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    // Mandarla al formulario de acceso sería pedirle la contraseña que acaba
    // de escribir.
    await waitFor(() => expect(alEntrar).toHaveBeenCalled());
  });

  it('una contraseña corta se avisa ANTES de pulsar, no tras el rechazo', async () => {
    pintar();
    await userEvent.type(screen.getByLabelText(/Contraseña/), 'corta');
    expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('un enlace caducado lo dice, y no deja un formulario inútil a la vista', async () => {
    const { aceptar } = pintar(
      vi
        .fn()
        .mockRejectedValue(new cliente.ErrorDeApi(410, 'caducada', 'La invitación ha caducado.')),
    );
    await userEvent.type(screen.getByLabelText(/Tu nombre/), 'Marta');
    await userEvent.type(screen.getByLabelText(/Contraseña/), 'contrasena-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ha caducado');
    expect(aceptar).toHaveBeenCalled();
  });
});
