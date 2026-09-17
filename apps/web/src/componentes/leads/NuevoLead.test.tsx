/**
 * Alta manual de una oportunidad.
 *
 * Lo que se prueba es el caso del hotel: alguien llama, no está en la lista, y
 * hay que anotarlo sin colgar el teléfono. Y que elegir a un cliente que ya
 * existe no cree una ficha duplicada, que sería el daño de esta pantalla.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EtapaDeEmbudo } from '../../api/tipos.ts';
import { NuevoLead } from './NuevoLead.tsx';

afterEach(cleanup);

const ETAPAS = [
  { id: 'e1', nombre: 'Consulta', orden: 1, color: null },
  { id: 'e2', nombre: 'Cotización enviada', orden: 2, color: null },
] as unknown as EtapaDeEmbudo[];

function apiFalsa(extra: Record<string, unknown> = {}): Api {
  return {
    clientes: vi.fn().mockResolvedValue({
      items: [{ id: 'c1', nombre: 'Rosa Quispe', telefono: '+51900', email: null }],
      siguienteCursor: null,
    }),
    crearCliente: vi.fn().mockResolvedValue({ id: 'nuevo' }),
    crearLead: vi.fn().mockResolvedValue({ id: 'l1' }),
    ...extra,
  } as unknown as Api;
}

function pintar(api = apiFalsa()) {
  const alCreado = vi.fn();
  const alCerrar = vi.fn();
  render(<NuevoLead api={api} etapas={ETAPAS} alCreado={alCreado} alCerrar={alCerrar} />);
  return { api, alCreado, alCerrar };
}

describe('NuevoLead', () => {
  it('con un cliente que ya existe NO se crea otra ficha', async () => {
    const { api } = pintar();
    await userEvent.type(screen.getByLabelText('Cliente'), 'Rosa');
    await userEvent.click(await screen.findByText('Rosa Quispe'));
    await userEvent.type(screen.getByLabelText('Qué quiere'), 'Bungalow para julio');
    await userEvent.click(screen.getByRole('button', { name: 'Crear oportunidad' }));

    expect(api.crearCliente).not.toHaveBeenCalled();
    expect(api.crearLead).toHaveBeenCalledWith(
      expect.objectContaining({ contactoId: 'c1', titulo: 'Bungalow para julio', etapaId: 'e1' }),
    );
  });

  it('quien llama y no está se crea de una vez, sin ir a otra pantalla', async () => {
    const { api } = pintar();
    await userEvent.type(screen.getByLabelText('Cliente'), 'Julio Nuevo');
    await userEvent.type(screen.getByLabelText('Teléfono'), '+51988');
    await userEvent.click(screen.getByRole('button', { name: 'Crear oportunidad' }));

    expect(api.crearCliente).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Julio Nuevo', telefono: '+51988' }),
    );
    expect(api.crearLead).toHaveBeenCalledWith(expect.objectContaining({ contactoId: 'nuevo' }));
  });

  it('sin cliente no se puede crear nada', () => {
    pintar();
    expect(
      (screen.getByRole('button', { name: 'Crear oportunidad' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('se puede elegir la etapa en la que entra', async () => {
    const { api } = pintar();
    await userEvent.type(screen.getByLabelText('Cliente'), 'Rosa');
    await userEvent.click(await screen.findByText('Rosa Quispe'));
    await userEvent.selectOptions(screen.getByLabelText('Etapa'), 'e2');
    await userEvent.click(screen.getByRole('button', { name: 'Crear oportunidad' }));

    expect(api.crearLead).toHaveBeenCalledWith(expect.objectContaining({ etapaId: 'e2' }));
  });

  it('si el servidor falla se ve el motivo y no se cierra el panel', async () => {
    const api = apiFalsa({
      crearLead: vi
        .fn()
        .mockRejectedValue(new ErrorDeApi(422, 'etapa_desconocida', 'Esa etapa no existe.')),
    });
    const { alCerrar } = pintar(api);
    await userEvent.type(screen.getByLabelText('Cliente'), 'Rosa');
    await userEvent.click(await screen.findByText('Rosa Quispe'));
    await userEvent.click(screen.getByRole('button', { name: 'Crear oportunidad' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Esa etapa no existe');
    expect(alCerrar).not.toHaveBeenCalled();
  });
});
