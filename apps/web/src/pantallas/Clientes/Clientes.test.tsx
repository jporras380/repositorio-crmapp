/**
 * La pantalla de Clientes.
 *
 * Se prueba lo que se usa todos los días: que la lista diga quién es quién, y
 * que buscar consulte al SERVIDOR — filtrar en el navegador escondería justo
 * lo que la paginación no ha traído.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Sesion } from '../../api/tipos.ts';
import { Clientes } from './Clientes.tsx';

afterEach(cleanup);

const SESION: Sesion = {
  token: 't',
  tenantId: 'te1',
  userId: 'u1',
  rol: 'owner',
} as unknown as Sesion;

const CLIENTE = {
  id: 'c1',
  nombre: 'Rosa Díaz',
  telefono: '+51999333111',
  email: 'rosa@ejemplo.com',
  ciudad: 'Huacho',
  origen: 'whatsapp',
  tipoDeHuesped: 'Familia',
  etiquetas: [{ id: 'e1', nombre: 'Fiestas Patrias', color: '#FF9F0A' }],
  canales: ['whatsapp'],
  creadoEn: '2026-09-01T12:00:00Z',
  ultimaActividad: '2026-09-11T12:00:00Z',
};

const api = {
  clientes: vi.fn().mockResolvedValue({ items: [CLIENTE], siguienteCursor: null }),
  cliente: vi.fn().mockResolvedValue({
    ...CLIENTE,
    notas: null,
    identidades: [],
    conversaciones: [],
    reservas: [],
  }),
  etiquetas: vi.fn().mockResolvedValue([]),
  yo: vi.fn().mockResolvedValue({ rol: 'owner', suscripcion: 'activa' }),
  editarCliente: vi.fn().mockResolvedValue({ editado: true }),
  crearCliente: vi.fn().mockResolvedValue({ id: 'c2' }),
  exportarClientes: vi.fn().mockResolvedValue({ csv: 'nombre\nRosa', nombreDeArchivo: 'c.csv' }),
};

vi.mock('../../api/cliente.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  crearApi: () => api,
}));

describe('Clientes', () => {
  it('la lista identifica a cada persona sin abrir su ficha', async () => {
    render(<Clientes sesion={SESION} clienteId={null} alSalir={vi.fn()} />);
    expect(await screen.findByText('Rosa Díaz')).toBeTruthy();
    expect(screen.getByText('+51999333111')).toBeTruthy();
    expect(screen.getByText('Huacho')).toBeTruthy();
    expect(screen.getByText('Fiestas Patrias')).toBeTruthy();
  });

  it('buscar pregunta al servidor, no filtra lo que ya tiene', async () => {
    render(<Clientes sesion={SESION} clienteId={null} alSalir={vi.fn()} />);
    await screen.findByText('Rosa Díaz');
    api.clientes.mockClear();
    await userEvent.type(screen.getByLabelText('Buscar clientes'), 'Rosa');
    await waitFor(() => expect(api.clientes).toHaveBeenCalled());
    expect(api.clientes.mock.calls.at(-1)![0]).toMatchObject({ q: 'Rosa' });
  });

  it('filtrar por origen también viaja al servidor', async () => {
    render(<Clientes sesion={SESION} clienteId={null} alSalir={vi.fn()} />);
    await screen.findByText('Rosa Díaz');
    api.clientes.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('Filtrar por origen'), 'instagram');
    await waitFor(() =>
      expect(api.clientes.mock.calls.at(-1)![0]).toMatchObject({ origen: 'instagram' }),
    );
  });

  it('con un cliente elegido se abre su ficha al lado', async () => {
    render(<Clientes sesion={SESION} clienteId="c1" alSalir={vi.fn()} />);
    expect(await screen.findByLabelText('Cliente: Rosa Díaz')).toBeTruthy();
    expect(screen.getByDisplayValue('rosa@ejemplo.com')).toBeTruthy();
  });

  it('editar un campo guarda al salir del foco, sin botón de guardar', async () => {
    render(<Clientes sesion={SESION} clienteId="c1" alSalir={vi.fn()} />);
    const ciudad = await screen.findByDisplayValue('Huacho');
    await userEvent.clear(ciudad);
    await userEvent.type(ciudad, 'Barranca');
    await userEvent.tab();
    await waitFor(() =>
      expect(api.editarCliente).toHaveBeenCalledWith('c1', { ciudad: 'Barranca' }),
    );
  });
});
