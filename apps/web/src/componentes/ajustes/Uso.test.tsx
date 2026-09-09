import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Api } from '../../api/cliente.ts';
import { Uso } from './Uso.tsx';

afterEach(cleanup);

describe('Uso', () => {
  it('pinta los límites con su barra y las métricas con nombre legible', async () => {
    const api = {
      uso: vi.fn().mockResolvedValue({
        periodo: '2026-09',
        desde: '2026-09-01T00:00:00.000Z',
        plan: 'starter',
        uso: {
          'messages.inbound': 12,
          'messages.outbound': 9,
          'templates.sent': 1,
          'conversations.opened': 850,
          'media.stored_bytes': 2_500_000,
        },
        limites: {
          conversaciones_mes: { limite: 1000, usado: 850 },
          agentes: { limite: 3, usado: null },
        },
      }),
    } as unknown as Api;
    render(<Uso api={api} />);
    expect(await screen.findByText('Conversaciones al mes')).toBeTruthy();
    const barra = screen.getAllByRole('progressbar')[0]!;
    expect(barra.getAttribute('aria-valuenow')).toBe('85');
    // Al 85 % la barra avisa (ámbar) y el ancho es dato en una propiedad personalizada.
    const relleno = barra.firstElementChild as HTMLElement;
    expect(relleno.className).toContain('barraUsoRelleno_warn');
    expect(relleno.style.getPropertyValue('--porcentaje')).toBe('85%');
    expect(screen.getByText('sin medir / 3')).toBeTruthy();
    expect(screen.getByText('2.4 MB')).toBeTruthy();
    expect(screen.getByText('Archivos almacenados')).toBeTruthy();
  });
});
