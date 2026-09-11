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

function apiFalsa(enviar: Api['enviar']): Api {
  return { enviar, respuestasRapidas: vi.fn().mockResolvedValue([]) } as unknown as Api;
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
});
