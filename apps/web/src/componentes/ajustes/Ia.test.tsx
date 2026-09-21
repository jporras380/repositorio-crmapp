import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { Ia } from './Ia.tsx';

afterEach(cleanup);

const PROVEEDORES = [
  {
    id: 'anthropic' as const,
    nombre: 'Claude (Anthropic)',
    modelos: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    dondeSacarLaClave: 'console.anthropic.com → API keys',
    aviso: '',
  },
  {
    id: 'google' as const,
    nombre: 'Gemini (Google)',
    modelos: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    dondeSacarLaClave: 'aistudio.google.com → Get API key',
    aviso:
      'El plan GRATUITO de Gemini usa lo que se le envía para mejorar los modelos de Google, ' +
      'y eso incluiría los mensajes de tus huéspedes.',
  },
  {
    id: 'openai' as const,
    nombre: 'GPT (OpenAI)',
    modelos: ['gpt-5', 'gpt-5-mini'],
    dondeSacarLaClave: 'platform.openai.com → API keys',
    aviso: '',
  },
];

const BASE = {
  activa: false,
  proveedor: 'anthropic' as const,
  modelo: 'claude-opus-5',
  instrucciones: '',
  tieneClave: false,
  proveedoresConClave: [] as ('anthropic' | 'google' | 'openai' | 'xai')[],
  modelosDisponibles: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  proveedores: PROVEEDORES,
};

describe('Ajustes → IA', () => {
  it('guarda la clave y la limpia del campo; la respuesta dice que quedó guardada', async () => {
    const guardarIa = vi
      .fn()
      .mockResolvedValue({ ...BASE, tieneClave: true, proveedoresConClave: ['anthropic'] });
    const api = { iaAjustes: vi.fn().mockResolvedValue(BASE), guardarIa } as unknown as Api;
    render(<Ia api={api} gestor={true} />);
    const campo = await screen.findByLabelText(/Clave de API de Claude/);
    await userEvent.type(campo, 'sk-ant-api03-una-clave-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(guardarIa).toHaveBeenCalledWith({
      proveedor: 'anthropic',
      modelo: 'claude-opus-5',
      instrucciones: '',
      clave: 'sk-ant-api03-una-clave-larga',
    });
    expect(
      await screen.findByText(/Clave verificada con Claude \(Anthropic\) y guardada/),
    ).toBeTruthy();
    expect((campo as HTMLInputElement).value).toBe('');
  });

  it('sin clave no se puede activar', async () => {
    const api = { iaAjustes: vi.fn().mockResolvedValue(BASE) } as unknown as Api;
    render(<Ia api={api} gestor={true} />);
    const activar = (await screen.findByRole('button', {
      name: 'Activar IA',
    })) as HTMLButtonElement;
    expect(activar.disabled).toBe(true);
  });

  it('un error de Anthropic se muestra tal cual', async () => {
    const api = {
      iaAjustes: vi
        .fn()
        .mockResolvedValue({ ...BASE, tieneClave: true, proveedoresConClave: ['anthropic'] }),
      guardarIa: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(422, 'ia_clave_rechazada', 'Anthropic rechazó la clave.'),
        ),
    } as unknown as Api;
    render(<Ia api={api} gestor={true} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activar IA' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Anthropic rechazó la clave.');
  });

  it('un agente ve el estado, no el formulario', async () => {
    const api = {
      iaAjustes: vi.fn().mockResolvedValue({
        ...BASE,
        activa: true,
        tieneClave: true,
        proveedoresConClave: ['anthropic'],
      }),
    } as unknown as Api;
    render(<Ia api={api} gestor={false} />);
    expect(await screen.findByText(/La IA está activada para tu equipo/)).toBeTruthy();
    expect(screen.queryByLabelText(/Clave de API de Anthropic/)).toBeNull();
  });
});

/**
 * Elegir proveedor (0038).
 *
 * El test que más importa es el del aviso de Gemini: sin él, un hotel mandaría
 * los mensajes de sus huéspedes —con teléfono, fechas y a veces tarjeta— a
 * entrenar un modelo, sin enterarse.
 */
