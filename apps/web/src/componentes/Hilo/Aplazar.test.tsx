/**
 * Aplazar una conversación.
 *
 * Lo que se prueba es que el plazo que se elige es el que se manda, que se
 * puede deshacer donde se hizo, y que un fallo del servidor no deja el menú
 * fingiendo que funcionó.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { Aplazar } from './Aplazar.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pintar(aplazadaHasta: string | null, aplazar = vi.fn().mockResolvedValue(undefined)) {
  const api = { aplazar } as unknown as Api;
  const alCambiar = vi.fn();
  render(
    <Aplazar api={api} conversacionId="c1" aplazadaHasta={aplazadaHasta} alCambiar={alCambiar} />,
  );
  return { aplazar, alCambiar };
}

describe('Aplazar', () => {
  it('«en 1 hora» manda exactamente una hora más tarde', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-17T15:00:00Z'));
    const { aplazar, alCambiar } = pintar(null);

    await userEvent.click(screen.getByRole('button', { name: /Aplazar/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'En 1 hora' }));

    // Con margen y no al milisegundo: el reloj falso avanza mientras el test
    // pulsa, y un test que falla por eso solo enseña a desconfiar de él.
    const [id, hasta] = aplazar.mock.calls[0]! as [string, string];
    expect(id).toBe('c1');
    const minutos = (new Date(hasta).getTime() - Date.now()) / 60_000;
    expect(minutos).toBeGreaterThan(59);
    expect(minutos).toBeLessThanOrEqual(60);
    // Avisa a la bandeja: si no, la fila seguiría diciendo lo de antes.
    expect(alCambiar).toHaveBeenCalled();
  });

  it('«mañana a las 9:00» usa la hora de quien mira, no UTC', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-17T15:00:00Z'));
    const { aplazar } = pintar(null);

    await userEvent.click(screen.getByRole('button', { name: /Aplazar/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mañana a las 9:00' }));

    const enviado = new Date(aplazar.mock.calls[0]![1] as string);
    // Se comprueba en hora local a propósito: el agente piensa en su reloj.
    expect(enviado.getHours()).toBe(9);
    expect(enviado.getMinutes()).toBe(0);
  });

  it('cuando ya está aplazada, se puede deshacer desde el mismo sitio', async () => {
    const futuro = new Date(Date.now() + 3_600_000).toISOString();
    const { aplazar } = pintar(futuro);

    expect(screen.getByRole('button', { name: /Aplazada/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Aplazada/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Volver a verla ahora' }));

    expect(aplazar).toHaveBeenCalledWith('c1', null);
  });

  it('un aplazamiento ya vencido no cuenta como aplazada', () => {
    pintar(new Date(Date.now() - 3_600_000).toISOString());
    expect(screen.getByRole('button', { name: /Aplazar/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aplazada/ })).toBeNull();
  });

  it('si el servidor dice que no, se ve el motivo y el menú sigue abierto', async () => {
    const falla = vi
      .fn()
      .mockRejectedValue(new ErrorDeApi(422, 'fecha_invalida', 'Elige una fecha futura.'));
    pintar(null, falla);

    await userEvent.click(screen.getByRole('button', { name: /Aplazar/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'En 3 horas' }));

    expect((await screen.findByRole('alert')).textContent).toContain('fecha futura');
  });
});
