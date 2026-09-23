/**
 * Trabajar sobre una cuenta desde la consola.
 *
 * Lo que se prueba es lo que estaba entregado y no se podía usar: subir un
 * comprobante, pedir acceso de soporte, y ver qué falla cuando ya se puede.
 * Y una línea que no se cruza: con el permiso abierto, esto sigue sin
 * enseñar ni un mensaje de un huésped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { CuentaEnLaConsola, DetalleDeCuenta } from '../../api/tipos.ts';
import { CuentaDeLaPlataforma } from './CuentaDeLaPlataforma.tsx';

afterEach(cleanup);

const ahora = Date.now();

const CUENTA = {
  tenantId: 'te-9',
  nombre: 'El Paraíso de Barranca',
  slug: 'paraiso',
} as unknown as CuentaEnLaConsola;

function detalle(p: Partial<DetalleDeCuenta> = {}): DetalleDeCuenta {
  return {
    pagosPendientes: [],
    soporte: null,
    ...p,
  };
}

const PAGO = {
  id: 'p1',
  importeCentimos: 7500,
  moneda: 'USD',
  cubreDesde: new Date(ahora - 30 * 86_400_000).toISOString(),
  cubreHasta: new Date(ahora).toISOString(),
  registradoEn: new Date(ahora - 3_600_000).toISOString(),
  venceEn: new Date(ahora + 44 * 3_600_000).toISOString(),
  vencido: false,
};

function pintar(datos = detalle(), extra: Record<string, unknown> = {}) {
  const api = {
    detalleDeCuenta: vi.fn().mockResolvedValue(datos),
    mensajesDeSoporte: vi.fn().mockResolvedValue([]),
    hiloDeSoporteDe: vi.fn().mockResolvedValue([]),
    responderASoporte: vi.fn().mockResolvedValue([]),
    prepararSubida: vi
      .fn()
      .mockResolvedValue({ mediaAssetId: 'md-1', urlDeSubida: 'https://s3/put' }),
    confirmarSubida: vi.fn().mockResolvedValue({ mediaAssetId: 'md-1' }),
    subirComprobante: vi.fn().mockResolvedValue({ adjuntado: true }),
    pedirAccesoDeSoporte: vi.fn().mockResolvedValue({ id: 'g1' }),
    conversacionesDeSoporte: vi.fn().mockResolvedValue([]),
    ...extra,
  } as unknown as Api;
  const alCambiar = vi.fn();
  render(
    <CuentaDeLaPlataforma api={api} cuenta={CUENTA} alCerrar={vi.fn()} alCambiar={alCambiar} />,
  );
  return { api, alCambiar };
}

describe('Comprobantes desde la consola', () => {
  it('sin nada pendiente lo dice, y no deja un hueco', async () => {
    pintar();
    expect(await screen.findByText(/No le debemos ningún comprobante/)).toBeTruthy();
  });

  it('un pago pendiente sale con su importe y su plazo', async () => {
    pintar(detalle({ pagosPendientes: [PAGO] }));
    expect(await screen.findByText(/75/)).toBeTruthy();
    expect(screen.getByText(/vence/)).toBeTruthy();
  });

  it('uno fuera de plazo se distingue: el incumplimiento es NUESTRO', async () => {
    pintar(detalle({ pagosPendientes: [{ ...PAGO, vencido: true }] }));
    // «Vencido» en un pago del cliente significa otra cosa; aquí el que va
    // tarde es la plataforma, y por eso no dice «vencido» a secas.
    expect(await screen.findByText('fuera de plazo')).toBeTruthy();
  });

  it('subir el comprobante lo sube al almacén y lo adjunta a ESE pago', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const { api, alCambiar } = pintar(detalle({ pagosPendientes: [PAGO] }));
      await screen.findByText(/75/);
      await userEvent.type(screen.getByLabelText(/Número del comprobante/), 'F001-00000123');
      await userEvent.upload(
        document.getElementById('comprobante-p1') as HTMLInputElement,
        new File(['x'], 'boleta.pdf', { type: 'application/pdf' }),
      );

      await waitFor(() =>
        expect(api.subirComprobante).toHaveBeenCalledWith({
          tenantId: 'te-9',
          pagoId: 'p1',
          mediaAssetId: 'md-1',
          numero: 'F001-00000123',
        }),
      );
      // La tabla de arriba decía «1 sin subir»: dejarla así sería mentir.
      expect(alCambiar).toHaveBeenCalled();
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('si el servidor rechaza el pago, se dice', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      pintar(detalle({ pagosPendientes: [PAGO] }), {
        subirComprobante: vi
          .fn()
          .mockRejectedValue(
            new ErrorDeApi(404, 'pago_o_medio_no_valido', 'No se encontró ese pago en esa cuenta.'),
          ),
      });
      await screen.findByText(/75/);
      await userEvent.upload(
        document.getElementById('comprobante-p1') as HTMLInputElement,
        new File(['x'], 'boleta.pdf', { type: 'application/pdf' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain('No se encontró ese pago');
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});

describe('Acceso de soporte desde la consola', () => {
  it('pedir exige un motivo largo: es lo único que el cliente tiene para decidir', async () => {
    const { api } = pintar();
    await screen.findByText(/Para qué necesitas entrar/);
    const boton = screen.getByRole('button', { name: 'Pedir acceso' }) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/Para qué necesitas entrar/), 'corto');
    expect(boton.disabled).toBe(true);

    await userEvent.type(
      screen.getByLabelText(/Para qué necesitas entrar/),
      ' y ahora ya es suficientemente largo',
    );
    await userEvent.click(boton);
    await waitFor(() =>
      expect(api.pedirAccesoDeSoporte).toHaveBeenCalledWith(
        'te-9',
        'corto y ahora ya es suficientemente largo',
      ),
    );
  });

  it('pedido y sin abrir: se dice de quién es la decisión, y no hay botón de insistir', async () => {
    pintar(
      detalle({
        soporte: {
          id: 'g1',
          motivo: 'No les llegan los mensajes.',
          estado: 'pendiente',
          expiraEn: null,
        },
      }),
    );
    expect(await screen.findByText(/Lo tiene que abrir el dueño/)).toBeTruthy();
    // Insistir desde aquí solo crea solicitudes duplicadas.
    expect(screen.queryByRole('button', { name: 'Pedir acceso' })).toBeNull();
  });

  it('con el acceso abierto se dice hasta cuándo y se puede mirar', async () => {
    const { api } = pintar(
      detalle({
        soporte: {
          id: 'g1',
          motivo: 'No les llegan.',
          estado: 'activo',
          expiraEn: new Date(ahora + 4 * 3_600_000).toISOString(),
        },
      }),
      {
        conversacionesDeSoporte: vi.fn().mockResolvedValue([
          {
            id: 'c1',
            canal: 'whatsapp',
            estado: 'open',
            ultimoEntranteEn: new Date(ahora - 7_200_000).toISOString(),
            ultimoSalienteEn: null,
            mensajesFallidos: 2,
            ultimoError: { tipo: 'plantilla', mensaje: 'La plantilla ya no existe en Meta.' },
          },
        ]),
      },
    );
    expect(await screen.findByText(/Acceso abierto/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ver qué está fallando' }));

    await waitFor(() => expect(api.conversacionesDeSoporte).toHaveBeenCalledWith('te-9'));
    expect(screen.getByText('whatsapp')).toBeTruthy();
    expect(screen.getByText('2 sin enviar')).toBeTruthy();
    // El error entero: es lo que contesta «no me llega».
    expect(screen.getByText('La plantilla ya no existe en Meta.')).toBeTruthy();
  });

  it('ni con permiso se enseña lo que la gente se dice', async () => {
    pintar(
      detalle({
        soporte: {
          id: 'g1',
          motivo: 'x',
          estado: 'activo',
          expiraEn: new Date(ahora + 3_600_000).toISOString(),
        },
      }),
      {
        conversacionesDeSoporte: vi.fn().mockResolvedValue([
          {
            id: 'c1',
            canal: 'whatsapp',
            estado: 'open',
            ultimoEntranteEn: null,
            ultimoSalienteEn: null,
            mensajesFallidos: 0,
            ultimoError: null,
          },
        ]),
      },
    );
    await screen.findByText(/Acceso abierto/);
    await userEvent.click(screen.getByRole('button', { name: 'Ver qué está fallando' }));
    await screen.findByText('whatsapp');
    // Estados y errores de envío, no cuerpos de mensaje. La línea la sostiene
    // el rol de base de datos; esto solo comprueba que la pantalla no la cruza.
    expect(screen.queryByText(/mensaje de/i)).toBeNull();
    expect(screen.getByText(/nunca/)).toBeTruthy();
  });

  it('sin permiso vivo, el servidor lo dice y la pantalla no finge', async () => {
    pintar(
      detalle({
        soporte: {
          id: 'g1',
          motivo: 'x',
          estado: 'activo',
          expiraEn: new Date(ahora + 3_600_000).toISOString(),
        },
      }),
      {
        conversacionesDeSoporte: vi
          .fn()
          .mockRejectedValue(
            new ErrorDeApi(403, 'sin_permiso_de_soporte', 'No hay un acceso de soporte vivo.'),
          ),
      },
    );
    await screen.findByText(/Acceso abierto/);
    await userEvent.click(screen.getByRole('button', { name: 'Ver qué está fallando' }));
    expect((await screen.findByRole('alert')).textContent).toContain('acceso de soporte vivo');
  });
});
