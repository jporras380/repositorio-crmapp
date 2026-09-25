/**
 * El equipo de la cuenta.
 *
 * Lo que se prueba es lo que faltaba de verdad: que se pueda dar de alta a
 * alguien, que el tope del plan se vea ANTES de escribir el correo, y que el
 * enlace —que solo aparece una vez— no se pierda por el camino.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Equipo as EquipoDeLaCuenta } from '../../api/tipos.ts';
import { Equipo } from './Equipo.tsx';

afterEach(cleanup);

const ahora = Date.now();

function equipo(p: Partial<EquipoDeLaCuenta> = {}): EquipoDeLaCuenta {
  return {
    miembros: [
      { id: 'u1', nombre: 'Rosa', email: 'rosa@elparaiso.pe', rol: 'owner', esTu: true },
      { id: 'u2', nombre: 'Marta', email: 'marta@elparaiso.pe', rol: 'agent', esTu: false },
    ],
    invitaciones: [],
    asientos: { ocupados: 2, tope: 10 },
    ...p,
  };
}

function pintar(datos = equipo(), gestor = true, extra: Record<string, unknown> = {}) {
  const api = {
    equipo: vi.fn().mockResolvedValue(datos),
    // La lista de equipos vive dentro de esta pantalla desde PR-97.
    equipos: vi.fn().mockResolvedValue([]),
    invitar: vi.fn().mockResolvedValue({ id: 'i1', token: 'un-token-largo' }),
    cancelarInvitacion: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as Api;
  render(<Equipo api={api} gestor={gestor} />);
  return api;
}

describe('Equipo', () => {
  it('enseña quién está, con su correo y su rol', async () => {
    pintar();
    expect(await screen.findByText('Rosa')).toBeTruthy();
    // El correo es lo que distingue a dos personas con el mismo nombre.
    expect(screen.getByText('marta@elparaiso.pe')).toBeTruthy();
    // En el idioma de quien lo lee, no en el de la columna. Se busca dentro
    // de la fila: «Agente» también es una opción del desplegable de invitar.
    const deMarta = screen.getByText('marta@elparaiso.pe').closest('tr')!;
    expect(deMarta.textContent).toContain('Agente');
    expect(screen.getByText('rosa@elparaiso.pe').closest('tr')!.textContent).toContain(
      'Propietario',
    );
  });

  it('dice cuántos asientos quedan ANTES de escribir ningún correo', async () => {
    pintar();
    // Enterarse después de rellenar el formulario es peor que no avisar.
    expect(await screen.findByText(/2 de 10 asientos usados/)).toBeTruthy();
  });

  it('con el plan lleno no deja invitar, y dice por qué', async () => {
    pintar(equipo({ asientos: { ocupados: 10, tope: 10 } }));
    expect(await screen.findByText(/sube de plan/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Crear invitación/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('un plan sin tope no inventa un número', async () => {
    pintar(equipo({ asientos: { ocupados: 3, tope: null } }));
    expect(await screen.findByText(/no limita los asientos/)).toBeTruthy();
  });

  it('invitar manda el correo y el rol elegido', async () => {
    const api = pintar();
    await screen.findByText('Rosa');
    await userEvent.type(screen.getByLabelText(/Correo/), 'nuevo@elparaiso.pe');
    await userEvent.selectOptions(screen.getByLabelText(/Qué podrá hacer/), 'supervisor');
    await userEvent.click(screen.getByRole('button', { name: /Crear invitación/ }));
    await waitFor(() =>
      expect(api.invitar).toHaveBeenCalledWith('nuevo@elparaiso.pe', 'supervisor'),
    );
  });

  it('el enlace se ve entero y se avisa de que no se repite', async () => {
    pintar();
    await screen.findByText('Rosa');
    await userEvent.type(screen.getByLabelText(/Correo/), 'nuevo@elparaiso.pe');
    await userEvent.click(screen.getByRole('button', { name: /Crear invitación/ }));

    // El token solo existe en claro en esta respuesta: en la base queda su hash.
    expect(await screen.findByText(/No se vuelve a mostrar/)).toBeTruthy();
    expect(screen.getByText(/#invitacion=un-token-largo/)).toBeTruthy();
  });

  it('cada rol explica qué abre: elegir a ciegas no es elegir', async () => {
    pintar();
    await screen.findByText('Rosa');
    // Arranca en el rol más restrictivo.
    expect(screen.getByText(/No toca canales, plantillas ni ajustes/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText(/Qué podrá hacer/), 'admin');
    expect(screen.getByText(/Gestiona la cuenta entera/)).toBeTruthy();
  });

  it('las invitaciones sin usar se ven, porque ocupan asiento', async () => {
    pintar(
      equipo({
        invitaciones: [
          {
            id: 'i9',
            email: 'pendiente@elparaiso.pe',
            rol: 'agent',
            caducaEn: new Date(ahora + 3 * 86_400_000).toISOString(),
          },
        ],
        asientos: { ocupados: 3, tope: 10 },
      }),
    );
    expect(await screen.findByText('pendiente@elparaiso.pe')).toBeTruthy();
    expect(screen.getByText(/3 de 10 asientos usados/)).toBeTruthy();
  });

  it('se puede retirar una invitación: un correo mal escrito bloquea una plaza', async () => {
    const api = pintar(
      equipo({
        invitaciones: [
          {
            id: 'i9',
            email: 'mal@escrito.pe',
            rol: 'agent',
            caducaEn: new Date(ahora + 86_400_000).toISOString(),
          },
        ],
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Retirar la invitación de mal@escrito.pe' }),
    );
    await waitFor(() => expect(api.cancelarInvitacion).toHaveBeenCalledWith('i9'));
  });

  it('quien no gestiona mira, pero no invita', async () => {
    pintar(equipo(), false);
    expect(await screen.findByText(/Solo el propietario o un administrador/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Crear invitación/ })).toBeNull();
  });

  it('si el servidor rechaza por asientos, se dice con sus palabras', async () => {
    pintar(equipo(), true, {
      invitar: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(
            402,
            'limite_de_asientos',
            'Tu plan incluye 10 asientos y ya están ocupados.',
          ),
        ),
    });
    await screen.findByText('Rosa');
    await userEvent.type(screen.getByLabelText(/Correo/), 'uno@mas.pe');
    await userEvent.click(screen.getByRole('button', { name: /Crear invitación/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('ya están ocupados');
  });
});
