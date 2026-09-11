/**
 * El constructor de flujos.
 *
 * Lo que se prueba no es que pinte tarjetas, sino las tres cosas que hacen que
 * construir un bot no acabe en un grafo roto: los pasos se leen en el orden
 * del recorrido, insertar engancha y borrar RE-engancha. Y que no se pueda
 * activar un flujo con avisos, que es lo que protege al cliente.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { DetalleDeFlujo, GrafoDeFlujo } from '../../api/tipos.ts';
import { EditorDeFlujo } from './EditorDeFlujo.tsx';

afterEach(cleanup);

const GRAFO: GrafoDeFlujo = {
  inicio: 'saludo',
  nodos: [
    { id: 'saludo', tipo: 'mensaje', texto: 'Hola', siguiente: 'espera' },
    { id: 'espera', tipo: 'esperar_respuesta', segundos: 3600, siguiente: 'fin', alExpirar: 'fin' },
    { id: 'fin', tipo: 'fin' },
  ],
};

function detalle(extra: Partial<DetalleDeFlujo> = {}): DetalleDeFlujo {
  return {
    id: 'f1',
    nombre: 'Bienvenida',
    estado: 'borrador',
    version: null,
    disparadores: [{ tipo: 'conversacion_abierta' }],
    ejecucionesVivas: 0,
    creadoEn: '2026-09-10T00:00:00Z',
    grafo: GRAFO,
    problemas: [],
    ...extra,
  };
}

function pintar(
  d: DetalleDeFlujo = detalle(),
  probar = vi.fn().mockResolvedValue({ pasos: [], final: 'fin', problemas: [] }),
) {
  const api = {
    flujo: vi.fn().mockResolvedValue(d),
    etiquetas: vi.fn().mockResolvedValue([{ id: 'e1', nombre: 'Lead', color: '#f90' }]),
    usuarios: vi.fn().mockResolvedValue([{ id: 'u1', nombre: 'Ana', rol: 'admin' }]),
    probarFlujo: probar,
    guardarFlujo: vi.fn().mockResolvedValue({ version: 2 }),
    publicarFlujo: vi.fn().mockResolvedValue({ version: 1 }),
    pausarFlujo: vi.fn().mockResolvedValue({ pausado: true }),
  } as unknown as Api;
  render(<EditorDeFlujo api={api} flujoId="f1" alCambiar={vi.fn()} />);
  return api;
}

describe('EditorDeFlujo', () => {
  it('pinta los pasos en el orden del recorrido y marca dónde empieza', async () => {
    pintar();
    expect(await screen.findByDisplayValue('Hola')).toBeTruthy();
    // Por el nombre del paso en su tarjeta, no por texto suelto: los mismos
    // nombres salen en los desplegables de destino.
    const tipos = [...document.querySelectorAll('.pasoTipo')].map((t) => t.textContent);
    expect(tipos).toEqual(['Enviar mensaje', 'Esperar respuesta', 'Terminar']);
    expect(screen.getByText('empieza aquí')).toBeTruthy();
  });

  it('insertar un paso lo engancha entre el actual y su siguiente', async () => {
    pintar();
    await screen.findByDisplayValue('Hola');
    const insertar = screen.getAllByRole('button', { name: '+ Paso aquí debajo' })[0]!;
    await userEvent.click(insertar);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Poner etiqueta' }));

    // El paso nuevo existe y el saludo ahora lleva a él, no directamente a la espera.
    const tipos = [...document.querySelectorAll('.pasoTipo')].map((t) => t.textContent);
    expect(tipos).toEqual(['Enviar mensaje', 'Poner etiqueta', 'Esperar respuesta', 'Terminar']);
    const enlaces = screen.getAllByRole('combobox');
    // El primer «Luego» del saludo apunta al paso recién creado.
    expect((enlaces[0] as HTMLSelectElement).value).toBe('paso4');
  });

  it('borrar un paso re-engancha el flujo en vez de partirlo', async () => {
    pintar();
    await screen.findByDisplayValue('Hola');
    await userEvent.click(screen.getByRole('button', { name: 'Quitar el paso espera' }));

    const tipos = [...document.querySelectorAll('.pasoTipo')].map((t) => t.textContent);
    expect(tipos).toEqual(['Enviar mensaje', 'Terminar']);
    // El saludo hereda el destino de la espera: sigue llevando a «fin».
    const enlaces = screen.getAllByRole('combobox');
    expect((enlaces[0] as HTMLSelectElement).value).toBe('fin');
  });

  it('una pausa se añade en segundos y avisa de que mientras calla no escucha', async () => {
    const probar = vi.fn().mockResolvedValue({ pasos: [], final: 'fin', problemas: [] });
    pintar(detalle(), probar);
    await screen.findByDisplayValue('Hola');
    await userEvent.click(screen.getAllByRole('button', { name: '+ Paso aquí debajo' })[0]!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pausa' }));

    const tipos = [...document.querySelectorAll('.pasoTipo')].map((t) => t.textContent);
    expect(tipos).toEqual(['Enviar mensaje', 'Pausa', 'Esperar respuesta', 'Terminar']);
    // La consecuencia que no se ve en el formulario, dicha donde se decide.
    expect(screen.getByText(/mientras calla no escucha/i)).toBeTruthy();
    // Y en segundos, que es la escala en la que sirve: no en minutos.
    await waitFor(() => {
      const ultimo = probar.mock.calls.at(-1);
      expect(ultimo?.[0].nodos.find((n: { tipo: string }) => n.tipo === 'pausa').segundos).toBe(5);
    });
  });

  it('no deja activar un flujo con avisos', async () => {
    const probar = vi.fn().mockResolvedValue({
      pasos: [],
      final: 'fin',
      problemas: [{ codigo: 'bucle_sin_espera', mensaje: 'El paso «a» forma un bucle.' }],
    });
    pintar(detalle(), probar);
    await screen.findByDisplayValue('Hola');
    await waitFor(() => expect(screen.getByText('El paso «a» forma un bucle.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Activar' }).hasAttribute('disabled')).toBe(true);
  });

  it('un flujo activo ofrece pausar, no activar', async () => {
    pintar(detalle({ estado: 'activo', version: 3 }));
    expect(await screen.findByText('Activo · v3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activar' })).toBeNull();
  });

  it('la prueba se pide con el grafo que está en pantalla, no con el guardado', async () => {
    const probar = vi.fn().mockResolvedValue({ pasos: [], final: 'fin', problemas: [] });
    pintar(detalle(), probar);
    await screen.findByDisplayValue('Hola');
    await userEvent.clear(screen.getByLabelText('Texto del mensaje'));
    await userEvent.type(screen.getByLabelText('Texto del mensaje'), 'Buenas');

    await waitFor(() => {
      const ultimo = probar.mock.calls.at(-1);
      expect(ultimo?.[0].nodos[0].texto).toBe('Buenas');
    });
  });
});
