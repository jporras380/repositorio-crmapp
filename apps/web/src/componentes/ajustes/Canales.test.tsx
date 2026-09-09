import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
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

  it('el formulario envía las cuatro credenciales y muestra el motivo si Meta las rechaza', async () => {
    const conectar = vi
      .fn()
      .mockRejectedValueOnce(
        new ErrorDeApi(422, 'credenciales_rechazadas', 'Meta rechazó el token.'),
      )
      .mockResolvedValueOnce({});
    const api = {
      canales: vi.fn().mockResolvedValue([]),
      conectarWhatsapp: conectar,
    } as unknown as Api;
    render(<Canales api={api} gestor={true} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar WhatsApp' }));
    await userEvent.type(screen.getByLabelText(/Phone number ID/), '1397');
    await userEvent.type(screen.getByLabelText(/WABA/), '1574');
    await userEvent.type(screen.getByLabelText(/Token de acceso/), 'EAAX-token-largo');
    await userEvent.type(screen.getByLabelText(/Clave secreta/), 'secreto-largo-16');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(conectar).toHaveBeenCalledWith({
      phoneNumberId: '1397',
      wabaId: '1574',
      accessToken: 'EAAX-token-largo',
      appSecret: 'secreto-largo-16',
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Meta rechazó el token.');
  });
});
