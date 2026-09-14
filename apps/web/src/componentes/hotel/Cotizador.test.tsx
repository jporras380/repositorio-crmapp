/**
 * El cotizador.
 *
 * Lo que se prueba es lo que un agente dice por teléfono: que la cifra la da
 * el servidor —no una suma hecha aquí—, y que un total incompleto se ve
 * incompleto en vez de parecer un precio.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { Cotizacion, TipoDeHabitacion } from '../../api/tipos.ts';
import { Cotizador } from './Cotizador.tsx';

afterEach(cleanup);

const TIPO = (extra: Partial<TipoDeHabitacion> = {}): TipoDeHabitacion => ({
  id: 't1',
  nombre: 'Familiar VIP',
  descripcion: null,
  capacidad: 6,
  precioBase: 40_000,
  moneda: 'PEN',
  activo: true,
  habitaciones: [],
  tarifas: [],
  ...extra,
});

const COTIZACION = (extra: Partial<Cotizacion> = {}): Cotizacion => ({
  tipo: 'Familiar VIP',
  noches: 2,
  personas: 2,
  moneda: 'PEN',
  detalle: [
    { fecha: '2026-07-27', precio: 45_000, tarifa: 'Fiestas Patrias' },
    { fecha: '2026-07-28', precio: 45_000, tarifa: 'Fiestas Patrias' },
  ],
  alojamiento: 90_000,
  servicios: [],
  total: 90_000,
  problemas: [],
  completa: true,
  ...extra,
});

function pintar(cotizar = vi.fn().mockResolvedValue(COTIZACION()), tipos = [TIPO()]) {
  const api = { cotizar } as unknown as Api;
  render(
    <Cotizador
      api={api}
      tipos={tipos}
      servicios={[
        {
          id: 's1',
          nombre: 'Desayuno',
          precio: 1_500,
          moneda: 'PEN',
          unidad: 'por_persona_noche',
          activo: true,
        },
      ]}
    />,
  );
  return cotizar;
}

describe('Cotizador', () => {
  it('pide la cifra al servidor y la desglosa noche a noche', async () => {
    const cotizar = pintar();
    await waitFor(() => expect(cotizar).toHaveBeenCalled());
    expect(await screen.findByText(/900/)).toBeTruthy();
    expect(screen.getAllByText('Fiestas Patrias')).toHaveLength(2);
  });

  it('marcar un extra vuelve a cotizar con él', async () => {
    const cotizar = pintar();
    await waitFor(() => expect(cotizar).toHaveBeenCalled());
    await userEvent.click(screen.getByLabelText('Desayuno'));
    await waitFor(() => expect(cotizar.mock.calls.at(-1)![0]).toMatchObject({ servicios: ['s1'] }));
  });

  it('un total incompleto se ve tachado y dice por qué', async () => {
    pintar(
      vi.fn().mockResolvedValue(
        COTIZACION({
          completa: false,
          problemas: [
            {
              codigo: 'noche_sin_precio',
              mensaje: 'La noche del 2026-07-28 no tiene tarifa ni precio base.',
            },
          ],
        }),
      ),
    );
    expect(await screen.findByText(/no tiene tarifa ni precio base/)).toBeTruthy();
    expect(screen.getByText(/falta el precio de alguna noche/)).toBeTruthy();
  });

  it('sin tipos activos no hay nada que cotizar, y lo dice', () => {
    pintar(vi.fn(), [TIPO({ activo: false })]);
    expect(screen.getByText(/Crea un tipo de habitación/)).toBeTruthy();
  });
});
