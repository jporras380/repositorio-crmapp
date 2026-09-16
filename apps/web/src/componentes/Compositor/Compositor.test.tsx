import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  relevo: null,
};

const LIMITES = {
  mimesPermitidos: ['image/jpeg', 'image/png', 'video/mp4', 'application/pdf'],
  tamanoMaximo: 100 * 1024 * 1024,
  porCanal: {
    whatsapp: {
      tipos: ['text', 'image', 'video', 'audio', 'document', 'template'],
      limites: { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 },
    },
  },
};

function apiFalsa(enviar: Api['enviar'], extra: Record<string, unknown> = {}): Api {
  return {
    enviar,
    respuestasRapidas: vi.fn().mockResolvedValue([]),
    iaAjustes: vi.fn().mockResolvedValue({ activa: false }),
    limitesDeMedios: vi.fn().mockResolvedValue(LIMITES),
    prepararSubida: vi
      .fn()
      .mockImplementation((mime: string) =>
        Promise.resolve({ mediaAssetId: `m-${mime}`, urlDeSubida: 'https://x/put' }),
      ),
    confirmarSubida: vi.fn().mockResolvedValue({ mediaAssetId: 'm1' }),
    ...extra,
  } as unknown as Api;
}

/** Un archivo de mentira con el peso que haga falta. */
function archivo(nombre: string, mime: string, bytes = 1024): File {
  const f = new File(['x'], nombre, { type: mime });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
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

  describe('adjuntos', () => {
    // La subida va directa al almacén con un PUT firmado, fuera del cliente de
    // la API: sin esto, el test saldría a la red de verdad.
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    });
    afterEach(() => vi.unstubAllGlobals());

    const elegir = async (...archivos: File[]) => {
      const entrada = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(entrada, archivos);
    };

    it('elegir un archivo NO lo envía: primero se ve, luego se manda', async () => {
      const enviar = vi.fn().mockResolvedValue({ messageId: 'm1', estado: 'queued' });
      render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={vi.fn()} />);
      await screen.findByLabelText('Mensaje');
      await elegir(archivo('playa.jpg', 'image/jpeg'));

      // Está en la bandeja, con su nombre, y todavía no ha salido nada.
      expect(screen.getByText('playa.jpg')).toBeTruthy();
      expect(enviar).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
      expect(enviar).toHaveBeenCalledTimes(1);
      expect(enviar.mock.calls[0]![1]).toMatchObject({ tipo: 'image' });
    });

    it('tres fotos son tres mensajes, en orden, y el pie va solo en el primero', async () => {
      const enviar = vi.fn().mockResolvedValue({ messageId: 'm', estado: 'queued' });
      render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={vi.fn()} />);
      await screen.findByLabelText('Mensaje');
      await elegir(
        archivo('una.jpg', 'image/jpeg'),
        archivo('dos.png', 'image/png'),
        archivo('tres.jpg', 'image/jpeg'),
      );
      await userEvent.type(screen.getByLabelText('Mensaje'), 'Las vistas del bungalow');
      await userEvent.click(screen.getByRole('button', { name: 'Enviar 3' }));

      expect(enviar).toHaveBeenCalledTimes(3);
      // WhatsApp no tiene álbumes: son tres mensajes. Y el pie, una vez.
      const pies = enviar.mock.calls.map((c) => (c[1] as { pieDeFoto?: string }).pieDeFoto);
      expect(pies).toEqual(['Las vistas del bungalow', undefined, undefined]);
    });

    it('un vídeo de 30 MB se marca antes de subirlo, y no deja enviar', async () => {
      const enviar = vi.fn();
      render(<Compositor api={apiFalsa(enviar)} conversacion={conversacion} alEnviado={vi.fn()} />);
      await screen.findByLabelText('Mensaje');
      await elegir(archivo('tour.mp4', 'video/mp4', 30 * 1024 * 1024));

      expect(screen.getByText(/máximo para video es 16\.0 MB/)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
      expect(enviar).not.toHaveBeenCalled();
      expect((await screen.findByRole('alert')).textContent).toContain('marcados en rojo');
    });

    it('un vídeo del iPhone dice qué hacer, en vez de no dejar elegirlo', async () => {
      render(
        <Compositor api={apiFalsa(vi.fn())} conversacion={conversacion} alEnviado={vi.fn()} />,
      );
      await screen.findByLabelText('Mensaje');
      await elegir(archivo('IMG_0042.MOV', 'video/quicktime'));
      expect(screen.getByText(/solo admite vídeo MP4/)).toBeTruthy();
    });

    it('se puede quitar uno de la bandeja sin tocar los otros', async () => {
      render(
        <Compositor api={apiFalsa(vi.fn())} conversacion={conversacion} alEnviado={vi.fn()} />,
      );
      await screen.findByLabelText('Mensaje');
      await elegir(archivo('una.jpg', 'image/jpeg'), archivo('dos.jpg', 'image/jpeg'));
      await userEvent.click(screen.getByRole('button', { name: 'Quitar una.jpg' }));
      expect(screen.queryByText('una.jpg')).toBeNull();
      expect(screen.getByText('dos.jpg')).toBeTruthy();
    });
  });
});
