/**
 * Editor de plantillas. Se prueba lo que ahorra intentos ante Meta: el nombre
 * se corrige solo, pide un ejemplo por variable antes de dejar enviar, y lo
 * que se manda tiene la forma que espera la API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { NuevaPlantilla } from './NuevaPlantilla.tsx';

afterEach(cleanup);

function pintar(
  crearPlantilla = vi.fn().mockResolvedValue({ id: 'p1', estado: 'PENDING', avisos: [] }),
) {
  const alCreada = vi.fn();
  render(
    <NuevaPlantilla
      api={{ crearPlantilla } as unknown as Api}
      cuentaId="ca-1"
      alCancelar={() => {}}
      alCreada={alCreada}
    />,
  );
  return { crearPlantilla, alCreada };
}

const enviar = () => screen.getByRole('button', { name: 'Enviar a revisión' }) as HTMLButtonElement;

describe('NuevaPlantilla', () => {
  it('el nombre se corrige solo a lo que Meta admite', async () => {
    pintar();
    const campo = screen.getByLabelText(/Nombre/);
    await userEvent.type(campo, 'Confirmación Reserva');
    expect((campo as HTMLInputElement).value).toBe('confirmaci_n_reserva');
  });

  it('con variables, no deja enviar hasta que cada una tiene ejemplo', async () => {
    const { crearPlantilla } = pintar();
    await userEvent.type(screen.getByLabelText(/Nombre/), 'confirmacion');
    // Las llaves se escapan en el simulador de teclado: se fija el valor.
    fireEvent.change(screen.getByLabelText('Cuerpo'), {
      target: { value: 'Hola {{1}}, tu reserva del {{2}}.' },
    });
    expect(screen.getByText(/Falta el ejemplo de alguna variable/)).toBeTruthy();
    expect(enviar().disabled).toBe(true);

    await userEvent.type(screen.getByLabelText('{{1}}'), 'Rosa');
    await userEvent.type(screen.getByLabelText('{{2}}'), '12 de julio');
    expect(enviar().disabled).toBe(false);
    await userEvent.click(enviar());
    expect(crearPlantilla).toHaveBeenCalledWith('ca-1', {
      nombre: 'confirmacion',
      idioma: 'es',
      categoria: 'UTILITY',
      cuerpo: 'Hola {{1}}, tu reserva del {{2}}.',
      ejemplos: ['Rosa', '12 de julio'],
    });
  });

  it('los botones de respuesta rápida viajan con la plantilla', async () => {
    const { crearPlantilla } = pintar();
    await userEvent.type(screen.getByLabelText(/Nombre/), 'aviso');
    await userEvent.type(screen.getByLabelText('Cuerpo'), 'Tu reserva está confirmada.');
    await userEvent.click(screen.getByRole('button', { name: '+ botón' }));
    await userEvent.type(screen.getByLabelText('Botón 1'), 'Ver detalles');
    await userEvent.click(enviar());
    expect(crearPlantilla.mock.calls[0]![1].botones).toEqual(['Ver detalles']);
  });

  it('si Meta la rechaza, se muestra su motivo', async () => {
    pintar(
      vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(
            422,
            'plantilla_rechazada_por_meta',
            'Meta no aceptó la plantilla: nombre en uso.',
          ),
        ),
    );
    await userEvent.type(screen.getByLabelText(/Nombre/), 'repetida');
    await userEvent.type(screen.getByLabelText('Cuerpo'), 'Texto.');
    await userEvent.click(enviar());
    expect((await screen.findByRole('alert')).textContent).toContain('nombre en uso');
  });
});
