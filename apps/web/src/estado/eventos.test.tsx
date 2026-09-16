/**
 * Escucha de eventos en vivo. Lo que se prueba es lo que rompe una pantalla:
 * que el token va en la cabecera (no en la URL), que un evento partido en dos
 * trozos se entiende igual, que los latidos no se confunden con eventos, y
 * que al desmontar se corta la conexión.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEventos, type EventoEnVivo } from './eventos.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Flujo SSE falso: se le van empujando trozos de texto. */
function flujoFalso() {
  let empujar!: (t: string) => void;
  let cerrar!: () => void;
  const cuerpo = new ReadableStream<Uint8Array>({
    start(control) {
      const cod = new TextEncoder();
      empujar = (t) => control.enqueue(cod.encode(t));
      cerrar = () => control.close();
    },
  });
  return { cuerpo, empujar: (t: string) => empujar(t), cerrar: () => cerrar() };
}

function Pantalla({
  token,
  alEvento,
}: {
  token: string | null;
  alEvento: (e: EventoEnVivo) => void;
}) {
  useEventos(token, alEvento);
  return null;
}

describe('useEventos', () => {
  it('manda el token en la cabecera, no en la URL', async () => {
    const { cuerpo } = flujoFalso();
    const fetchFalso = vi.fn().mockResolvedValue(new Response(cuerpo, { status: 200 }));
    vi.stubGlobal('fetch', fetchFalso);
    render(<Pantalla token="tok-123" alEvento={vi.fn()} />);
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    const [url, opciones] = fetchFalso.mock.calls[0]!;
    expect(String(url)).not.toContain('tok-123');
    expect(opciones.headers.authorization).toBe('Bearer tok-123');
  });

  it('entiende un evento aunque llegue partido, e ignora los latidos', async () => {
    const flujo = flujoFalso();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(flujo.cuerpo, { status: 200 })));
    const recibidos: EventoEnVivo[] = [];
    render(<Pantalla token="t" alEvento={(e) => recibidos.push(e)} />);

    await waitFor(() => expect(recibidos).toHaveLength(0));
    flujo.empujar(': latido\n\n');
    flujo.empujar('event: mensaje.recibido\ndata: {"tipo":"mensaje.recibido","id":"m1",');
    flujo.empujar('"conversacionId":"c1"}\n\n');

    await waitFor(() =>
      expect(recibidos).toEqual([{ tipo: 'mensaje.recibido', id: 'm1', conversacionId: 'c1' }]),
    );
  });

  it('sin sesión no abre nada', () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);
    render(<Pantalla token={null} alEvento={vi.fn()} />);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('al desmontar corta la conexión', async () => {
    const flujo = flujoFalso();
    const fetchFalso = vi.fn().mockResolvedValue(new Response(flujo.cuerpo, { status: 200 }));
    vi.stubGlobal('fetch', fetchFalso);
    const { unmount } = render(<Pantalla token="t" alEvento={vi.fn()} />);
    await waitFor(() => expect(fetchFalso).toHaveBeenCalled());
    const senal = fetchFalso.mock.calls[0]![1].signal as AbortSignal;
    expect(senal.aborted).toBe(false);
    unmount();
    expect(senal.aborted).toBe(true);
  });
});
