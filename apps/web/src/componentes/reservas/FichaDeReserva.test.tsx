/**
 * La ficha de una reserva.
 *
 * Lo que se prueba es lo que no puede fallar en recepción: que los botones
 * de estado sean los que dice el servidor y ninguno más, que cancelar pida
 * confirmación, y que un solape se vea.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { DetalleDeReserva } from '../../api/tipos.ts';
import { FichaDeReserva } from './FichaDeReserva.tsx';

afterEach(cleanup);

const RESERVA = (extra: Partial<DetalleDeReserva> = {}): DetalleDeReserva => ({
  id: 'r1',
  estado: 'confirmada',
  contacto: { id: 'c1', nombre: 'Rosa Díaz' },
  tipo: 'Familiar',
  habitacion: null,
  entrada: '2026-07-26',
  salida: '2026-07-29',
  noches: 3,
  personas: 3,
  total: 126_200,
  pagado: 50_000,
  moneda: 'PEN',
  conversacionId: 'cv1',
  creadaEn: '2026-07-01T10:00:00Z',
  tipoId: 't1',
  habitacionId: null,
  leadId: 'l1',
  notas: null,
  lineas: [
    {
      tipo: 'noche',
      descripcion: 'Precio base',
      noche: '2026-07-26',
      cantidad: 1,
      unitario: 26_000,
      total: 26_000,
    },
    {
      tipo: 'noche',
      descripcion: 'Fiestas Patrias',
      noche: '2026-07-27',
      cantidad: 1,
      unitario: 42_000,
      total: 42_000,
    },
    {
      tipo: 'servicio',
      descripcion: 'Desayuno',
      noche: null,
      cantidad: 9,
      unitario: 1_800,
      total: 16_200,
    },
  ],
  pagos: [
    {
      id: 'p1',
      importe: 50_000,
      metodo: 'yape',
      referencia: 'OP-1',
      pagadoEn: '2026-07-02T10:00:00Z',
    },
  ],
  historial: [
    { tipo: 'creada', desde: null, hasta: 'pendiente', en: '2026-07-01T10:00:00Z', actor: 'Ana' },
  ],
  saldo: { total: 126_200, pagado: 50_000, pendiente: 76_200, aFavor: 0 },
  acciones: ['llegar', 'cancelar'],
  solapes: [],
  ...extra,
});

function pintar(reserva = RESERVA(), api: Partial<Record<keyof Api, unknown>> = {}) {
  const alCambiar = vi.fn();
  const falsa = {
    moverReserva: vi.fn().mockResolvedValue(RESERVA({ estado: 'cancelada', acciones: [] })),
    registrarPago: vi.fn().mockResolvedValue(reserva),
    asignarHabitacion: vi.fn().mockResolvedValue(reserva),
    ...api,
  } as unknown as Api;
  render(
    <FichaDeReserva
      api={falsa}
      reserva={reserva}
      habitaciones={[
        { id: 'h1', tipoId: 't1', nombre: 'Familiar 101', estado: 'disponible', notas: null },
      ]}
      alCambiar={alCambiar}
      alCerrar={vi.fn()}
    />,
  );
  return { api: falsa, alCambiar };
}

describe('FichaDeReserva', () => {
  it('los botones son exactamente las acciones que da el servidor', () => {
    pintar();
    expect(screen.getByRole('button', { name: 'Registrar llegada' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirmar reserva' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Registrar salida' })).toBeNull();
  });

  it('una reserva terminada no ofrece nada que hacer', () => {
    pintar(RESERVA({ estado: 'finalizada', acciones: [] }));
    expect(
      screen.queryByRole('button', { name: /Registrar llegada|Cancelar|Confirmar/ }),
    ).toBeNull();
  });

  it('cancelar pide confirmación antes de mandar nada', async () => {
    const { api } = pintar();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.moverReserva).not.toHaveBeenCalled();
    expect(screen.getByText(/No se deshace/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sí, cancelar' }));
    await waitFor(() => expect(api.moverReserva).toHaveBeenCalledWith('r1', 'cancelar'));
  });

  it('dice lo pendiente de pago y registra un pago en céntimos', async () => {
    const { api } = pintar();
    expect(screen.getByText('Pendiente')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Importe del pago'), '762');
    await userEvent.selectOptions(screen.getByLabelText('Método de pago'), 'plin');
    await userEvent.click(screen.getByRole('button', { name: 'Registrar pago' }));
    await waitFor(() =>
      expect(api.registrarPago).toHaveBeenCalledWith('r1', { importe: 76_200, metodo: 'plin' }),
    );
  });

  it('un solape en la habitación se ve en rojo y enlaza a la otra reserva', () => {
    pintar(
      RESERVA({
        habitacionId: 'h1',
        solapes: [
          { id: 'r2', contacto: 'Luis Ramos', entrada: '2026-07-28', salida: '2026-07-30' },
        ],
      }),
    );
    const aviso = screen.getByRole('alert');
    expect(aviso.textContent).toContain('ya está reservada');
    expect(screen.getByRole('button', { name: /Luis Ramos/ })).toBeTruthy();
  });
});
