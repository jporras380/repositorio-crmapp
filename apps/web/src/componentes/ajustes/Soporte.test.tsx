/**
 * Acceso de soporte, visto por el cliente.
 *
 * Lo que se prueba es lo que protege a sus huéspedes: que el motivo se lea
 * antes de decidir, que abrir sea un gesto deliberado con plazo, que se pueda
 * cerrar al momento, y que quede dicho en pantalla que soporte no puede
 * escribir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PermisoDeSoporte } from '../../api/tipos.ts';
import { Soporte } from './Soporte.tsx';

afterEach(cleanup);

const ahora = Date.now();

function permiso(p: Partial<PermisoDeSoporte> = {}): PermisoDeSoporte {
  return {
    id: 'g1',
    motivo: 'Dicen que no les llegan los mensajes de WhatsApp desde ayer.',
    pedidoPor: 'Enrique (soporte)',
    pedidoEn: new Date(ahora - 600_000).toISOString(),
    aprobadoEn: null,
    expiraEn: null,
    revocadoEn: null,
    estado: 'pendiente',
    ...p,
  };
}

function pintar(permisos: PermisoDeSoporte[], gestor = true, extra: Record<string, unknown> = {}) {
  const api = {
    permisosDeSoporte: vi.fn().mockResolvedValue(permisos),
    // El chat vive en esta misma pantalla desde 0043: sin estos, su propio
    // error taparía al que se está probando.
    mensajesDeSoporte: vi.fn().mockResolvedValue([]),
    escribirASoporte: vi.fn().mockResolvedValue([]),
    aprobarSoporte: vi.fn().mockResolvedValue(permisos),
    revocarSoporte: vi.fn().mockResolvedValue(permisos),
    ...extra,
  } as unknown as Api;
  render(<Soporte api={api} gestor={gestor} />);
  return api;
}

describe('Acceso de soporte', () => {
  it('dice en pantalla que soporte no puede escribir', async () => {
    pintar([]);
    // Es lo que hace aceptable abrir la puerta, y tiene que estar a la vista
    // en el momento de decidir, no en unas condiciones que nadie lee.
    expect(await screen.findByText(/no puede escribir nada/)).toBeTruthy();
  });

  it('sin solicitudes, lo dice y no deja una pantalla vacía', async () => {
    pintar([]);
    expect(await screen.findByText(/Nadie ha pedido entrar/)).toBeTruthy();
  });

  it('una solicitud enseña QUIÉN pide y PARA QUÉ', async () => {
    pintar([permiso()]);
    expect(await screen.findByText(/Enrique \(soporte\) pide entrar/)).toBeTruthy();
    // El motivo es lo único que hay para decidir.
    expect(screen.getByText(/no les llegan los mensajes/)).toBeTruthy();
  });

  it('abrir exige elegir un plazo: no hay un botón de «sí» a secas', async () => {
    const api = pintar([permiso()]);
    await screen.findByText(/pide entrar/);

    expect(screen.getByRole('button', { name: 'Dejar 1 hora' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dejar 24 horas' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Aceptar$/ })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Dejar 4 horas' }));
    expect(api.aprobarSoporte).toHaveBeenCalledWith('g1', 4);
  });

  it('rechazar usa el mismo camino que cerrar: se cierra la puerta', async () => {
    const api = pintar([permiso()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Rechazar' }));
    expect(api.revocarSoporte).toHaveBeenCalledWith('g1');
  });

  it('con un acceso abierto se dice que están mirando AHORA', async () => {
    pintar([
      permiso({
        estado: 'activo',
        aprobadoEn: new Date(ahora - 60_000).toISOString(),
        expiraEn: new Date(ahora + 3_600_000).toISOString(),
      }),
    ]);
    expect(await screen.findByText(/está viendo tu cuenta/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cerrar el acceso ahora' })).toBeTruthy();
  });

  it('un agente ve lo que pasa pero no decide', async () => {
    pintar([permiso()], false);
    expect(await screen.findByText(/pide entrar/)).toBeTruthy();
    // Dejar entrar a la correspondencia de los huéspedes no es decisión de
    // cualquiera del equipo.
    expect(screen.queryByRole('button', { name: /Dejar/ })).toBeNull();
    expect(screen.getByText(/Solo el dueño o un administrador/)).toBeTruthy();
  });

  it('los accesos pasados se quedan a la vista: el registro es el punto', async () => {
    pintar([
      permiso({
        id: 'g0',
        estado: 'terminado',
        aprobadoEn: new Date(ahora - 86_400_000).toISOString(),
        revocadoEn: new Date(ahora - 80_000_000).toISOString(),
      }),
    ]);
    expect(await screen.findByText('Accesos anteriores')).toBeTruthy();
  });

  it('una solicitud que nunca se abrió se distingue de una que sí', async () => {
    pintar([permiso({ id: 'g0', estado: 'terminado', aprobadoEn: null })]);
    expect(await screen.findByText(/no se abrió/)).toBeTruthy();
  });

  it('si el servidor falla, se dice y no se finge que salió bien', async () => {
    pintar([permiso()], true, {
      aprobarSoporte: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(409, 'no_pendiente', 'Esa solicitud ya no está pendiente.'),
        ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Dejar 1 hora' }));
    // `findAllByRole`: en esta pantalla también vive el chat, que tiene su
    // propio hueco de error.
    const alertas = await screen.findAllByRole('alert');
    expect(alertas.map((a) => a.textContent).join(' ')).toContain('ya no está pendiente');
  });
});