describe('Ajustes → IA · varios proveedores', () => {
  const pintar = (extra: Record<string, unknown> = {}) => {
    const guardarIa = vi.fn().mockResolvedValue({ ...BASE, ...extra });
    const api = {
      iaAjustes: vi.fn().mockResolvedValue({ ...BASE, ...extra }),
      guardarIa,
      borrarClaveIa: vi.fn().mockResolvedValue(BASE),
    } as unknown as Api;
    render(<Ia api={api} gestor={true} />);
    return { api, guardarIa };
  };

  it('se puede elegir entre los proveedores que da el servidor', async () => {
    pintar();
    const selector = await screen.findByLabelText(/Quién redacta/);
    expect(selector).toBeTruthy();
    expect(screen.getByRole('option', { name: /Gemini \(Google\)/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /GPT \(OpenAI\)/ })).toBeTruthy();
  });

  it('elegir Gemini enseña el aviso del plan GRATUITO ANTES de pedir la clave', async () => {
    pintar();
    const selector = await screen.findByLabelText(/Quién redacta/);
    expect(screen.queryByText(/plan GRATUITO/)).toBeNull();

    await userEvent.selectOptions(selector, 'google');

    const aviso = await screen.findByText(/plan GRATUITO/);
    expect(aviso.textContent).toMatch(/mensajes de tus huéspedes/);
    // Va como alerta, no como pista gris: es lo que decide si esto se puede
    // usar con clientes reales.
    expect(aviso.getAttribute('role')).toBe('alert');
  });

  it('cambiar de proveedor cambia el modelo al suyo', async () => {
    pintar();
    const selector = await screen.findByLabelText(/Quién redacta/);
    expect((screen.getByLabelText(/^Modelo/) as HTMLInputElement).value).toBe('claude-opus-5');

    await userEvent.selectOptions(selector, 'google');
    // «claude-opus-5» no existe en Google: dejarlo escrito invitaría a guardar
    // una pareja imposible.
    expect((screen.getByLabelText(/^Modelo/) as HTMLInputElement).value).toBe('gemini-2.5-pro');
  });

  it('el campo de la clave dice de QUIÉN es y dónde sacarla', async () => {
    pintar();
    await userEvent.selectOptions(await screen.findByLabelText(/Quién redacta/), 'openai');
    expect(screen.getByLabelText(/Clave de API de GPT/)).toBeTruthy();
    expect(screen.getByText(/platform\.openai\.com/)).toBeTruthy();
  });

  it('dice qué proveedores tienen ya la clave guardada', async () => {
    pintar({ proveedoresConClave: ['anthropic', 'google'] });
    const opcion = (await screen.findByRole('option', {
      name: /Gemini/,
    })) as HTMLOptionElement;
    // Para no ir a buscar una clave que ya está puesta.
    expect(opcion.textContent).toContain('clave guardada');
  });

  it('el modelo se puede escribir a mano: los nombres cambian cada mes', async () => {
    const { guardarIa } = pintar({ proveedoresConClave: ['anthropic'] });
    const campo = await screen.findByLabelText(/^Modelo/);
    await userEvent.clear(campo);
    await userEvent.type(campo, 'claude-el-que-salga-manana');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(guardarIa).toHaveBeenCalledWith(
      expect.objectContaining({ modelo: 'claude-el-que-salga-manana' }),
    );
  });

  it('guardar manda también el proveedor elegido', async () => {
    const { guardarIa } = pintar();
    await userEvent.selectOptions(await screen.findByLabelText(/Quién redacta/), 'openai');
    await userEvent.type(
      screen.getByLabelText(/Clave de API/),
      'sk-proj-una-clave-larga-de-openai',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(guardarIa).toHaveBeenCalledWith(
      expect.objectContaining({ proveedor: 'openai', modelo: 'gpt-5' }),
    );
  });

  it('sin clave del proveedor elegido no se puede activar', async () => {
    pintar({ proveedoresConClave: ['anthropic'] });
    await userEvent.selectOptions(await screen.findByLabelText(/Quién redacta/), 'google');
    const activar = screen.getByRole('button', { name: 'Activar IA' }) as HTMLButtonElement;
    // Tener la de Anthropic no sirve para hablar con Google.
    expect(activar.disabled).toBe(true);
  });

  it('borrar la clave borra la del proveedor que se está mirando', async () => {
    const { api } = pintar({ proveedoresConClave: ['anthropic', 'google'] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.selectOptions(await screen.findByLabelText(/Quién redacta/), 'google');
    await userEvent.click(screen.getByRole('button', { name: 'Borrar clave' }));
    expect(api.borrarClaveIa).toHaveBeenCalledWith('google');
  });
});
