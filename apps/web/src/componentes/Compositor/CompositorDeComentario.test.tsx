import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ResumenDeConversacion } from '../../api/tipos.ts';
import { CompositorDeComentario } from './CompositorDeComentario.tsx';

const hilo: ResumenDeConversacion = {
  id: 'c-com',
  canal: 'instagram',
  estado: 'open',
  tipo: 'comment_thread',
  publicacionId: 'post.7',
  contacto: { id: 'p1', nombre: 'caro.rp', handle: 'caro.rp' },
  agenteId: null,
  noLeidos: 1,
  ultimoEntranteEn: null,
  ultimoSalienteEn: null,
  ventanaExpiraEn: null,
  ventanaAbierta: false,
  etiquetas: [],
  vistaPrevia: 'Precio?',
  atencion: 'nueva',
  aplazadaHasta: null,
  relevo: null,
};

const api = (enviar: unknown) => ({ enviar }) as unknown as Api;

afterEach(cleanup);

describe('CompositorDeComentario', () => {
  it('Enter responde en privado: es donde se captura el lead', async () => {
    const enviar = vi.fn().mockResolvedValue({ id: 'm1', createdAt: '', estado: 'queued' });
    render(
      <CompositorDeComentario
        api={api(enviar)}
        conversacion={hilo}
        mensajes={[]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(
      screen.getByLabelText('Respuesta al comentario'),
      'Te paso precios{Enter}',
    );
    expect(enviar).toHaveBeenCalledWith('c-com', {
      tipo: 'comment_reply',
      modo: 'privada',
      texto: 'Te paso precios',
    });
  });

  it('«En público» cuelga la respuesta del comentario', async () => {
    const enviar = vi.fn().mockResolvedValue({ id: 'm2', createdAt: '', estado: 'queued' });
    render(
      <CompositorDeComentario
        api={api(enviar)}
        conversacion={hilo}
        mensajes={[]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Respuesta al comentario'), 'Gracias');
    await userEvent.click(screen.getByRole('button', { name: 'En público' }));
    expect(enviar).toHaveBeenLastCalledWith('c-com', {
      tipo: 'comment_reply',
      modo: 'publica',
      texto: 'Gracias',
    });
  });

  it('si la persona no acepta privados, lo explica sin alarmar y ofrece el público', async () => {
    const enviar = vi
      .fn()
      .mockRejectedValueOnce(
        new ErrorDeApi(422, 'canal_destinatario_invalido', 'Meta (100/2534014): no disponible'),
      )
      .mockResolvedValueOnce({ id: 'm3', createdAt: '', estado: 'queued' });
    render(
      <CompositorDeComentario
        api={api(enviar)}
        conversacion={hilo}
        mensajes={[]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Respuesta al comentario'), 'Hola{Enter}');

    // El mensaje del proveedor no le sirve de nada al agente; el nuestro sí.
    expect(screen.getByRole('alert').textContent).toContain('no acepta mensajes privados');
    await userEvent.click(screen.getByRole('button', { name: 'Responder en el comentario' }));
    expect(enviar).toHaveBeenLastCalledWith('c-com', {
      tipo: 'comment_reply',
      modo: 'publica',
      texto: 'Hola',
    });
  });

  it('otro error se muestra tal cual, sin sugerir el público', async () => {
    const enviar = vi
      .fn()
      .mockRejectedValue(new ErrorDeApi(402, 'suscripcion_suspendida', 'Cuenta suspendida.'));
    render(
      <CompositorDeComentario
        api={api(enviar)}
        conversacion={hilo}
        mensajes={[]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Respuesta al comentario'), 'x{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('Cuenta suspendida.');
    expect(screen.queryByRole('button', { name: 'Responder en el comentario' })).toBeNull();
  });

  it('avisa de que la privada es una sola ANTES de pulsarla', async () => {
    render(
      <CompositorDeComentario
        api={api(vi.fn())}
        conversacion={hilo}
        mensajes={[]}
        alEnviado={vi.fn()}
      />,
    );
    expect(screen.getByText(/una sola por comentario/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'En privado' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('si ya se gastó, el botón no se ofrece: pulsarlo solo daría un error', async () => {
    const enviada = {
      id: 'm9',
      direccion: 'outbound' as const,
      tipo: 'text',
      texto: 'Te escribo por privado',
      estado: 'sent',
      origen: 'human',
      generado_por_ia: false,
      autor_id: null,
      autor: null,
      autor_foto_id: null,
      creado_en: new Date().toISOString(),
      error: null,
      medio_id: null,
      medio_estado: null,
      medio_nombre: null,
      modo_comentario: 'privada' as const,
    };
    render(
      <CompositorDeComentario
        api={api(vi.fn())}
        conversacion={hilo}
        mensajes={[enviada]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Respuesta al comentario'), 'otra más');
    expect(screen.getByText(/ya se usó/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'En privado' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // La pública sigue disponible: es lo que le queda al agente.
    expect((screen.getByRole('button', { name: 'En público' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('una privada FALLIDA no gasta el cupo: no salió nada', async () => {
    const fallida = {
      id: 'm8',
      direccion: 'outbound' as const,
      tipo: 'text',
      texto: 'no salió',
      estado: 'failed',
      origen: 'human',
      generado_por_ia: false,
      autor_id: null,
      autor: null,
      autor_foto_id: null,
      creado_en: new Date().toISOString(),
      error: { mensaje: 'rechazado' },
      medio_id: null,
      medio_estado: null,
      medio_nombre: null,
      modo_comentario: 'privada' as const,
    };
    render(
      <CompositorDeComentario
        api={api(vi.fn())}
        conversacion={hilo}
        mensajes={[fallida]}
        alEnviado={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Respuesta al comentario'), 'reintento');
    expect((screen.getByRole('button', { name: 'En privado' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
