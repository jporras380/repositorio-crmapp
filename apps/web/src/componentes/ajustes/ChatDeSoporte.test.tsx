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
  },
  {
    id: 'm2',
    deLaPlataforma: true,
    autor: 'Enrique',
    cuerpo: 'Lo miramos ahora.',
    creadoEn: '2026-09-21T14:05:00Z',
    leidoEn: null,
  },
];

function pintar(tenantId?: string, extra: Record<string, unknown> = {}) {
  const api = {
    mensajesDeSoporte: vi.fn().mockResolvedValue(HILO),
    escribirASoporte: vi.fn().mockResolvedValue(HILO),
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
      expect(api.escribirASoporte).toHaveBeenCalledWith('Sigue igual esta mañana'),
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
