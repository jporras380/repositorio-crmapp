/**
 * La pantalla de apariencia.
 *
 * Lo que se prueba es que elegir cambie el documento de verdad y al momento —
 * un ajuste de aspecto que hay que recargar para ver no sirve— y que se diga
 * lo que cuesta cada nivel, porque «Cristal» se ve mejor en una captura y peor
 * en una jornada de ocho horas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Apariencia } from './Apariencia.tsx';

const raiz = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  raiz().removeAttribute('data-theme');
  raiz().removeAttribute('data-vidrio');
  // jsdom no trae matchMedia.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Apariencia', () => {
  it('ofrece los tres niveles de transparencia y los tres temas', () => {
    render(<Apariencia />);
    for (const n of ['Sólido', 'Vidrio', 'Cristal', 'Automático', 'Claro', 'Oscuro']) {
      expect(screen.getByRole('radio', { name: new RegExp(n) })).toBeTruthy();
    }
  });

  it('arranca en lo de siempre: automático y vidrio', () => {
    render(<Apariencia />);
    expect((screen.getByRole('radio', { name: /Automático/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole('radio', { name: /^Vidrio/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('elegir oscuro cambia el documento al momento', async () => {
    render(<Apariencia />);
    await userEvent.click(screen.getByRole('radio', { name: /Oscuro/ }));
    expect(raiz().getAttribute('data-theme')).toBe('dark');
  });

  it('elegir sólido apaga la transparencia y lo dice', async () => {
    render(<Apariencia />);
    await userEvent.click(screen.getByRole('radio', { name: /Sólido/ }));
    expect(raiz().getAttribute('data-vidrio')).toBe('solido');
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('volver a «Vidrio» quita el atributo, para que el sistema vuelva a mandar', async () => {
    render(<Apariencia />);
    await userEvent.click(screen.getByRole('radio', { name: /Cristal/ }));
    expect(raiz().getAttribute('data-vidrio')).toBe('cristal');
    await userEvent.click(screen.getByRole('radio', { name: /^Vidrio/ }));
    expect(raiz().hasAttribute('data-vidrio')).toBe(false);
  });

  it('lo elegido sobrevive a cerrar la pantalla', async () => {
    const { unmount } = render(<Apariencia />);
    await userEvent.click(screen.getByRole('radio', { name: /Cristal/ }));
    unmount();

    render(<Apariencia />);
    expect((screen.getByRole('radio', { name: /Cristal/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('dice que «Cristal» se lee peor: es la letra pequeña de lo bonito', () => {
    render(<Apariencia />);
    expect(screen.getByText(/menos legible/)).toBeTruthy();
  });

  it('dice que se guarda solo en este navegador', async () => {
    render(<Apariencia />);
    await userEvent.click(screen.getByRole('radio', { name: /Oscuro/ }));
    expect((await screen.findByRole('status')).textContent).toContain('este navegador');
  });

  it('el aviso del sistema solo sale a quien le afecta', async () => {
    render(<Apariencia />);
    expect(screen.queryByText(/pide menos transparencia/)).toBeNull();
    cleanup();

    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(<Apariencia />);
    expect(screen.getByText(/pide menos transparencia/)).toBeTruthy();
  });
});
