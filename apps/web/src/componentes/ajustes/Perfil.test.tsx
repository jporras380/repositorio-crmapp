/**
 * Mi cuenta.
 *
 * Lo que se prueba es lo que protege la cuenta: que cambiar el correo o la
 * contraseña exija la de ahora, que se avise de cuántas sesiones se cerraron,
 * y que la sesión actual nunca ofrezca un botón de cerrarse a sí misma.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { Perfil } from './Perfil.tsx';

afterEach(cleanup);

const SESIONES = [
  {
    id: 's1',
    ip: '190.12.3.4',
    dispositivo: 'Chrome en Windows',
    ultimaVezEn: new Date().toISOString(),
    creadaEn: new Date().toISOString(),
    esLaActual: true,
  },
  {
    id: 's2',
    ip: '201.0.0.9',
    dispositivo: 'PC de recepcion',
    ultimaVezEn: new Date(Date.now() - 7_200_000).toISOString(),
    creadaEn: new Date(Date.now() - 86_400_000).toISOString(),
    esLaActual: false,
  },
];

function apiFalsa(extra: Record<string, unknown> = {}): Api {
  return {
    perfil: vi.fn().mockResolvedValue({
      userId: 'u1',
      nombre: 'Rosa Jefa',
      email: 'rosa@hotel.test',
      fotoId: null,
      dobleFactor: false,
    }),
    sesiones: vi.fn().mockResolvedValue(SESIONES),
    editarPerfil: vi.fn().mockResolvedValue(undefined),
    cambiarAcceso: vi.fn().mockResolvedValue({ sesionesCerradas: 2 }),
    cerrarSesion: vi.fn().mockResolvedValue({ cerradas: 1 }),
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'blob:x', expiraEnSegundos: 300, mime: null }),
    ...extra,
  } as unknown as Api;
}

describe('Perfil', () => {
  it('lista las sesiones y NO ofrece cerrar la actual', async () => {
    render(<Perfil api={apiFalsa()} />);
    expect(await screen.findByText('Chrome en Windows')).toBeTruthy();
    expect(screen.getByText('PC de recepcion')).toBeTruthy();
    // Un botón «Cerrar» por sesión ajena: la propia no se ofrece.
    expect(screen.getAllByRole('button', { name: 'Cerrar' })).toHaveLength(1);
  });

  it('cerrar una sesión se la pide al servidor por su id', async () => {
    const api = apiFalsa();
    render(<Perfil api={api} />);
    await screen.findByText('PC de recepcion');
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(api.cerrarSesion).toHaveBeenCalledWith('s2');
  });

  it('sin la contraseña de ahora no se puede cambiar nada de las llaves', async () => {
    render(<Perfil api={apiFalsa()} />);
    await screen.findByText('Chrome en Windows');
    const guardar = screen.getByRole('button', { name: 'Guardar cambios' });
    expect((guardar as HTMLButtonElement).disabled).toBe(true);

    // Con contraseña actual pero sin cambiar nada, sigue sin tener sentido.
    await userEvent.type(screen.getByLabelText('Contraseña actual'), 'la-de-ahora');
    expect((guardar as HTMLButtonElement).disabled).toBe(true);
  });

  it('al cambiar la contraseña dice cuántas sesiones se cerraron', async () => {
    const api = apiFalsa();
    render(<Perfil api={api} />);
    await screen.findByText('Chrome en Windows');
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), 'otra-mucho-mas-larga');
    await userEvent.type(screen.getByLabelText('Contraseña actual'), 'la-de-ahora');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect(api.cambiarAcceso).toHaveBeenCalledWith({
      contrasenaActual: 'la-de-ahora',
      contrasenaNueva: 'otra-mucho-mas-larga',
    });
    // Que lo diga importa: el agente acaba de echar a sus otros dispositivos.
    expect(await screen.findByText(/se cerraron 2 sesión/i)).toBeTruthy();
  });

  it('si el servidor rechaza la contraseña, se ve el motivo', async () => {
    const api = apiFalsa({
      cambiarAcceso: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(403, 'contrasena_incorrecta', 'La contraseña actual no es esa.'),
        ),
    });
    render(<Perfil api={api} />);
    await screen.findByText('Chrome en Windows');
    await userEvent.type(screen.getByLabelText(/Contraseña nueva/), 'otra-mucho-mas-larga');
    await userEvent.type(screen.getByLabelText('Contraseña actual'), 'me-la-invento');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no es esa');
  });

  it('el nombre se guarda al salir del campo, sin pedir contraseña', async () => {
    const api = apiFalsa();
    render(<Perfil api={api} />);
    const campo = await screen.findByLabelText('Nombre');
    await userEvent.clear(campo);
    await userEvent.type(campo, 'Rosa Quispe');
    await userEvent.tab();
    expect(api.editarPerfil).toHaveBeenCalledWith({ nombre: 'Rosa Quispe' });
  });
});

/**
 * Verificación en dos pasos (0035).
 *
 * Lo que se prueba es que nadie se quede fuera de su cuenta por descuido de
 * esta pantalla: que no se active hasta comprobar un código, que los códigos
 * de recuperación se vean antes de poder seguir, y que quitarla pida la
 * contraseña.
 */
