import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Acceso } from './Acceso.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Acceso', () => {
  it('entra con la API y entrega la sesión', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ token: 't', tenantId: 'a', userId: 'u', rol: 'owner', expiraEn: 1 }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const alEntrar = vi.fn();
    render(<Acceso alEntrar={alEntrar} />);
    await userEvent.type(screen.getByLabelText('Correo'), 'yo@x.test');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'secreta-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(alEntrar).toHaveBeenCalledWith({ token: 't', tenantId: 'a', userId: 'u', rol: 'owner' });
  });

  it('muestra el mensaje de la API cuando falla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          codigo: 'credenciales_invalidas',
          mensaje: 'Correo o contraseña incorrectos.',
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    render(<Acceso alEntrar={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Correo'), 'yo@x.test');
    await userEvent.type(screen.getByLabelText('Contraseña'), 'mala');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByRole('alert').textContent).toContain('Correo o contraseña incorrectos.');
  });
});
