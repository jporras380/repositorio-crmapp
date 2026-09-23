/**
 * El chat con soporte.
 *
 * El mismo componente lo usan el cliente y el operador, con los lados
 * invertidos, así que lo que más se prueba es justo eso: que cada uno vea sus
 * propios mensajes de su lado. Confundirlo haría parecer que el cliente se
 * responde a sí mismo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { MensajeDeSoporte } from '../../api/tipos.ts';
import { ChatDeSoporte } from './ChatDeSoporte.tsx';

afterEach(cleanup);

const HILO: MensajeDeSoporte[] = [
  {
    id: 'm1',
    deLaPlataforma: false,
    autor: 'Rosa',
    cuerpo: 'No me llegan los mensajes de WhatsApp desde ayer.',
    creadoEn: '2026-09-21T14:00:00Z',
    leidoEn: null,
    medioId: null,
    medioMime: null,
    medioNombre: null,
  },
  {
    id: 'm2',
    deLaPlataforma: true,
    autor: 'Enrique',
    cuerpo: 'Lo miramos ahora.',
    creadoEn: '2026-09-21T14:05:00Z',
    leidoEn: null,
    medioId: null,
    medioMime: null,
    medioNombre: null,
  },
];

function pintar(tenantId?: string, extra: Record<string, unknown> = {}) {
  const api = {
    mensajesDeSoporte: vi.fn().mockResolvedValue(HILO),
    escribirASoporte: vi.fn().mockResolvedValue(HILO),
    prepararSubida: vi
      .fn()
      .mockResolvedValue({ mediaAssetId: 'md-1', urlDeSubida: 'https://s3/put' }),
    confirmarSubida: vi.fn().mockResolvedValue({ mediaAssetId: 'md-1' }),
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'https://s3/firmada.png', expiraEnSegundos: 300 }),
    adjuntoDeSoporte: vi
      .fn()
      .mockResolvedValue({ url: 'https://s3/firmada-op.png', expiraEnSegundos: 300 }),
    hiloDeSoporteDe: vi.fn().mockResolvedValue(HILO),
    responderASoporte: vi.fn().mockResolvedValue(HILO),
    ...extra,
  } as unknown as Api;
  render(<ChatDeSoporte api={api} tenantId={tenantId} />);
  return api;
}

describe('Chat de soporte · lado del cliente', () => {
  it('pinta el hilo con quién dijo cada cosa', async () => {
    pintar();
    expect(await screen.findByText(/No me llegan los mensajes/)).toBeTruthy();
    expect(screen.getByText('Rosa')).toBeTruthy();
    // De soporte se dice que es soporte: en una cuenta con varios agentes,
    // «Enrique» a secas no distingue de quién viene.
    expect(screen.getByText('Enrique · soporte')).toBeTruthy();
  });

  it('lo del propio equipo va a la derecha y lo de soporte a la izquierda', async () => {
    pintar();
    await screen.findByText(/No me llegan/);
    const mio = screen.getByText(/No me llegan/).closest('div[class*="fila"]')!;
    const suyo = screen.getByText('Lo miramos ahora.').closest('div[class*="fila"]')!;
    expect(mio.className).toContain('filaPropia');
    expect(suyo.className).not.toContain('filaPropia');
  });

  it('escribir manda el mensaje y vacía el campo', async () => {
    const api = pintar();
    await screen.findByText(/No me llegan/);
    const campo = screen.getByLabelText('Mensaje para soporte');
    await userEvent.type(campo, 'Sigue igual esta mañana');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() =>
      expect(api.escribirASoporte).toHaveBeenCalledWith('Sigue igual esta mañana', undefined),
    );
    expect((campo as HTMLTextAreaElement).value).toBe('');
  });

  it('Enter envía y Mayús+Enter salta de línea', async () => {
    const api = pintar();
    await screen.findByText(/No me llegan/);
    const campo = screen.getByLabelText('Mensaje para soporte');

    await userEvent.type(campo, 'primera{Shift>}{Enter}{/Shift}segunda');
    expect(api.escribirASoporte).not.toHaveBeenCalled();
    expect((campo as HTMLTextAreaElement).value).toContain('\n');

    await userEvent.type(campo, '{Enter}');
    await waitFor(() => expect(api.escribirASoporte).toHaveBeenCalled());
  });

  it('un mensaje vacío no se puede enviar', async () => {
    pintar();
    await screen.findByText(/No me llegan/);
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('el hilo vacío invita a escribir, no deja una caja en blanco', async () => {
    pintar(undefined, { mensajesDeSoporte: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText(/Cuéntanos qué te pasa/)).toBeTruthy();
  });

  it('si no se puede enviar, se dice', async () => {
    pintar(undefined, {
      escribirASoporte: vi.fn().mockRejectedValue(new ErrorDeApi(500, 'x', 'Se cayó el servidor.')),
    });
    await screen.findByText(/No me llegan/);
    await userEvent.type(screen.getByLabelText('Mensaje para soporte'), 'hola');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Se cayó');
  });
});

describe('Chat de soporte · lado del operador', () => {
  it('pide el hilo de ESA cuenta, no el propio', async () => {
    const api = pintar('te-99');
    await screen.findByText(/No me llegan/);
    expect(api.hiloDeSoporteDe).toHaveBeenCalledWith('te-99');
    expect(api.mensajesDeSoporte).not.toHaveBeenCalled();
  });

  it('los lados se invierten: lo de la plataforma es lo propio', async () => {
    pintar('te-99');
    await screen.findByText(/No me llegan/);
    // Si no se invirtiera, el operador vería sus propias respuestas como si
    // las hubiera escrito el cliente.
    const delCliente = screen.getByText(/No me llegan/).closest('div[class*="fila"]')!;
    const mio = screen.getByText('Lo miramos ahora.').closest('div[class*="fila"]')!;
    expect(mio.className).toContain('filaPropia');
    expect(delCliente.className).not.toContain('filaPropia');
  });

  it('responder va a la cuenta correcta', async () => {
    const api = pintar('te-99');
    await screen.findByText(/No me llegan/);
    await userEvent.type(screen.getByLabelText('Mensaje para soporte'), 'Ya está arreglado');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(api.responderASoporte).toHaveBeenCalledWith('te-99', 'Ya está arreglado'),
    );
  });

  it('una cuenta que no ha escrito lo dice con sus palabras', async () => {
    pintar('te-99', { hiloDeSoporteDe: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText(/no ha escrito todavía/)).toBeTruthy();
  });
});

/**
 * Capturas (0044).
 *
 * Lo que se prueba es lo que el usuario pidio -«que pueda mandar foto o video
 * cuando soporte se lo pida»- y lo que sostiene la promesa de la consola: cada
 * lado firma la URL por SU camino, y el operador no adjunta.
 */
