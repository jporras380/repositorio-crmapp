/**
 * El tablero del embudo.
 *
 * Lo que importa no es que pinte cajas: es que cada columna diga cuántas
 * reservas hay y cuánto suman —el número que se mira al entrar— y que mover
 * una tarjeta sea posible SIN arrastrar, porque arrastrar no funciona con
 * teclado ni con lector de pantalla.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnaDelTablero } from '../../api/tipos.ts';
import { Tablero } from './Tablero.tsx';

afterEach(cleanup);

const tarjeta = (id: string, titulo: string, importe = 0) => ({
  id,
  titulo,
  importe,
  contacto: { id: `c-${id}`, nombre: 'Ana Quispe' },
  conversacionId: 'cv-1',
  canal: 'whatsapp',
  responsableId: null,
  etiquetas: [{ id: 'e1', nombre: 'Familia', color: '#FF9F0A' }],
  creadoEn: '2026-09-11T12:00:00Z',
  actualizadoEn: '2026-09-11T12:00:00Z',
});

const COLUMNAS: ColumnaDelTablero[] = [
  {
    etapa: { id: 's1', nombre: 'Consulta', color: '#0A84FF', tipo: 'abierta', posicion: 0 },
    total: 3,
    importe: 45_000,
    tarjetas: [tarjeta('l1', 'Bungalow para el 28', 45_000), tarjeta('l2', 'Precio familiar')],
  },
  {
    etapa: { id: 's2', nombre: 'Confirmada', color: '#30D158', tipo: 'ganada', posicion: 1 },
    total: 0,
    importe: 0,
    tarjetas: [],
  },
];

describe('Tablero', () => {
  it('cada columna dice cuántas hay y cuánto suman', () => {
    render(
      <Tablero
        columnas={COLUMNAS}
        moneda="PEN"
        seleccionado={null}
        alAbrir={vi.fn()}
        alMover={vi.fn()}
      />,
    );
    // Por el encabezado, no por texto suelto: los mismos nombres salen en los
    // desplegables «Mover a» de cada tarjeta.
    expect(screen.getByRole('heading', { name: 'Consulta' })).toBeTruthy();
    expect(screen.getByText(/3 leads/)).toBeTruthy();
    expect(screen.getAllByText(/450/).length).toBeGreaterThan(0);
    expect(screen.getByText('Nada por aquí.')).toBeTruthy();
  });

  it('avisa de lo que no ha traído en vez de mentir con el número', () => {
    render(
      <Tablero
        columnas={COLUMNAS}
        moneda="PEN"
        seleccionado={null}
        alAbrir={vi.fn()}
        alMover={vi.fn()}
      />,
    );
    // La columna dice 3 y solo viajaron 2: se dice, no se disimula.
    expect(screen.getByText(/y 1 más/)).toBeTruthy();
  });

  it('se puede mover sin arrastrar: el desplegable es el camino accesible', async () => {
    const mover = vi.fn();
    render(
      <Tablero
        columnas={COLUMNAS}
        moneda="PEN"
        seleccionado={null}
        alAbrir={vi.fn()}
        alMover={mover}
      />,
    );
    const select = screen.getByLabelText('Mover «Bungalow para el 28» a otra etapa');
    await userEvent.selectOptions(select, 's2');
    expect(mover).toHaveBeenCalledWith('l1', 's2');
  });

  it('pulsar la tarjeta abre su ficha; no la edita ahí mismo', async () => {
    const abrir = vi.fn();
    render(
      <Tablero
        columnas={COLUMNAS}
        moneda="PEN"
        seleccionado={null}
        alAbrir={abrir}
        alMover={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText('Precio familiar'));
    expect(abrir).toHaveBeenCalledWith('l2');
  });

  it('soltar una tarjeta encima de una columna la mueve a esa etapa', () => {
    const mover = vi.fn();
    render(
      <Tablero
        columnas={COLUMNAS}
        moneda="PEN"
        seleccionado={null}
        alAbrir={vi.fn()}
        alMover={mover}
      />,
    );
    const columnas = screen.getAllByRole('listitem');
    const datos = { getData: () => 'l1', setData: vi.fn(), effectAllowed: '' };
    // jsdom no arrastra de verdad: se disparan los eventos que sí llegarían.
    const evento = new Event('drop', { bubbles: true });
    Object.defineProperty(evento, 'dataTransfer', { value: datos });
    columnas[1]!.dispatchEvent(evento);
    expect(mover).toHaveBeenCalledWith('l1', 's2');
  });
});
