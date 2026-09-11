import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GaleriaDePlantillas } from './GaleriaDePlantillas.tsx';
import { PLANTILLAS } from './plantillas.ts';

afterEach(cleanup);

describe('GaleriaDePlantillas', () => {
  it('ofrece todas las plantillas y dice con qué arranca cada una', () => {
    render(<GaleriaDePlantillas ocupado={false} alElegir={vi.fn()} alCerrar={vi.fn()} />);
    for (const p of PLANTILLAS) expect(screen.getByText(p.nombre)).toBeTruthy();
    expect(screen.getByText(/Arranca con: precio/)).toBeTruthy();
  });

  it('elegir devuelve la plantilla entera, con su grafo y sus disparadores', async () => {
    const elegir = vi.fn();
    render(<GaleriaDePlantillas ocupado={false} alElegir={elegir} alCerrar={vi.fn()} />);
    await userEvent.click(screen.getByText('Calificar el lead'));
    expect(elegir.mock.calls[0]![0].id).toBe('calificar');
    expect(elegir.mock.calls[0]![0].grafo.nodos.length).toBeGreaterThan(3);
  });

  it('mientras crea, no se puede elegir dos veces', () => {
    render(<GaleriaDePlantillas ocupado={true} alElegir={vi.fn()} alCerrar={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.hasAttribute('disabled')).toBe(true);
    }
  });
});
