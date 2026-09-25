import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import type { ConfiguracionDeReparto } from '../../api/tipos.ts';
import { Reparto } from './Reparto.tsx';

afterEach(cleanup);

const CONFIG: ConfiguracionDeReparto = {
  modo: 'off',
  visibilidad: 'all',
  miembros: [
    { userId: 'u1', nombre: 'Ana', email: 'ana@h.pe', rol: 'agent', recibe: true, abiertas: 4 },
    { userId: 'u2', nombre: 'Beto', email: 'beto@h.pe', rol: 'owner', recibe: false, abiertas: 0 },
  ],
};

describe('Ajustes → Reparto', () => {
  it('encenderlo lo guarda y dice entre cuántas personas reparte', async () => {
    const guardarReparto = vi.fn().mockResolvedValue({ ...CONFIG, modo: 'least_busy' });
    const api = {
      reparto: vi.fn().mockResolvedValue(CONFIG),
      equipos: vi.fn().mockResolvedValue([]),
      guardarReparto,
    } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    expect(
      await screen.findByText(/Apagado: las conversaciones nuevas quedan sin asignar/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Encender reparto' }));
    expect(guardarReparto).toHaveBeenCalledWith({ modo: 'least_busy' });
    expect(await screen.findByText('Encendido: reparte entre 1 persona.')).toBeTruthy();
  });

  it('marcar a alguien lo mete en el reparto', async () => {
    const guardarReparto = vi.fn().mockResolvedValue(CONFIG);
    const api = {
      reparto: vi.fn().mockResolvedValue(CONFIG),
      equipos: vi.fn().mockResolvedValue([]),
      guardarReparto,
    } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Beto/ }));
    expect(guardarReparto).toHaveBeenCalledWith({ miembros: [{ userId: 'u2', recibe: true }] });
  });

  it('encendido sin nadie marcado avisa de que quedarán sin asignar', async () => {
    const api = {
      // Visibilidad ofrece «por equipos» solo si los hay (PR-97): sin este
      // mock, su propio fallo taparía al que se está probando.
      equipos: vi.fn().mockResolvedValue([]),
      reparto: vi.fn().mockResolvedValue({
        modo: 'least_busy',
        visibilidad: 'all',
        miembros: CONFIG.miembros.map((m) => ({ ...m, recibe: false })),
      }),
    } as unknown as Api;
    render(<Reparto api={api} administra={true} />);
    expect(await screen.findByText(/nadie está marcado para recibir/)).toBeTruthy();
  });

  it('quien no administra ve el reparto pero no lo cambia', async () => {
    const api = {
      reparto: vi.fn().mockResolvedValue(CONFIG),
      equipos: vi.fn().mockResolvedValue([]),
    } as unknown as Api;
    render(<Reparto api={api} administra={false} />);
    const casilla = (await screen.findByRole('checkbox', { name: /Ana/ })) as HTMLInputElement;
    expect(casilla.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /reparto/ })).toBeNull();
  });
});

/**
 * Visibilidad entre agentes (PR-96).
 *
 * La regla se aplicaba desde 0010 en la bandeja y en el embudo, y no había
 * dónde cambiarla: se hacía con un PATCH a mano. Lo que se prueba aquí es lo
 * que protege a los huéspedes —que decidir quién lee su correspondencia no
 * es de cualquiera— y que no se ofrece una opción que no hace lo que dice.
 */
describe('Ajustes → Qué ve cada agente', () => {
  function pintar(
    config: ConfiguracionDeReparto,
    administra = true,
    equipos: { id: string; nombre: string; miembros: []; abiertas: number }[] = [],
  ) {
    const guardarVisibilidad = vi.fn().mockResolvedValue({ ...config, visibilidad: 'assigned' });
    const api = {
      // Visibilidad ofrece «por equipos» solo si los hay (PR-97).
      equipos: vi.fn().mockResolvedValue(equipos),
      reparto: vi.fn().mockResolvedValue(config),
      guardarReparto: vi.fn(),
      guardarVisibilidad,
    } as unknown as Api;
    render(<Reparto api={api} administra={administra} />);
    return { guardarVisibilidad };
  }

  it('dice que solo afecta a los agentes: es la duda que genera este ajuste', async () => {
    pintar(CONFIG);
    expect(await screen.findByText(/Solo afecta al rol/)).toBeTruthy();
    expect(screen.getByText(/ven siempre toda la bandeja/)).toBeTruthy();
  });

  it('cada opción explica qué hace, no solo cómo se llama', async () => {
    pintar(CONFIG);
    expect(await screen.findByText(/se cubren entre todos/)).toBeTruthy();
    // Que las sin asignar se sigan viendo es lo que evita el fallo caro:
    // una consulta nueva que nadie atiende.
    expect(screen.getByText(/Las sin asignar también/)).toBeTruthy();
  });

  it('sin equipos NO ofrece «por equipos»', async () => {
    pintar(CONFIG);
    await screen.findByText(/Toda la bandeja/);
    // Sin equipos se comporta igual que «solo las suyas»: ofrecerla sería
    // prometer algo que no pasa.
    expect(screen.queryByText(/Las de sus equipos/)).toBeNull();
  });

  it('con equipos SÍ la ofrece: PR-97 la hizo real', async () => {
    pintar(CONFIG, true, [{ id: 'e1', nombre: 'Recepción', miembros: [], abiertas: 0 }]);
    expect(await screen.findByText(/Las de sus equipos/)).toBeTruthy();
    // Y explica el caso concreto, no la mecánica.
    expect(screen.getByText(/Recepción no ve lo de Mantenimiento/)).toBeTruthy();
  });

  it('cambiarla la guarda', async () => {
    const { guardarVisibilidad } = pintar(CONFIG);
    await userEvent.click(await screen.findByRole('radio', { name: /Solo las suyas/ }));
    expect(guardarVisibilidad).toHaveBeenCalledWith('assigned');
  });

  it('la elegida sale marcada', async () => {
    pintar({ ...CONFIG, visibilidad: 'assigned' });
    const suyas = (await screen.findByRole('radio', {
      name: /Solo las suyas/,
    })) as HTMLInputElement;
    expect(suyas.checked).toBe(true);
    expect(
      (screen.getByRole('radio', { name: /Toda la bandeja/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('en «team» pero sin ningún equipo, lo dice y dice dónde crearlos', async () => {
    pintar({ ...CONFIG, visibilidad: 'team' });
    // Marcar otra opción sería mentir sobre lo que está pasando; y sin decir
    // dónde se arregla, el aviso es una queja.
    expect(await screen.findByText(/no tiene ninguno/)).toBeTruthy();
    expect(screen.getByText(/Ajustes → Equipo/)).toBeTruthy();
  });

  it('quien no administra la ve pero no la toca', async () => {
    pintar(CONFIG, false);
    const todas = (await screen.findByRole('radio', {
      name: /Toda la bandeja/,
    })) as HTMLInputElement;
    // Dejar entrar a la correspondencia de los huéspedes no es decisión de
    // cualquiera del equipo.
    expect(todas.disabled).toBe(true);
  });
});
