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
};

function pintar(datos: Partial<HorarioDeAtencion> = {}, administra = true) {
  const guardarHorario = vi.fn().mockResolvedValue({ ...BASE, ...datos });
  const api = {
    horario: vi.fn().mockResolvedValue({ ...BASE, ...datos }),
    guardarHorario,
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
    expect(guardar).toHaveBeenCalledWith({
      horario: { '1': [['09:00', '18:00']], '2': [['09:00', '18:00']] },
      zonaHoraria: 'America/Lima',
    });
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
    expect(guardar).toHaveBeenCalledWith({
      avisoActivo: true,
      avisoTexto: 'Estamos cerrados, te respondemos mañana.',
    });
  });

  it('quien no administra lo ve pero no lo cambia', async () => {
    pintar({}, false);
    const casilla = (await screen.findByRole('checkbox', { name: 'Lunes' })) as HTMLInputElement;
    expect(casilla.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar horario' })).toBeNull();
  });
});
