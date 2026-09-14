/**
 * El ciclo de vida de una reserva.
 *
 * Cada transición prohibida es un error de recepción que se pagaría caro:
 * cancelar a alguien que ya durmió allí, hacer check-in de una reserva que
 * nadie confirmó, o reabrir una estancia terminada.
 */
import { describe, expect, it } from 'vitest';
import {
  accionesPosibles,
  reservaViva,
  saldoDeReserva,
  seSolapan,
  transicionDeReserva,
} from '../src/reservas.js';

describe('transiciones', () => {
  it('el camino feliz: pendiente → confirmada → en casa → finalizada', () => {
    expect(transicionDeReserva('pendiente', 'confirmar')).toEqual({
      permitida: true,
      hasta: 'confirmada',
    });
    expect(transicionDeReserva('confirmada', 'llegar')).toEqual({
      permitida: true,
      hasta: 'en_casa',
    });
    expect(transicionDeReserva('en_casa', 'salir')).toEqual({
      permitida: true,
      hasta: 'finalizada',
    });
  });

  it('se cancela antes de llegar, pendiente o confirmada', () => {
    expect(transicionDeReserva('pendiente', 'cancelar').hasta).toBe('cancelada');
    expect(transicionDeReserva('confirmada', 'cancelar').hasta).toBe('cancelada');
  });

  it('a quien ya está en casa no se le cancela: se le registra la salida', () => {
    const r = transicionDeReserva('en_casa', 'cancelar');
    expect(r.permitida).toBe(false);
    expect(r.motivo).toMatch(/registra la salida/);
  });

  it('no hay check-in sin confirmar antes', () => {
    const r = transicionDeReserva('pendiente', 'llegar');
    expect(r.permitida).toBe(false);
    expect(r.motivo).toMatch(/Confirma la reserva/);
  });

  it('finalizada y cancelada son terminales', () => {
    expect(accionesPosibles('finalizada')).toEqual([]);
    expect(accionesPosibles('cancelada')).toEqual([]);
    expect(transicionDeReserva('cancelada', 'confirmar').motivo).toMatch(/Crea una nueva/);
  });

  it('las acciones posibles son las que la pantalla convierte en botones', () => {
    expect(accionesPosibles('pendiente')).toEqual(['confirmar', 'cancelar']);
    expect(accionesPosibles('confirmada')).toEqual(['llegar', 'cancelar']);
    expect(accionesPosibles('en_casa')).toEqual(['salir']);
  });

  it('una reserva ocupa la habitación mientras está viva', () => {
    expect(reservaViva('confirmada')).toBe(true);
    expect(reservaViva('en_casa')).toBe(true);
    expect(reservaViva('cancelada')).toBe(false);
    expect(reservaViva('finalizada')).toBe(false);
  });
});

describe('saldo', () => {
  it('lo pendiente es lo que falta; nunca negativo', () => {
    expect(saldoDeReserva(90_000, [30_000, 20_000])).toEqual({
      total: 90_000,
      pagado: 50_000,
      pendiente: 40_000,
      aFavor: 0,
    });
  });

  it('pagar de más se dice como saldo a favor, no como un pendiente negativo', () => {
    expect(saldoDeReserva(90_000, [100_000])).toMatchObject({ pendiente: 0, aFavor: 10_000 });
  });
});

describe('solapes', () => {
  it('compartir una noche es solaparse', () => {
    expect(
      seSolapan(
        { entrada: '2026-07-27', salida: '2026-07-30' },
        { entrada: '2026-07-29', salida: '2026-08-01' },
      ),
    ).toBe(true);
  });

  it('salir el 30 y que otro entre el 30 no se pisa: el día de salida no es noche', () => {
    expect(
      seSolapan(
        { entrada: '2026-07-27', salida: '2026-07-30' },
        { entrada: '2026-07-30', salida: '2026-08-02' },
      ),
    ).toBe(false);
  });

  it('una estancia dentro de otra también se pisa', () => {
    expect(
      seSolapan(
        { entrada: '2026-07-01', salida: '2026-07-31' },
        { entrada: '2026-07-10', salida: '2026-07-12' },
      ),
    ).toBe(true);
  });
});
