import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ResumenDeConversacion } from '../../api/tipos.ts';
import { Compositor } from './Compositor.tsx';

const conversacion: ResumenDeConversacion = {
  id: 'c1',
  canal: 'whatsapp',
  estado: 'open',
  tipo: 'dm',
  publicacionId: null,
  contacto: { id: 'p1', nombre: 'Ana', handle: null },
  agenteId: null,
  noLeidos: 0,
  ultimoEntranteEn: null,
  ultimoSalienteEn: null,
  ventanaExpiraEn: null,
  ventanaAbierta: false,
  etiquetas: [],
  vistaPrevia: null,
  atencion: 'nueva',
  aplazadaHasta: null,
};

function apiFalsa(enviar: Api['enviar'], extra: Record<string, unknown> = {}): Api {
  return {
    enviar,
    respuestasRapidas: vi.fn().mockResolvedValue([]),
    iaAjustes: vi.fn().mockResolvedValue({ activa: false }),
    ...extra,
  } as unknown as Api;
}

afterEach(cleanup);

describe('Compositor', () => {
  it('envía texto con Enter y limpia', async () => {
    const enviar = vi.fn().mockResolvedValue({ id: 'm1', createdAt: '', estado: 'queued' });
    const alEnviado = vi.fn();
    render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={alEnviado} />);
    const area = screen.getByLabelText('Mensaje');
    await userEvent.type(area, 'hola{Enter}');
    expect(enviar).toHaveBeenCalledWith('c1', { tipo: 'text', texto: 'hola' });
    expect(alEnviado).toHaveBeenCalled();
    expect((area as HTMLTextAreaElement).value).toBe('');
  });

  it('fuera de ventana: muestra el motivo y las plantillas que la API sugiere, y envía la elegida', async () => {
    const enviar = vi
      .fn()
      .mockRejectedValueOnce(
        new ErrorDeApi(409, 'fuera_de_ventana', 'La ventana de 24 horas está cerrada.', {
          plantillasSugeridas: [{ id: 't1', nombre: 'bienvenida', idioma: 'es' }],
        }),
      )
      .mockResolvedValueOnce({ id: 'm2', createdAt: '', estado: 'queued' });
    render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mensaje'), 'tarde{Enter}');

    expect(screen.getByRole('alert').textContent).toContain('La ventana de 24 horas está cerrada.');
    const boton = screen.getByRole('button', { name: /bienvenida/ });
    await userEvent.click(boton);
    expect(enviar).toHaveBeenLastCalledWith('c1', {
      tipo: 'template',
      nombre: 'bienvenida',
      idioma: 'es',
      parametros: [],
    });
  });

  it('un error sin plantillas no ofrece ninguna', async () => {
    const enviar = vi
      .fn()
      .mockRejectedValue(new ErrorDeApi(402, 'suscripcion_suspendida', 'Cuenta suspendida.'));
    render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Mensaje'), 'x{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('Cuenta suspendida.');
    expect(screen.queryByRole('button', { name: /Enviar «/ })).toBeNull();
  });

  it('sin IA activada no aparece el botón de sugerir', async () => {
    render(<Compositor api={apiFalsa(vi.fn())} conversacion={conversacion} alEnviado={vi.fn()} />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Sugerir respuesta con IA' })).toBeNull();
  });

  it('con IA: el borrador llena el área SIN enviarse, y al enviarlo va marcado como IA', async () => {
    const enviar = vi.fn().mockResolvedValue({ id: 'm3', createdAt: '', estado: 'queued' });
    const sugerirRespuesta = vi
      .fn()
      .mockResolvedValue({ texto: 'Hola Ana, sí tenemos.', modelo: 'claude-opus-5' });
    render(
      <Compositor
        api={apiFalsa(enviar, {
          iaAjustes: vi.fn().mockResolvedValue({ activa: true }),
          sugerirRespuesta,
        })}
        conversacion={conversacion}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sugerir respuesta con IA' }));
    const area = screen.getByLabelText('Mensaje') as HTMLTextAreaElement;
    expect(area.value).toBe('Hola Ana, sí tenemos.');
    expect(enviar).not.toHaveBeenCalled();
    expect(screen.getByText(/Borrador de la IA: revísalo antes de enviar/)).toBeTruthy();

    // El agente lo corrige y lo envía: sigue siendo un borrador de la IA.
    await userEvent.type(area, ' ¿Fechas?{Enter}');
    expect(enviar).toHaveBeenCalledWith('c1', {
      tipo: 'text',
      texto: 'Hola Ana, sí tenemos. ¿Fechas?',
      generadoPorIa: true,
    });
  });

  it('si la IA falla, lo dice y no toca lo que había escrito', async () => {
    render(
      <Compositor
        api={apiFalsa(vi.fn(), {
          iaAjustes: vi.fn().mockResolvedValue({ activa: true }),
          sugerirRespuesta: vi
            .fn()
            .mockRejectedValue(new ErrorDeApi(429, 'ia_limite', 'La cuenta alcanzó su límite.')),
        })}
        conversacion={conversacion}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Mensaje'), 'mi texto');
    await userEvent.click(await screen.findByRole('button', { name: 'Sugerir respuesta con IA' }));
    expect((await screen.findByRole('alert')).textContent).toContain('alcanzó su límite');
    expect((screen.getByLabelText('Mensaje') as HTMLTextAreaElement).value).toBe('mi texto');
  });
});
