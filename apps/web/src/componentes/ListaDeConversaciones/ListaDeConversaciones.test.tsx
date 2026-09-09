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
  contacto: { id: 'p1', nombre: 'Ana Pérez', handle: '+51999' },
  agenteId: null,
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
            contacto: { id: 'p2', nombre: 'Beto', handle: null },
            noLeidos: 0,
            ventanaExpiraEn: en(-1),
            etiquetas: [],
          },
        ]}
        seleccionadaId={null}
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
        cargando={false}
        error="Sin conexión"
        hayMas={false}
        alSeleccionar={vi.fn()}
        alCargarMas={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Sin conexión');
  });
});
