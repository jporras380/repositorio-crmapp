/**
 * Qué está haciendo un bot.
 *
 * Lo que se prueba es lo que se viene a buscar aquí: cuántas están vivas, qué
 * falló, y cómo llegar desde el paso que falló a la conversación de verdad.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EjecucionDeFlujo } from '../../api/tipos.ts';
import { Ejecuciones } from './Ejecuciones.tsx';

afterEach(cleanup);

const ahora = Date.now();

function ejecucion(p: Partial<EjecucionDeFlujo> = {}): EjecucionDeFlujo {
  return {
    id: 'r1',
    conversacionId: 'c1',
    estado: 'done',
    nodoActual: null,
    esperaHasta: null,
    error: null,
    iniciadaEn: new Date(ahora - 3_600_000).toISOString(),
    terminadaEn: new Date(ahora - 3_500_000).toISOString(),
    pasos: [
      {
        nodoId: 'saludo',
        tipo: 'mensaje',
        error: null,
        en: new Date(ahora - 3_600_000).toISOString(),
      },
      {
        nodoId: 'pregunta',
        tipo: 'espera',
        error: null,
        en: new Date(ahora - 3_550_000).toISOString(),
      },
    ],
    ...p,
  };
}

function pintar(ejecuciones: EjecucionDeFlujo[], extra: Record<string, unknown> = {}) {
  const api = {
    ejecucionesDeFlujo: vi.fn().mockResolvedValue(ejecuciones),
    ...extra,
  } as unknown as Api;
  render(<Ejecuciones api={api} flujoId="f1" />);
  return api;
}

describe('Ejecuciones de un bot', () => {
  it('pide las de ESTE bot', async () => {
    const api = pintar([ejecucion()]);
    await screen.findByText('Terminada');
    expect(api.ejecucionesDeFlujo).toHaveBeenCalledWith('f1');
  });

  it('cuenta cuántas están vivas, que es con lo que se abre esto', async () => {
    pintar([
      ejecucion({ id: 'r1', estado: 'running', terminadaEn: null, nodoActual: 'saludo' }),
      ejecucion({ id: 'r2', estado: 'waiting', terminadaEn: null, nodoActual: 'pregunta' }),
      ejecucion({ id: 'r3', estado: 'done' }),
    ]);
    // Contarlas a ojo en una lista de veinte no es contarlas.
    expect(await screen.findByText('2 en curso')).toBeTruthy();
  });

  it('sin ninguna viva no se inventa un contador a cero', async () => {
    pintar([ejecucion()]);
    await screen.findByText('Terminada');
    expect(screen.queryByText(/en curso/)).toBeNull();
  });

  it('una que va por un nodo dice por cuál', async () => {
    pintar([ejecucion({ estado: 'waiting', terminadaEn: null, nodoActual: 'pregunta-fechas' })]);
    expect(await screen.findByText(/en «pregunta-fechas»/)).toBeTruthy();
  });

  it('el error se ve SIN desplegar: es lo único sobre lo que hay que actuar', async () => {
    pintar([ejecucion({ estado: 'failed', error: 'La plantilla ya no existe en Meta.' })]);
    expect(await screen.findByText('La plantilla ya no existe en Meta.')).toBeTruthy();
    // Sin haber pulsado nada.
    expect(screen.queryByText('saludo')).toBeNull();
  });

  it('desplegar enseña paso a paso lo que hizo', async () => {
    pintar([ejecucion()]);
    await userEvent.click(await screen.findByRole('button', { name: /Terminada/ }));
    expect(screen.getByText('saludo')).toBeTruthy();
    expect(screen.getByText('pregunta')).toBeTruthy();
  });

  it('una que arrancó y no dio ningún paso lo dice', async () => {
    pintar([ejecucion({ estado: 'running', terminadaEn: null, pasos: [] })]);
    await userEvent.click(await screen.findByRole('button', { name: /Ejecutándose/ }));
    expect(screen.getByText(/todavía no dio ningún paso/)).toBeTruthy();
  });

  it('desde el detalle se llega a la conversación de verdad', async () => {
    pintar([ejecucion()]);
    await userEvent.click(await screen.findByRole('button', { name: /Terminada/ }));
    // Sin esto hay que buscarla a mano por el identificador.
    expect(screen.getByRole('button', { name: 'Ver la conversación' })).toBeTruthy();
  });

  it('un bot que no ha atendido a nadie lo dice con sus palabras', async () => {
    pintar([]);
    expect(await screen.findByText(/todavía no ha atendido ninguna conversación/)).toBeTruthy();
  });

  it('se puede actualizar a mano: esto es un banco de trabajo, no un panel', async () => {
    const api = pintar([ejecucion()]);
    await screen.findByText('Terminada');
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(api.ejecucionesDeFlujo).toHaveBeenCalledTimes(2);
  });

  it('si falla la carga, se dice', async () => {
    pintar([], {
      ejecucionesDeFlujo: vi.fn().mockRejectedValue(new ErrorDeApi(500, 'x', 'Se cayó.')),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Se cayó');
  });
});
