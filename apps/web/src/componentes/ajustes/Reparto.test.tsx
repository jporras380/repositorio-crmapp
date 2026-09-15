import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { ConfiguracionDeReparto } from '../../api/tipos.ts';
import { Reparto } from './Reparto.tsx';

afterEach(cleanup);

const CONFIG: ConfiguracionDeReparto = {
  modo: 'off',
  miembros: [
    { userId: 'u1', nombre: 'Ana', email: 'ana@h.pe', rol: 'agent', recibe: true, abiertas: 4 },
    { userId: 'u2', nombre: 'Beto', email: 'beto@h.pe', rol: 'owner', recibe: false, abiertas: 0 },
  ],
};

describe('Ajustes → Reparto', () => {
  it('encenderlo lo guarda y dice entre cuántas personas reparte', async () => {
    const guardarReparto = vi.fn().mockResolvedValue({ ...CONFIG, modo: 'least_busy' });
    const api = { reparto: vi.fn().mockResolvedValue(CONFIG), guardarReparto } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    expect(
      await screen.findByText(/Apagado: las conversaciones nuevas quedan sin asignar/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Encender reparto' }));
    expect(guardarReparto).toHaveBeenCalledWith({ modo: 'least_busy' });
    expect(await screen.findByText('Encendido: reparte entre 1 persona.')).toBeTruthy();
  });

  it('marcar a alguien lo mete en el reparto', async () => {
    const guardarReparto = vi.fn().mockResolvedValue(CONFIG);
    const api = { reparto: vi.fn().mockResolvedValue(CONFIG), guardarReparto } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Beto/ }));
    expect(guardarReparto).toHaveBeenCalledWith({ miembros: [{ userId: 'u2', recibe: true }] });
  });

  it('encendido sin nadie marcado avisa de que quedarán sin asignar', async () => {
    const api = {
      reparto: vi.fn().mockResolvedValue({
        modo: 'least_busy',
        miembros: CONFIG.miembros.map((m) => ({ ...m, recibe: false })),
      }),
    } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    expect(await screen.findByText(/nadie está marcado para recibir/)).toBeTruthy();
  });

  it('quien no administra ve el reparto pero no lo cambia', async () => {
    const api = { reparto: vi.fn().mockResolvedValue(CONFIG) } as unknown as Api;
    render(<Reparto api={api} administra={false} />);
    const casilla = (await screen.findByRole('checkbox', { name: /Ana/ })) as HTMLInputElement;
    expect(casilla.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /reparto/ })).toBeNull();
  });
});
