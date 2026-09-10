import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Api } from '../../api/cliente.ts';
import type { ResumenDeSuscripcion } from '../../api/tipos.ts';
import { Suscripcion } from './Suscripcion.tsx';

afterEach(cleanup);

const BASE: ResumenDeSuscripcion = {
  plan: { codigo: 'starter', nombre: 'Starter', precioPorAsientoCentimos: 2500, moneda: 'USD' },
  estado: 'activa',
  asientos: 3,
  importeMensualCentimos: 7500,
  pruebaHasta: '2026-10-09T00:00:00Z',
  periodoHasta: '2026-11-09T00:00:00Z',
  graciaHasta: '2026-11-16T00:00:00Z',
  pagos: [
    {
      importeCentimos: 7500,
      moneda: 'USD',
      cubreDesde: '2026-10-09T00:00:00Z',
      cubreHasta: '2026-11-09T00:00:00Z',
      metodo: 'transferencia',
      referencia: 'OP-1',
    },
  ],
  avisos: [],
};

const api = (d: Partial<ResumenDeSuscripcion> = {}) =>
  ({ suscripcion: vi.fn().mockResolvedValue({ ...BASE, ...d }) }) as unknown as Api;

describe('Suscripción', () => {
  it('muestra el importe por asientos ocupados y hasta cuándo está cubierta', async () => {
    render(<Suscripcion api={api()} />);
    // Dos veces a propósito: el importe del mes y el pago que lo cubrió.
    expect(await screen.findAllByText('75,00 USD')).toHaveLength(2);
    expect(screen.getByText('3 asientos ocupados')).toBeTruthy();
    // Sin el día exacto: la fecha se pinta en el huso de quien mira, y el
    // test correría igual de bien en Lima que en Madrid.
    expect(screen.getAllByText(/de noviembre de 2026/).length).toBeGreaterThan(0);
    expect(screen.getByText('OP-1')).toBeTruthy();
  });

  it('deja claro que la mensajería la cobra Meta, no nosotros', async () => {
    render(<Suscripcion api={api()} />);
    expect(await screen.findByText(/lo cobra Meta directamente/)).toBeTruthy();
  });

  it('al llegar al límite explica que lo que se detiene son los bots, no los mensajes', async () => {
    render(
      <Suscripcion
        api={api({ avisos: [{ limite: 'bot_runs_mes', nivel: 'pasado', usado: 500, tope: 500 }] })}
      />,
    );
    expect(await screen.findByText(/las conversaciones siguen entrando/i)).toBeTruthy();
  });

  it('no ofrece pagar: el cobro es manual y un botón que no cobra sería peor', async () => {
    render(<Suscripcion api={api()} />);
    await screen.findAllByText('75,00 USD');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
