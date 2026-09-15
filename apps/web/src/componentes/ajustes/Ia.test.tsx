import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { Ia } from './Ia.tsx';

afterEach(cleanup);

const BASE = {
  activa: false,
  modelo: 'claude-opus-5',
  instrucciones: '',
  tieneClave: false,
  modelosDisponibles: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
};

describe('Ajustes → IA', () => {
  it('guarda la clave y la limpia del campo; la respuesta dice que quedó guardada', async () => {
    const guardarIa = vi.fn().mockResolvedValue({ ...BASE, tieneClave: true });
    const api = { iaAjustes: vi.fn().mockResolvedValue(BASE), guardarIa } as unknown as Api;
    render(<Ia api={api} gestor={true} />);
    const campo = await screen.findByLabelText(/Clave de API de Anthropic/);
    await userEvent.type(campo, 'sk-ant-api03-una-clave-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(guardarIa).toHaveBeenCalledWith({
      modelo: 'claude-opus-5',
      instrucciones: '',
      clave: 'sk-ant-api03-una-clave-larga',
    });
    expect(await screen.findByText(/Clave verificada con Anthropic y guardada/)).toBeTruthy();
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
      iaAjustes: vi.fn().mockResolvedValue({ ...BASE, tieneClave: true }),
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
      iaAjustes: vi.fn().mockResolvedValue({ ...BASE, activa: true, tieneClave: true }),
    } as unknown as Api;
    render(<Ia api={api} gestor={false} />);
    expect(await screen.findByText(/La IA está activada para tu equipo/)).toBeTruthy();
    expect(screen.queryByLabelText(/Clave de API de Anthropic/)).toBeNull();
  });
});
