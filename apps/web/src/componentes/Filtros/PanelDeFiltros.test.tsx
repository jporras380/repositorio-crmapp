/**
 * El panel de filtros y las vistas guardadas.
 *
 * Lo que se prueba: que aplicar una vista guardada **reemplace** los filtros
 * y no se sume a los que hubiera —si se sumara, el resultado no sería el que
 * se guardó y nadie entendería por qué— y que el estado de atención se filtre
 * con los mismos nombres que devuelve el servidor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Embudo, VistaDeBandeja } from '../../api/tipos.ts';
import { PanelDeFiltros } from './PanelDeFiltros.tsx';

afterEach(cleanup);

const EMBUDOS: Embudo[] = [
  {
    id: 'p1',
    nombre: 'Reservas',
    moneda: 'PEN',
    porDefecto: true,
    etapas: [
      { id: 's1', nombre: 'Consulta', color: null, tipo: 'abierta', posicion: 0 },
      { id: 's2', nombre: 'Confirmada', color: null, tipo: 'ganada', posicion: 1 },
    ],
  },
];

const VISTAS: VistaDeBandeja[] = [
  { id: 'v1', nombre: 'Sin responder de hoy', filtros: { atencion: 'por_responder' }, posicion: 0 },
];

function pintar(filtros = {}, extra: Partial<Parameters<typeof PanelDeFiltros>[0]> = {}) {
  const props = {
    filtros,
    miembros: [{ id: 'u1', nombre: 'Ana', rol: 'agent' }],
    embudos: EMBUDOS,
    vistas: VISTAS,
    alCambiar: vi.fn(),
    alGuardarVista: vi.fn(),
    alBorrarVista: vi.fn(),
    alAplicarVista: vi.fn(),
    alCerrar: vi.fn(),
    ...extra,
  } as Parameters<typeof PanelDeFiltros>[0];
  render(<PanelDeFiltros {...props} />);
  return props;
}

describe('PanelDeFiltros', () => {
  it('filtra por estado de atención con los nombres del servidor', async () => {
    const p = pintar();
    await userEvent.selectOptions(screen.getByLabelText(/Estado de atención/), 'por_responder');
    expect(p.alCambiar).toHaveBeenCalledWith(
      expect.objectContaining({ atencion: 'por_responder' }),
    );
  });

  it('ofrece las etapas del embudo, con su embudo delante', () => {
    pintar();
    expect(screen.getByRole('option', { name: 'Reservas · Consulta' })).toBeTruthy();
  });

  it('aplicar una vista reemplaza los filtros, no los añade', async () => {
    const p = pintar({ canal: 'whatsapp', agenteId: 'u1' });
    await userEvent.click(screen.getByRole('button', { name: 'Sin responder de hoy' }));
    expect(p.alAplicarVista).toHaveBeenCalledWith(VISTAS[0]);
  });

  it('guardar pide un nombre y no deja guardar sin él', async () => {
    const p = pintar({ atencion: 'nueva' });
    const guardar = screen.getByRole('button', { name: 'Guardar' });
    expect(guardar.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('Nombre de la vista'), 'Nuevas');
    await userEvent.click(guardar);
    expect(p.alGuardarVista).toHaveBeenCalledWith('Nuevas');
  });

  it('«Quitar todos» solo aparece cuando hay algo que quitar', async () => {
    const { alCambiar } = pintar({ atencion: 'nueva' });
    await userEvent.click(screen.getByRole('button', { name: 'Quitar todos' }));
    expect(alCambiar).toHaveBeenCalledWith({});
    cleanup();
    pintar();
    expect(screen.queryByRole('button', { name: 'Quitar todos' })).toBeNull();
  });
});
