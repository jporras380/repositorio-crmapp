/**
 * Ajustes → Horario. Se prueba lo que el hotel toca: marcar un día, añadir el
 * tramo de la tarde, y que la respuesta automática no se pueda encender sin
 * texto (no avisaría de nada).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { HorarioDeAtencion } from '../../api/tipos.ts';
import { Horario } from './Horario.tsx';

afterEach(cleanup);

const BASE: HorarioDeAtencion = {
  zonaHoraria: 'America/Lima',
  horario: { '1': [['09:00', '18:00']] },
  avisoActivo: false,
  avisoTexto: '',
  configurado: true,
  equipoId: null,
  propio: true,
  equiposConHorario: [],
};

function pintar(
  datos: Partial<HorarioDeAtencion> = {},
  administra = true,
  extra: Record<string, unknown> = {},
) {
  const guardarHorario = vi.fn().mockResolvedValue({ ...BASE, ...datos });
  const api = {
    horario: vi.fn().mockResolvedValue({ ...BASE, ...datos }),
    guardarHorario,
    equipos: vi.fn().mockResolvedValue([]),
    ...extra,
  } as unknown as Api;
  render(<Horario api={api} administra={administra} />);
  return guardarHorario;
}

describe('Ajustes → Horario', () => {
  it('un día cerrado lo dice; marcarlo le pone horario y guardarlo lo manda', async () => {
    const guardar = pintar();
    expect((await screen.findAllByText('Cerrado')).length).toBe(6);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Martes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horario' }));
    expect(guardar).toHaveBeenCalledWith(
      {
        horario: { '1': [['09:00', '18:00']], '2': [['09:00', '18:00']] },
        zonaHoraria: 'America/Lima',
      },
      null,
    );
  });

  it('se puede añadir el tramo de la tarde en el mismo día', async () => {
    const guardar = pintar();
    await userEvent.click((await screen.findAllByRole('button', { name: '+ tramo' }))[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horario' }));
    expect(guardar.mock.calls[0]![0].horario['1']).toEqual([
      ['09:00', '18:00'],
      ['15:00', '20:00'],
    ]);
  });

  it('la respuesta automática no se enciende sin texto', async () => {
    pintar();
    const boton = (await screen.findByRole('button', {
      name: 'Encender respuesta',
    })) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    expect(screen.getByText('Apagada: fuera de horario no se envía nada.')).toBeTruthy();
  });

  it('con texto se enciende y se guarda junto al mensaje', async () => {
    const guardar = pintar({ avisoTexto: 'Estamos cerrados, te respondemos mañana.' });
    await userEvent.click(await screen.findByRole('button', { name: 'Encender respuesta' }));
    expect(guardar).toHaveBeenCalledWith(
      { avisoActivo: true, avisoTexto: 'Estamos cerrados, te respondemos mañana.' },
      null,
    );
  });

  it('quien no administra lo ve pero no lo cambia', async () => {
    pintar({}, false);
    const casilla = (await screen.findByRole('checkbox', { name: 'Lunes' })) as HTMLInputElement;
    expect(casilla.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar horario' })).toBeNull();
  });
});

describe('Ajustes → Horario · por equipo', () => {
  const RESERVAS = { id: 'eq-1', nombre: 'Reservas', miembros: [], abiertas: 0 };

  it('sin equipos no hay selector: no se enseña una opción vacía', async () => {
    pintar();
    await screen.findAllByText('Cerrado');
    expect(screen.queryByLabelText(/^Horario de/)).toBeNull();
  });

  it('un equipo sin horario propio dice que usa el general, y guardar se lo da', async () => {
    const horario = vi
      .fn()
      .mockImplementation((id: string | null) =>
        Promise.resolve({ ...BASE, equipoId: id, propio: id === null }),
      );
    const guardar = pintar({}, true, { equipos: vi.fn().mockResolvedValue([RESERVAS]), horario });

    await userEvent.selectOptions(await screen.findByLabelText(/^Horario de/), 'eq-1');
    expect(horario).toHaveBeenLastCalledWith('eq-1');
    expect(await screen.findByText(/Usa el horario de toda la cuenta/)).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Martes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar horario' }));
    expect(guardar.mock.calls[0]![1]).toBe('eq-1');
  });

  it('con horario propio ofrece volver al general', async () => {
    const quitarHorarioDeEquipo = vi
      .fn()
      .mockResolvedValue({ ...BASE, equipoId: 'eq-1', propio: false });
    pintar({}, true, {
      equipos: vi.fn().mockResolvedValue([RESERVAS]),
      horario: vi
        .fn()
        .mockImplementation((id: string | null) =>
          Promise.resolve({ ...BASE, equipoId: id, propio: true, equiposConHorario: ['eq-1'] }),
        ),
      quitarHorarioDeEquipo,
    });
    await screen.findByRole('option', { name: 'Reservas · horario propio' });
    await userEvent.selectOptions(screen.getByLabelText(/^Horario de/), 'eq-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Volver al horario general' }));
    expect(quitarHorarioDeEquipo).toHaveBeenCalledWith('eq-1');
    expect(await screen.findByText('El equipo usa otra vez el horario general.')).toBeTruthy();
  });
});