describe('Chat de soporte · capturas', () => {
  const CON_CAPTURA: MensajeDeSoporte[] = [
    {
      id: 'm3',
      deLaPlataforma: false,
      autor: 'Rosa',
      cuerpo: '',
      creadoEn: '2026-09-21T14:10:00Z',
      leidoEn: null,
      medioId: 'md-1',
      medioMime: 'image/png',
      medioNombre: 'pantalla.png',
    },
  ];

  it('una captura del cliente se ve, y se firma por SU camino', async () => {
    const api = pintar(undefined, { mensajesDeSoporte: vi.fn().mockResolvedValue(CON_CAPTURA) });
    const img = (await screen.findByAltText('pantalla.png')) as HTMLImageElement;
    expect(img.src).toBe('https://s3/firmada.png');
    // El cliente usa la ruta de medios de siempre: RLS ya le resuelve lo suyo.
    expect(api.urlDeMedio).toHaveBeenCalledWith('md-1');
    expect(api.adjuntoDeSoporte).not.toHaveBeenCalled();
  });

  it('el operador la pide por la ruta acotada del hilo, no por la de medios', async () => {
    const api = pintar('te-99', { hiloDeSoporteDe: vi.fn().mockResolvedValue(CON_CAPTURA) });
    await screen.findByAltText('pantalla.png');
    // Esto es lo que sostiene «el operador no ve conversaciones»: su unica via
    // a un medio ajeno exige que cuelgue de un mensaje de soporte.
    expect(api.adjuntoDeSoporte).toHaveBeenCalledWith('te-99', 'md-1');
    expect(api.urlDeMedio).not.toHaveBeenCalled();
  });

  it('un mensaje que es solo captura no pinta un cuerpo vacio', async () => {
    pintar(undefined, { mensajesDeSoporte: vi.fn().mockResolvedValue(CON_CAPTURA) });
    await screen.findByAltText('pantalla.png');
    expect(document.querySelector('[class*="cuerpo"]')).toBeNull();
  });

  it('un video sale como video, no como imagen rota', async () => {
    pintar(undefined, {
      mensajesDeSoporte: vi
        .fn()
        .mockResolvedValue([
          { ...CON_CAPTURA[0]!, medioMime: 'video/mp4', medioNombre: 'error.mp4' },
        ]),
    });
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(screen.queryByAltText('error.mp4')).toBeNull();
  });

  it('si la URL caduca o falla, se dice en vez de dejar un hueco', async () => {
    pintar(undefined, {
      mensajesDeSoporte: vi.fn().mockResolvedValue(CON_CAPTURA),
      urlDeMedio: vi.fn().mockRejectedValue(new ErrorDeApi(404, 'x', 'No existe.')),
    });
    expect(await screen.findByText(/No se pudo abrir/)).toBeTruthy();
  });

  it('adjuntar sube al elegir el archivo, y envia solo el identificador', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const api = pintar();
      await screen.findByText(/No me llegan/);
      const archivo = new File(['x'], 'pantalla.png', { type: 'image/png' });
      await userEvent.upload(
        document.getElementById('adjunto-de-soporte') as HTMLInputElement,
        archivo,
      );

      // Se sube al ELEGIR, no al enviar: un video por datos moviles haria
      // parecer que «Enviar» esta colgado.
      await waitFor(() => expect(api.confirmarSubida).toHaveBeenCalledWith('md-1'));
      expect(await screen.findByText('pantalla.png')).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
      // Sin texto: la captura ya dice algo.
      await waitFor(() => expect(api.escribirASoporte).toHaveBeenCalledWith('', 'md-1'));
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('sin texto pero con captura, «Enviar» se habilita', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      pintar();
      await screen.findByText(/No me llegan/);
      const enviar = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
      expect(enviar.disabled).toBe(true);
      await userEvent.upload(
        document.getElementById('adjunto-de-soporte') as HTMLInputElement,
        new File(['x'], 'pantalla.png', { type: 'image/png' }),
      );
      await waitFor(() => expect(enviar.disabled).toBe(false));
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('se puede quitar antes de enviar', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      pintar();
      await screen.findByText(/No me llegan/);
      await userEvent.upload(
        document.getElementById('adjunto-de-soporte') as HTMLInputElement,
        new File(['x'], 'pantalla.png', { type: 'image/png' }),
      );
      await userEvent.click(await screen.findByRole('button', { name: 'Quitar pantalla.png' }));
      expect(screen.queryByRole('button', { name: /Quitar/ })).toBeNull();
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('el operador NO tiene boton de adjuntar', async () => {
    pintar('te-99');
    await screen.findByText(/No me llegan/);
    // Cuanto menos escriba soporte en la cuenta de un cliente, menos hay que
    // explicar despues.
    expect(document.getElementById('adjunto-de-soporte')).toBeNull();
  });

  it('si la subida al almacen falla, se dice y no se adjunta nada', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    try {
      pintar();
      await screen.findByText(/No me llegan/);
      await userEvent.upload(
        document.getElementById('adjunto-de-soporte') as HTMLInputElement,
        new File(['x'], 'pantalla.png', { type: 'image/png' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain('No se pudo subir');
      expect(screen.queryByRole('button', { name: /Quitar/ })).toBeNull();
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});
