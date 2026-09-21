/**
 * Entrar, con y sin segundo factor.
 *
 * Se simula `fetch` y no el cliente de API: así lo que se prueba incluye el
 * cuerpo que sale de verdad hacia el servidor, que es donde estaría el fallo
 * de mandar (o no mandar) el código.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Acceso } from './Acceso.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Una respuesta JSON como la que devuelve la API. */
function respuesta(estado: number, cuerpo: unknown) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { 'content-type': 'application/json' },
  });
}

const SESION = { token: 't', tenantId: 'a', userId: 'u', rol: 'owner', expiraEn: 1 };

/** Lo que se envió en la llamada número `n` a `fetch` (empezando por 0). */
function cuerpoEnviado(n: number) {
  const espia = globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
  const init = espia.mock.calls[n]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function rellenarYEntrar(email = 'yo@x.test', clave = 'secreta-larga') {
  await userEvent.type(screen.getByLabelText('Correo'), email);
  await userEvent.type(screen.getByLabelText('Contraseña'), clave);
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('Acceso', () => {
  it('entra con la API y entrega la sesión', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuesta(201, SESION));
    const alEntrar = vi.fn();
    render(<Acceso alEntrar={alEntrar} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar();
    expect(alEntrar).toHaveBeenCalledWith({ token: 't', tenantId: 'a', userId: 'u', rol: 'owner' });
  });

  it('muestra el mensaje de la API cuando falla', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuesta(401, {
        codigo: 'credenciales_invalidas',
        mensaje: 'Correo o contraseña incorrectos.',
      }),
    );
    render(<Acceso alEntrar={vi.fn()} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar('yo@x.test', 'mala');
    expect(screen.getByRole('alert').textContent).toContain('Correo o contraseña incorrectos.');
    // Una contraseña mala no es un segundo factor pendiente.
    expect(screen.queryByLabelText('Código')).toBeNull();
  });

  // --- Verificación en dos pasos (0035) ------------------------------------

  it('sin segundo factor no se pide código y no se manda ninguno', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respuesta(201, SESION));
    render(<Acceso alEntrar={vi.fn()} alRegistrarse={vi.fn()} />);
    expect(screen.queryByLabelText('Código')).toBeNull();
    await rellenarYEntrar();
    expect(cuerpoEnviado(0)).not.toHaveProperty('codigo');
  });

  it('si el servidor lo pide, aparece el código y no se enseña como error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuesta(401, { codigo: 'codigo_requerido', mensaje: 'Escribe el código.' }),
    );
    render(<Acceso alEntrar={vi.fn()} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar();

    expect(await screen.findByLabelText('Código')).toBeTruthy();
    // La contraseña era buena: esto es el paso siguiente, no un fallo.
    expect(screen.queryByRole('alert')).toBeNull();
    // Y lo anterior desaparece: no hay dos formularios que rellenar.
    expect(screen.queryByLabelText('Contraseña')).toBeNull();
  });

  it('el segundo intento lleva el código sin reescribir la contraseña', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respuesta(401, { codigo: 'codigo_requerido', mensaje: 'Falta.' }))
      .mockResolvedValueOnce(respuesta(201, SESION));
    const alEntrar = vi.fn();
    render(<Acceso alEntrar={alEntrar} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar();

    await userEvent.type(await screen.findByLabelText('Código'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(cuerpoEnviado(1)).toEqual({
      email: 'yo@x.test',
      contrasena: 'secreta-larga',
      codigo: '123456',
    });
    expect(alEntrar).toHaveBeenCalled();
  });

  it('un código malo se dice y se vacía el campo: reenviar el mismo no sirve', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respuesta(401, { codigo: 'codigo_requerido', mensaje: 'Falta.' }))
      .mockResolvedValueOnce(
        respuesta(403, { codigo: 'codigo_invalido', mensaje: 'Ese código no es válido.' }),
      );
    render(<Acceso alEntrar={vi.fn()} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar();

    await userEvent.type(await screen.findByLabelText('Código'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no es válido');
    // Un código de autenticador caduca cada 30 segundos.
    expect((screen.getByLabelText('Código') as HTMLInputElement).value).toBe('');
  });

  it('se puede volver atrás si uno se equivocó de cuenta', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      respuesta(401, { codigo: 'codigo_requerido', mensaje: 'Falta.' }),
    );
    render(<Acceso alEntrar={vi.fn()} alRegistrarse={vi.fn()} />);
    await rellenarYEntrar();

    await userEvent.click(await screen.findByRole('button', { name: 'Usar otra cuenta' }));
    expect(screen.getByLabelText('Correo')).toBeTruthy();
    expect(screen.queryByLabelText('Código')).toBeNull();
  });
});
