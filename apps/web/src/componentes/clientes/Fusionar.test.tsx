/**
 * Unir dos fichas del mismo huésped.
 *
 * Lo que se prueba es lo que protege al agente de un error caro: que la propia
 * ficha nunca se ofrezca, que no se una nada sin elegir antes, y que los dos
 * nombres se vean antes de confirmar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import { Fusionar } from './Fusionar.tsx';

afterEach(cleanup);

function apiFalsa(extra: Record<string, unknown> = {}): Api {
  return {
    duplicadosDeCliente: vi
      .fn()
      .mockResolvedValue([{ id: 'dup1', nombre: 'Ana Garcia', porque: 'mismo nombre' }]),
    clientes: vi.fn().mockResolvedValue({
      items: [
        { id: 'otro', nombre: 'Ana G. Torres', telefono: '+51999', email: null },
        { id: 'yo', nombre: 'Ana García', telefono: '+51900', email: null },
      ],
      siguienteCursor: null,
    }),
    fusionarClientes: vi.fn().mockResolvedValue({ movidas: 3 }),
    ...extra,
  } as unknown as Api;
}

function pintar(api = apiFalsa()) {
  const alHecho = vi.fn();
  const alCerrar = vi.fn();
  render(
    <Fusionar
      api={api}
      destinoId="yo"
      nombreDestino="Ana García"
      alHecho={alHecho}
      alCerrar={alCerrar}
    />,
  );
  return { api, alHecho, alCerrar };
}

describe('Fusionar', () => {
  it('propone los duplicados que manda el servidor, con su motivo', async () => {
    pintar();
    expect(await screen.findByText('Ana Garcia')).toBeTruthy();
    expect(screen.getByText('mismo nombre')).toBeTruthy();
  });

  it('nunca se ofrece la propia ficha al buscar', async () => {
    pintar();
    await screen.findByText('Ana Garcia');
    await userEvent.type(screen.getByLabelText('O busca la otra ficha'), 'Ana');
    // La búsqueda devuelve la ficha abierta entre los resultados; no se pinta.
    expect(await screen.findByText('Ana G. Torres')).toBeTruthy();
    expect(screen.queryByText('+51900')).toBeNull();
  });

  it('no se une nada hasta elegir, y antes se ven los dos nombres', async () => {
    const { api } = pintar();
    await screen.findByText('Ana Garcia');
    expect(screen.queryByRole('button', { name: 'Unir las dos fichas' })).toBeNull();

    await userEvent.click(screen.getByText('Ana Garcia'));
    // Los dos nombres, en la misma frase, antes de confirmar.
    expect(screen.getByText(/Se unirá/).textContent).toContain('Ana Garcia');
    expect(screen.getByText(/Se unirá/).textContent).toContain('Ana García');

    await userEvent.click(screen.getByRole('button', { name: 'Unir las dos fichas' }));
    expect(api.fusionarClientes).toHaveBeenCalledWith('yo', 'dup1', 'duplicado');
  });

  it('el motivo que se escribe es el que se manda', async () => {
    const { api } = pintar();
    await screen.findByText('Ana Garcia');
    await userEvent.click(screen.getByText('Ana Garcia'));

    const motivo = screen.getByLabelText(/Por qué/);
    await userEvent.clear(motivo);
    await userEvent.type(motivo, 'escribió desde otro número');
    await userEvent.click(screen.getByRole('button', { name: 'Unir las dos fichas' }));

    expect(api.fusionarClientes).toHaveBeenCalledWith('yo', 'dup1', 'escribió desde otro número');
  });

  it('si el servidor dice que no, se ve el motivo y no se cierra', async () => {
    const api = apiFalsa({
      fusionarClientes: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(409, 'ya_fusionado', 'Uno de los dos ya está fusionado.'),
        ),
    });
    const { alCerrar } = pintar(api);
    await screen.findByText('Ana Garcia');
    await userEvent.click(screen.getByText('Ana Garcia'));
    await userEvent.click(screen.getByRole('button', { name: 'Unir las dos fichas' }));

    expect((await screen.findByRole('alert')).textContent).toContain('ya está fusionado');
    expect(alCerrar).not.toHaveBeenCalled();
  });
});
