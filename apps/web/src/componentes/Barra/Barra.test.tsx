/**
 * El riel de navegación.
 *
 * Lo que se prueba es lo que el usuario pidió al señalar el cuadro vacío de
 * arriba: que ahí esté su perfil, que se le reconozca, y que lleve a su
 * pantalla. Antes había un cuadro de color decorativo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { Yo } from '../../api/tipos.ts';
import { Barra } from './Barra.tsx';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const YO: Yo = {
  userId: 'u1',
  tenantId: 't1',
  rol: 'owner',
  suscripcion: 'activa',
  nombre: 'Rosa Quispe',
  fotoId: null,
};

const api = (extra: Record<string, unknown> = {}) =>
  ({
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'blob:foto', expiraEnSegundos: 300, mime: null }),
    ...extra,
  }) as unknown as Api;

describe('Barra', () => {
  it('sin foto se pinta la inicial, no un hueco', () => {
    render(<Barra api={api()} yo={YO} alSalir={vi.fn()} />);
    const boton = screen.getByRole('button', { name: /Rosa Quispe/ });
    expect(boton.textContent).toContain('R');
  });

  it('con foto se pinta la foto, pedida con URL firmada', async () => {
    const a = api();
    const { container } = render(<Barra api={a} yo={{ ...YO, fotoId: 'm1' }} alSalir={vi.fn()} />);
    expect(a.urlDeMedio).toHaveBeenCalledWith('m1');
    // `alt=""` a propósito: la foto no aporta información que el nombre del
    // botón no diga ya, y leerla en voz alta sería ruido.
    await vi.waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:foto');
    });
  });

  it('lleva a Mi cuenta de un clic', async () => {
    render(<Barra api={api()} yo={YO} alSalir={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Rosa Quispe/ }));
    expect(window.location.hash).toContain('ajustes/perfil');
  });

  it('si la foto no carga, queda la inicial: una cara rota es peor', async () => {
    const a = api({ urlDeMedio: vi.fn().mockRejectedValue(new Error('caducada')) });
    render(<Barra api={a} yo={{ ...YO, fotoId: 'm1' }} alSalir={vi.fn()} />);
    const boton = await screen.findByRole('button', { name: /Rosa Quispe/ });
    expect(boton.textContent).toContain('R');
  });
});
