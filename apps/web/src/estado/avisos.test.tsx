/**
 * Avisos de mensaje nuevo. Lo que se prueba es el respeto al agente: no se
 * avisa de lo que está mirando, el permiso se pide con un gesto y el contador
 * del título se limpia al volver a la pestaña.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAvisos } from './avisos.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.title = 'Bandeja';
});

function visibilidad(estado: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: estado, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Pantalla() {
  const avisos = useAvisos();
  return (
    <div>
      <span data-testid="permiso">{avisos.permiso}</span>
      <button onClick={() => avisos.avisar({ titulo: 'Mensaje nuevo', cuerpo: 'Rosa escribió' })}>
        simular
      </button>
      <button onClick={() => void avisos.pedirPermiso()}>pedir</button>
    </div>
  );
}

describe('useAvisos', () => {
  it('no avisa de lo que el agente está mirando', async () => {
    visibilidad('visible');
    render(<Pantalla />);
    await userEvent.click(screen.getByText('simular'));
    expect(document.title).not.toContain('(');
  });

  it('con la pestaña de fondo, cuenta en el título y limpia al volver', async () => {
    render(<Pantalla />);
    visibilidad('hidden');
    await userEvent.click(screen.getByText('simular'));
    await userEvent.click(screen.getByText('simular'));
    expect(document.title).toBe('(2) Bandeja');
    visibilidad('visible');
    expect(document.title).toBe('Bandeja');
  });

  it('el permiso solo se pide cuando el agente lo pulsa', async () => {
    const pedir = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), { permission: 'default', requestPermission: pedir }),
    );
    render(<Pantalla />);
    expect(pedir).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('pedir'));
    expect(pedir).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('permiso').textContent).toBe('granted');
  });

  it('con permiso concedido, manda una notificación del navegador', async () => {
    const creadas: [string, { body?: string; tag?: string }][] = [];
    class NotificacionFalsa {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(titulo: string, opciones: { body?: string; tag?: string } = {}) {
        creadas.push([titulo, opciones]);
      }
      close() {}
    }
    vi.stubGlobal('Notification', NotificacionFalsa);
    render(<Pantalla />);
    visibilidad('hidden');
    await userEvent.click(screen.getByText('simular'));
    expect(creadas[0]![0]).toBe('Mensaje nuevo');
    // Mismo `tag`: cinco mensajes seguidos no apilan cinco ventanas.
    expect(creadas[0]![1].tag).toBe('crmapp-mensaje');
  });
});
