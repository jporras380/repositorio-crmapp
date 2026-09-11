/**
 * El mapa del flujo (ADR-012).
 *
 * Lo que importa no es el dibujo, es que el dibujo diga la verdad: un nodo por
 * paso, las dos salidas de una espera etiquetadas —«responde» y «no
 * responde»—, y lo que no se alcanza desde el inicio marcado como suelto. Un
 * mapa que miente es peor que no tener mapa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GrafoDeFlujo } from '../../api/tipos.ts';
import { MapaDelFlujo } from './MapaDelFlujo.tsx';

afterEach(cleanup);

const GRAFO: GrafoDeFlujo = {
  inicio: 'saludo',
  nodos: [
    { id: 'saludo', tipo: 'mensaje', texto: 'Hola', siguiente: 'espera' },
    {
      id: 'espera',
      tipo: 'esperar_respuesta',
      segundos: 3600,
      siguiente: 'fin',
      alExpirar: 'frio',
    },
    { id: 'frio', tipo: 'etiquetar', etiquetaId: 'e1', siguiente: 'fin' },
    { id: 'fin', tipo: 'fin' },
    { id: 'huerfano', tipo: 'mensaje', texto: 'Nadie llega aquí', siguiente: null },
  ],
};

describe('MapaDelFlujo', () => {
  it('pinta un nodo por paso y marca dónde empieza', () => {
    render(<MapaDelFlujo grafo={GRAFO} seleccionado={null} alSeleccionar={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByText(/Mensaje · empieza/)).toBeTruthy();
  });

  it('etiqueta las dos salidas de una espera: contestó y no contestó', () => {
    render(<MapaDelFlujo grafo={GRAFO} seleccionado={null} alSeleccionar={vi.fn()} />);
    expect(screen.getByText('responde')).toBeTruthy();
    expect(screen.getByText('no responde')).toBeTruthy();
  });

  it('lo que no se alcanza desde el inicio se ve, y se ve que sobra', () => {
    render(<MapaDelFlujo grafo={GRAFO} seleccionado={null} alSeleccionar={vi.fn()} />);
    const sueltos = document.querySelectorAll('.cajaSuelta');
    expect(sueltos).toHaveLength(1);
  });

  it('pulsar un nodo lo selecciona; el mapa no edita', async () => {
    const seleccionar = vi.fn();
    render(<MapaDelFlujo grafo={GRAFO} seleccionado={null} alSeleccionar={seleccionar} />);
    await userEvent.click(screen.getByRole('button', { name: /Etiqueta/ }));
    expect(seleccionar).toHaveBeenCalledWith('frio');
  });

  it('una pausa se lee en el mapa con lo único que hay que saber: cuánto calla', () => {
    render(
      <MapaDelFlujo
        grafo={{
          inicio: 'a',
          nodos: [
            { id: 'a', tipo: 'mensaje', texto: 'Hola', siguiente: 'p' },
            { id: 'p', tipo: 'pausa', segundos: 4, siguiente: null },
          ],
        }}
        seleccionado={null}
        alSeleccionar={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Pausa/ })).toBeTruthy();
    expect(screen.getByText('4 s')).toBeTruthy();
  });

  it('el nodo elegido queda marcado', () => {
    render(<MapaDelFlujo grafo={GRAFO} seleccionado="espera" alSeleccionar={vi.fn()} />);
    const activo = document.querySelectorAll('.cajaActiva');
    expect(activo).toHaveLength(1);
  });
});
