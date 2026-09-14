import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import { Canales } from './Canales.tsx';

afterEach(cleanup);

describe('Canales', () => {
  it('lista las cuentas con su estado y, sin ser gestor, no ofrece conectar', async () => {
    const api = {
      canales: vi.fn().mockResolvedValue([
        {
          id: 'c1',
          canal: 'whatsapp',
          externalId: '1397',
          providerAccountId: 'w1',
          displayName: 'Número de prueba',
          status: 'connected',
          lastEventAt: null,
          createdAt: '2026-09-09T00:00:00Z',
        },
      ]),
    } as unknown as Api;
    render(<Canales api={api} gestor={false} />);
    expect(await screen.findByText('Número de prueba')).toBeTruthy();
    expect(screen.getByText('Conectado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar WhatsApp' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desconectar' })).toBeNull();
  });

  it('un gestor puede conectar WhatsApp o Instagram, cada uno con su asistente', async () => {
    const api = { canales: vi.fn().mockResolvedValue([]) } as unknown as Api;
    render(<Canales api={api} gestor={true} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar Instagram' }));
    expect(screen.getByRole('heading', { name: 'Conectar Instagram' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conectar WhatsApp' }));
    expect(screen.getByRole('heading', { name: 'Conectar WhatsApp' })).toBeTruthy();
    // Ya no se piden identificadores copiados del panel de Meta.
    expect(screen.queryByLabelText(/Phone number ID/)).toBeNull();
  });
});
