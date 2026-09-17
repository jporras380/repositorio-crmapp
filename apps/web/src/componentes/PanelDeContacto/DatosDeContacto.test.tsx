/**
 * Teléfono y usuario en la ficha.
 *
 * Lo que se prueba es lo que el usuario pidió al señalar la línea unida: que
 * cada dato tenga su copiar, que solo aparezca lo que existe, y que se pueda
 * añadir el número cuando la conversación llegó solo con nombre de usuario.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { DatosDeContacto } from './DatosDeContacto.tsx';

afterEach(cleanup);

function pintar(
  telefono: string | null,
  usuario: string | null,
  extra: Record<string, unknown> = {},
) {
  const escribir = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: escribir } });
  const api = { editarCliente: vi.fn().mockResolvedValue(undefined), ...extra } as unknown as Api;
  const alCambiar = vi.fn();
  render(
    <DatosDeContacto
      api={api}
      contactoId="c1"
      telefono={telefono}
      usuario={usuario}
      alCambiar={alCambiar}
    />,
  );
  return { api, escribir, alCambiar };
}

describe('DatosDeContacto', () => {
  it('con los dos datos hay dos líneas y dos botones de copiar', () => {
    pintar('+51925300224', 'joperami1');
    expect(screen.getByText('+51925300224')).toBeTruthy();
    expect(screen.getByText('@joperami1')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Copiar/ })).toHaveLength(2);
  });

  it('copiar el teléfono copia SOLO el teléfono, sin el usuario', async () => {
    const { escribir } = pintar('+51925300224', 'joperami1');
    await userEvent.click(screen.getByRole('button', { name: 'Copiar teléfono' }));
    expect(escribir).toHaveBeenCalledWith('+51925300224');
    // Y se nota que se pulsó: sin eso la gente pulsa dos veces por si acaso.
    expect(await screen.findByText('Copiado')).toBeTruthy();
  });

  it('copiar el usuario lleva su arroba, que es como se busca', async () => {
    const { escribir } = pintar('+51925300224', 'joperami1');
    await userEvent.click(screen.getByRole('button', { name: 'Copiar usuario' }));
    expect(escribir).toHaveBeenCalledWith('@joperami1');
  });

  it('sin teléfono se ofrece añadirlo: WhatsApp ya deja escribir solo con usuario', async () => {
    const { api, alCambiar } = pintar(null, 'joperami1');
    expect(screen.queryByRole('button', { name: 'Copiar teléfono' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '+ Añadir teléfono' }));
    await userEvent.type(screen.getByLabelText('Número de teléfono'), '+51999888777');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(api.editarCliente).toHaveBeenCalledWith('c1', { telefono: '+51999888777' });
    expect(alCambiar).toHaveBeenCalled();
  });

  it('con teléfono NO se ofrece añadirlo', () => {
    pintar('+51925300224', null);
    expect(screen.queryByRole('button', { name: '+ Añadir teléfono' })).toBeNull();
  });

  it('si el servidor rechaza el número, se ve el motivo y no se pierde lo escrito', async () => {
    const { api } = pintar(null, 'joperami1', {
      editarCliente: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(409, 'contacto_duplicado', 'Ya hay otro con ese teléfono.'),
        ),
    });
    await userEvent.click(screen.getByRole('button', { name: '+ Añadir teléfono' }));
    await userEvent.type(screen.getByLabelText('Número de teléfono'), '+51999888777');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Ya hay otro');
    expect((screen.getByLabelText('Número de teléfono') as HTMLInputElement).value).toBe(
      '+51999888777',
    );
    void api;
  });
});
