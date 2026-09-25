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
  {
    id: 'v1',
    nombre: 'Sin responder de hoy',
    filtros: { atencion: 'por_responder' },
    posicion: 0,
    compartida: false,
    mia: true,
  },
];

/** Una del equipo, hecha por otra persona: se ve y no se toca. */
const DEL_EQUIPO: VistaDeBandeja = {
  id: 'v9',
  nombre: 'Urgentes del turno',
  filtros: { atencion: 'por_responder' },
  posicion: 0,
  compartida: true,
  mia: false,
};

function pintar(filtros = {}, extra: Partial<Parameters<typeof PanelDeFiltros>[0]> = {}) {
  const props = {
    filtros,
    miembros: [{ id: 'u1', nombre: 'Ana', rol: 'agent' }],
    embudos: EMBUDOS,
    vistas: VISTAS,
    alCambiar: vi.fn(),
    alGuardarVista: vi.fn(),
    alBorrarVista: vi.fn(),
    alCompartirVista: vi.fn(),
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

/**
 * Vistas compartidas (0045).
 *
 * Lo que se prueba es lo que evita que el equipo acabe con cinco versiones de
 * lo mismo, y la línea que lo hace seguro: una vista ajena se ve, se aplica, y
 * no se puede tocar.
 */
describe('Vistas compartidas', () => {
  it('una vista propia se puede compartir', async () => {
    const p = pintar();
    await userEvent.click(
      screen.getByRole('button', { name: 'Compartir Sin responder de hoy con el equipo' }),
    );
    expect(p.alCompartirVista).toHaveBeenCalledWith('v1', true);
  });

  it('una ya compartida se puede dejar de compartir', async () => {
    const p = pintar({}, { vistas: [{ ...VISTAS[0]!, compartida: true }] });
    await userEvent.click(
      screen.getByRole('button', { name: 'Dejar de compartir Sin responder de hoy' }),
    );
    expect(p.alCompartirVista).toHaveBeenCalledWith('v1', false);
  });

  it('se distingue la propia compartida de la del equipo', async () => {
    pintar({}, { vistas: [{ ...VISTAS[0]!, compartida: true }, DEL_EQUIPO] });
    // Sin esto hay que pulsar para averiguar de quién es.
    expect(screen.getByText('compartida')).toBeTruthy();
    expect(screen.getByText('del equipo')).toBeTruthy();
  });

  it('la del equipo se APLICA pero no se toca', async () => {
    const p = pintar({}, { vistas: [DEL_EQUIPO] });
    await userEvent.click(screen.getByRole('button', { name: /Urgentes del turno/ }));
    expect(p.alAplicarVista).toHaveBeenCalled();
    // Borrar o compartir la de otro es de su autor, igual que en la API.
    expect(screen.queryByRole('button', { name: /Borrar la vista/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /compartir/i })).toBeNull();
  });
});
