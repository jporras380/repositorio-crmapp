/**
 * «Ya te pagué», visto por el operador.
 *
 * Lo que se prueba es lo que protege el dinero: que rechazar exija decir por
 * qué —el cliente lo va a leer— y que sin nada pendiente esta sección no
 * ocupe sitio. Confirmar mueve dinero al libro; no es un botón más.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { PagosDeclarados } from './PagosDeclarados.tsx';

afterEach(cleanup);

const PENDIENTE = {
  id: 'd1',
  tenantId: 'te-9',
  cuenta: 'Apart Hotel El Paraíso',
  importeCentimos: 7500,
  moneda: 'USD',
  metodo: 'yape',
  referencia: 'OP-123',
  pagadoEl: '2026-09-20',
  medioId: null,
  estado: 'pendiente' as const,
  revisadoEn: null,
  notaDeRevision: null,
  creadoEn: new Date(Date.now() - 3_600_000).toISOString(),
};

function pintar(pendientes = [PENDIENTE], extra: Record<string, unknown> = {}) {
  const api = {
    pagosDeclarados: vi.fn().mockResolvedValue(pendientes),
    resolverPagoDeclarado: vi.fn().mockResolvedValue({ resuelta: true }),
    ...extra,
  } as unknown as Api;
  const alResolver = vi.fn();
  render(<PagosDeclarados api={api} alResolver={alResolver} />);
  return { api, alResolver };
}

describe('Pagos que dicen haber hecho', () => {
  beforeEach(() => {
    vi.spyOn(window, 'prompt').mockReturnValue('El importe no coincide.');
  });
  afterEach(() => vi.restoreAllMocks());

  it('enseña de quién es, cuánto y por dónde', async () => {
    pintar();
    expect(await screen.findByText('Apart Hotel El Paraíso')).toBeTruthy();
    // El número de operación es lo que permite cuadrarlo sin llamar a nadie.
    expect(screen.getByText(/op\. OP-123/)).toBeTruthy();
    expect(screen.getByText(/75/)).toBeTruthy();
  });

  it('confirmar lo manda con su cuenta, no solo con el identificador', async () => {
    const { api, alResolver } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    await waitFor(() =>
      expect(api.resolverPagoDeclarado).toHaveBeenCalledWith('d1', {
        tenantId: 'te-9',
        confirmar: true,
      }),
    );
    // La tabla de cuentas cambia al confirmar: dejarla como estaba mentiría.
    expect(alResolver).toHaveBeenCalled();
  });

  it('rechazar EXIGE un motivo, y lo manda', async () => {
    const { api } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Rechazar' }));
    await waitFor(() =>
      expect(api.resolverPagoDeclarado).toHaveBeenCalledWith('d1', {
        tenantId: 'te-9',
        confirmar: false,
        nota: 'El importe no coincide.',
      }),
    );
  });

  it('sin motivo NO rechaza: el cliente se quedaría sin saber qué arreglar', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('');
    const { api } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Rechazar' }));
    expect(api.resolverPagoDeclarado).not.toHaveBeenCalled();
  });

  it('sin nada pendiente no ocupa sitio', async () => {
    pintar([]);
    // Es una bandeja, no un panel: una bandeja vacía no se anuncia.
    await waitFor(() => expect(screen.queryByText(/Dicen haber pagado/)).toBeNull());
  });

  it('si falla el servidor, se dice', async () => {
    pintar([PENDIENTE], {
      resolverPagoDeclarado: vi
        .fn()
        .mockRejectedValue(new ErrorDeApi(409, 'ya_resuelta', 'Esa declaración ya se resolvió.')),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ya se resolvió');
  });
});
