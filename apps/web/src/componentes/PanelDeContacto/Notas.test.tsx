/**
 * Notas internas.
 *
 * La prueba que importa es la que evita el accidente: la nota **no** se envía
 * al canal, y la pantalla lo dice antes de escribir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import { Notas } from './Notas.tsx';

afterEach(cleanup);

const NOTAS = [
  {
    id: 'n1',
    cuerpo: 'Pidió cuna. Confirmar con limpieza.',
    autorId: 'u1',
    autor: 'Ana',
    creadaEn: '2026-09-11T14:00:00Z',
  },
  {
    id: 'n2',
    cuerpo: 'Llamó por teléfono, quiere factura.',
    autorId: 'u2',
    autor: 'Marta',
    creadaEn: '2026-09-11T13:00:00Z',
  },
];

function pintar(extra: Partial<Record<string, unknown>> = {}) {
  const api = {
    notas: vi.fn().mockResolvedValue(NOTAS),
    anotar: vi.fn().mockResolvedValue({ id: 'n3' }),
    borrarNota: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as Api;
  render(<Notas api={api} conversacionId="c1" userId="u1" />);
  return api;
}

describe('Notas', () => {
  it('avisa de que no las ve el cliente, antes de escribir', async () => {
    pintar();
    expect(screen.getByText('solo las ve el equipo')).toBeTruthy();
    expect(await screen.findByText('Pidió cuna. Confirmar con limpieza.')).toBeTruthy();
  });

  it('anota y recarga, sin pasar por el compositor del canal', async () => {
    const api = pintar();
    await screen.findByText(/Pidió cuna/);
    await userEvent.type(screen.getByLabelText('Nueva nota interna'), 'Llega a las 3');
    await userEvent.click(screen.getByRole('button', { name: 'Anotar' }));
    await waitFor(() => expect(api.anotar).toHaveBeenCalledWith('c1', 'Llega a las 3'));
    // Dos cargas: la inicial y la de después de guardar.
    expect((api.notas as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('solo se puede borrar la nota propia', async () => {
    pintar();
    await screen.findByText(/Pidió cuna/);
    // La de Ana (u1) sí; la de Marta (u2) no.
    expect(screen.getAllByRole('button', { name: 'Borrar la nota' })).toHaveLength(1);
  });

  it('una nota vacía no se guarda', async () => {
    const api = pintar();
    await screen.findByText(/Pidió cuna/);
    expect(screen.getByRole('button', { name: 'Anotar' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('Nueva nota interna'), '   ');
    expect(api.anotar).not.toHaveBeenCalled();
  });
});
