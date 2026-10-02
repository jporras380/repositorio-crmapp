/**
 * Ajustes → Privacidad. Lo que se prueba es lo que evita un borrado sin
 * querer: cada plazo dice cuánto se perdería, guardar uno que borra pide
 * confirmación con esa cifra, y quien no es propietario no puede tocarlo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { Privacidad as DatosDePrivacidad } from '../../api/tipos.ts';
import { Privacidad } from './Privacidad.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE: DatosDePrivacidad = {
  retencionMeses: null,
  caerianConCadaPlazo: { 12: 3412, 24: 120, 36: 0, 60: 0 },
  puedeCambiar: true,
};

function pintar(datos: Partial<DatosDePrivacidad> = {}) {
  const guardarPrivacidad = vi
    .fn()
    .mockImplementation((m: number | null) =>
      Promise.resolve({ ...BASE, ...datos, retencionMeses: m }),
    );
  const api = {
    privacidad: vi.fn().mockResolvedValue({ ...BASE, ...datos }),
    guardarPrivacidad,
  } as unknown as Api;
  render(<Privacidad api={api} />);
  return guardarPrivacidad;
}

describe('Ajustes → Privacidad', () => {
  it('viene en «Siempre» y cada plazo dice cuántos mensajes caerían hoy', async () => {
    pintar();
    expect(
      ((await screen.findByRole('radio', { name: /Siempre/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText('Hoy se borrarían 3,412 mensajes')).toBeTruthy();
    expect(screen.getAllByText('Hoy no se borraría ninguno')).toHaveLength(2);
  });

  it('guardar un plazo que borra pide confirmación con la cifra; si se cancela, no guarda', async () => {
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const guardar = pintar();
    await userEvent.click(await screen.findByRole('radio', { name: /1 año/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(confirmar.mock.calls[0]![0]).toContain('3,412 mensajes');
    expect(confirmar.mock.calls[0]![0]).toContain('No se puede deshacer');
    expect(guardar).not.toHaveBeenCalled();
  });

  it('confirmado, guarda y dice qué quedó', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const guardar = pintar();
    await userEvent.click(await screen.findByRole('radio', { name: /2 años/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(guardar).toHaveBeenCalledWith(24);
    expect(await screen.findByText(/se borran solos los mensajes con más de 2 años/)).toBeTruthy();
  });

  it('un plazo que hoy no borra nada no pregunta', async () => {
    const confirmar = vi.spyOn(window, 'confirm');
    const guardar = pintar();
    await userEvent.click(await screen.findByRole('radio', { name: /5 años/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(confirmar).not.toHaveBeenCalled();
    expect(guardar).toHaveBeenCalledWith(60);
  });

  it('quien no es propietario lo ve, pero no puede cambiarlo', async () => {
    pintar({ puedeCambiar: false, retencionMeses: 24 });
    expect(
      ((await screen.findByRole('radio', { name: /2 años/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar' })).toBeNull();
    expect(screen.getByRole('radio', { name: /1 año/ }).matches(':disabled')).toBe(true);
    expect(screen.getByText('Solo el propietario de la cuenta puede cambiarlo.')).toBeTruthy();
  });
});