describe('Perfil · dos pasos', () => {
  const CON_DOS_PASOS = {
    userId: 'u1',
    nombre: 'Rosa Jefa',
    email: 'rosa@hotel.test',
    fotoId: null,
    dobleFactor: true,
  };

  function apiConDosPasos(extra: Record<string, unknown> = {}) {
    return apiFalsa({
      prepararDosPasos: vi
        .fn()
        .mockResolvedValue({ secreto: 'JBSWY3DPEHPK3PXP', enlace: 'otpauth://totp/CRM:rosa' }),
      confirmarDosPasos: vi
        .fn()
        .mockResolvedValue({ codigosDeRecuperacion: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] }),
      quitarDosPasos: vi.fn().mockResolvedValue(undefined),
      ...extra,
    });
  }

  it('apagada, se ofrece activarla y nada más', async () => {
    render(<Perfil api={apiConDosPasos()} />);
    expect(await screen.findByRole('button', { name: 'Activar' })).toBeTruthy();
    expect(screen.queryByLabelText('Código de la aplicación')).toBeNull();
  });

  it('preparar enseña la clave en grupos y NO la activa', async () => {
    const api = apiConDosPasos();
    render(<Perfil api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activar' }));

    // En grupos de cuatro: se teclea a mano mirando esta pantalla.
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(api.confirmarDosPasos).not.toHaveBeenCalled();
    // El hueco del QR se admite en pantalla, no se esconde.
    expect(screen.getByText(/código QR/)).toBeTruthy();
  });

  it('confirmar manda el código y enseña los de recuperación una sola vez', async () => {
    const api = apiConDosPasos();
    render(<Perfil api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activar' }));
    await userEvent.type(await screen.findByLabelText('Código de la aplicación'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar y activar' }));

    expect(api.confirmarDosPasos).toHaveBeenCalledWith('123456');
    expect(await screen.findByText('AAAAA-BBBBB')).toBeTruthy();
    expect(screen.getByText('CCCCC-DDDDD')).toBeTruthy();
    // Con un aviso que dice que no vuelven, porque no vuelven.
    expect(screen.getByText(/única vez que se muestran/)).toBeTruthy();
  });

  it('un código corto no deja pulsar: seis dígitos o nada', async () => {
    render(<Perfil api={apiConDosPasos()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activar' }));
    await userEvent.type(await screen.findByLabelText('Código de la aplicación'), '123');
    expect(
      (screen.getByRole('button', { name: 'Confirmar y activar' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('si el código falla, se dice y se vacía el campo', async () => {
    const api = apiConDosPasos({
      confirmarDosPasos: vi
        .fn()
        .mockRejectedValue(new ErrorDeApi(403, 'codigo_invalido', 'Ese código no es válido.')),
    });
    render(<Perfil api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activar' }));
    const campo = await screen.findByLabelText('Código de la aplicación');
    await userEvent.type(campo, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar y activar' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no es válido');
    expect((campo as HTMLInputElement).value).toBe('');
  });

  it('activada, quitarla exige la contraseña', async () => {
    const api = apiConDosPasos({
      perfil: vi.fn().mockResolvedValue(CON_DOS_PASOS),
    });
    render(<Perfil api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));

    await userEvent.type(screen.getByLabelText('Tu contraseña'), 'secreta-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    expect(api.quitarDosPasos).toHaveBeenCalledWith('secreta-larga');
  });

  it('sin contraseña no se puede desactivar ni por descuido', async () => {
    const api = apiConDosPasos({ perfil: vi.fn().mockResolvedValue(CON_DOS_PASOS) });
    render(<Perfil api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    expect((screen.getByRole('button', { name: 'Desactivar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(api.quitarDosPasos).not.toHaveBeenCalled();
  });
});
