import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResumenDeConversacion } from '../../api/tipos.ts';
import { ListaDeConversaciones } from './ListaDeConversaciones.tsx';

const en = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const base: ResumenDeConversacion = {
  id: 'c1',
  canal: 'whatsapp',
  estado: 'open',
  tipo: 'dm',
  publicacionId: null,
  contacto: { id: 'p1', nombre: 'Ana Pérez', handle: '+51999', telefono: null, usuario: null },
  agenteId: null,
  equipoId: null,
  noLeidos: 3,
  ultimoEntranteEn: new Date().toISOString(),
  ultimoSalienteEn: null,
  ventanaExpiraEn: en(5),
  ventanaAbierta: true,
  etiquetas: [
    { id: 'e1', nombre: 'Urgente', color: '#ff3b30' },
    { id: 'e2', nombre: 'VIP', color: '#ff9500' },
    { id: 'e3', nombre: 'Sin color', color: null },
  ],
  vistaPrevia: 'Tiene el filtro GA16?',
  atencion: 'nueva',
  aplazadaHasta: null,
  enEspera: false,
  relevo: null,
};

afterEach(cleanup);

describe('ListaDeConversaciones', () => {
  it('pinta nombre, no leídos, ventana y etiquetas de color como franja', async () => {
    const seleccionar = vi.fn();
    render(
      <ListaDeConversaciones
        items={[
          base,
          {
            ...base,
            id: 'c2',
            contacto: { id: 'p2', nombre: 'Beto', handle: null, telefono: null, usuario: null },
            noLeidos: 0,
            ventanaExpiraEn: en(-1),
            etiquetas: [],
          },
        ]}
        seleccionadaId={null}
        marcadas={new Set()}
        alMarcar={vi.fn()}
        cargando={false}
        error={null}
        hayMas={false}
        alSeleccionar={seleccionar}
        alCargarMas={vi.fn()}
      />,
    );
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByLabelText('3 sin leer').textContent).toContain('3');
    expect(screen.getAllByText(/h \d\d min/)).toHaveLength(1);
    expect(screen.getByText('Ventana cerrada')).toBeTruthy();
    // Solo las etiquetas CON color forman la franja.
    const tramos = document.querySelectorAll('.franjaTramo');
    expect(tramos).toHaveLength(2);
    expect((tramos[0] as HTMLElement).style.getPropertyValue('--tag')).toBe('#ff3b30');

    await userEvent.click(screen.getByText('Ana Pérez'));
    expect(seleccionar).toHaveBeenCalledWith('c1');
  });

  it('vacío y error se explican', () => {
    const { rerender } = render(
      <ListaDeConversaciones
        items={[]}
        seleccionadaId={null}
        marcadas={new Set()}
        alMarcar={vi.fn()}
        cargando={false}
        error={null}
        hayMas={false}
        alSeleccionar={vi.fn()}
        alCargarMas={vi.fn()}
      />,
    );
    expect(screen.getByText('Nada por aquí')).toBeTruthy();
    rerender(
      <ListaDeConversaciones
        items={[]}
        seleccionadaId={null}
        marcadas={new Set()}
        alMarcar={vi.fn()}
        cargando={false}
        error="Sin conexión"
        hayMas={false}
        alSeleccionar={vi.fn()}
        alCargarMas={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Sin conexión');
  });

  it('la fila que pidió una persona lo dice, con el motivo a mano', () => {
    render(
      <ListaDeConversaciones
        items={[
          { ...base, relevo: { motivo: 'pregunta por un grupo de 20', en: null } },
          { ...base, id: 'c2', relevo: null },
        ]}
        seleccionadaId={null}
        marcadas={new Set()}
        alMarcar={vi.fn()}
        cargando={false}
        error={null}
        hayMas={false}
        alSeleccionar={vi.fn()}
        alCargarMas={vi.fn()}
      />,
    );
    const insignias = screen.getAllByText('Pide una persona');
    // Solo la que lo pidió: marcarlas todas sería no marcar ninguna.
    expect(insignias).toHaveLength(1);
    // El motivo no cabe en la fila, pero está al pasar el ratón.
    expect(insignias[0]!.getAttribute('title')).toBe('pregunta por un grupo de 20');
  });
});
