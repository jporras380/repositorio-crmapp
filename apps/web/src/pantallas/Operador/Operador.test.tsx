/**
 * La consola del operador.
 *
 * Lo que se prueba es que conteste las tres preguntas por las que existe —a
 * quién le debo un comprobante, a quién se le vence, qué cuenta se está
 * quedando muda— y que quien no es de la plataforma no entre.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi } from '../../api/cliente.ts';
import type { CuentaEnLaConsola } from '../../api/tipos.ts';
import { Operador } from './Operador.tsx';

const cuentasDeLaPlataforma = vi.fn();
const yo = vi.fn();
vi.mock('../../api/cliente.ts', async () => {
  const real = await vi.importActual<typeof import('../../api/cliente.ts')>('../../api/cliente.ts');
  return { ...real, crearApi: () => ({ cuentasDeLaPlataforma, yo, urlDeMedio: vi.fn() }) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SESION = { token: 't', tenantId: 'te1', userId: 'u1', rol: 'owner' as const };

function cuenta(p: Partial<CuentaEnLaConsola> = {}): CuentaEnLaConsola {
  return {
    tenantId: 'a1',
    nombre: 'Apart Hotel El Paraíso',
    slug: 'paraiso',
    altaEn: '2026-01-10T00:00:00Z',
    plan: 'Starter',
    estado: 'active',
    pruebaHasta: null,
    periodoHasta: '2026-12-01T00:00:00Z',
    diasDeGracia: 7,
    asientos: 3,
    importeMensualCentimos: 7500,
    moneda: 'USD',
    comprobantesPendientes: 0,
    comprobanteMasViejoEn: null,
    canales: 2,
    canalesConProblema: 0,
    ultimoEventoEn: '2026-09-21T10:00:00Z',
    mensajesDelMes: 430,
    ...p,
  };
}

function pintar(cuentas: CuentaEnLaConsola[]) {
  yo.mockResolvedValue({
    userId: 'u1',
    tenantId: 'te1',
    rol: 'owner',
    suscripcion: 'activa',
    nombre: 'Jefe',
    fotoId: null,
    esOperador: true,
  });
  cuentasDeLaPlataforma.mockResolvedValue(cuentas);
  render(<Operador sesion={SESION} alSalir={vi.fn()} />);
}

describe('Consola del operador', () => {
  it('lista las cuentas con lo que hace falta para cobrar', async () => {
    pintar([cuenta()]);
    expect(await screen.findByText('Apart Hotel El Paraíso')).toBeTruthy();
    // El identificador va aparte: dos cuentas del mismo dueño se distinguen
    // por él, no por el nombre comercial.
    expect(screen.getByText('paraiso')).toBeTruthy();
    expect(screen.getByText('Starter')).toBeTruthy();
    // El formateador da «USD 75» en la configuración regional del proyecto;
    // se comprueba el importe, no cómo lo escribe Intl, que cambia por versión
    // de Node y dejaría el test roto sin que nadie tocara la pantalla.
    // Se comprueba el importe, no cómo lo escribe Intl: el formato exacto
    // cambia con la versión de Node y dejaría el test roto sin que nadie
    // tocara la pantalla.
    expect(document.querySelector('tbody tr')!.textContent).toContain('75');
  });

  it('avisa arriba de a cuántas se les debe un comprobante', async () => {
    pintar([
      cuenta({ comprobantesPendientes: 2, comprobanteMasViejoEn: '2026-09-15T00:00:00Z' }),
      cuenta({ tenantId: 'a2', slug: 'otro', nombre: 'Otro Hotel', comprobantesPendientes: 1 }),
      cuenta({ tenantId: 'a3', slug: 'tercero', nombre: 'Tercero' }),
    ]);
    // Sin tener que contar filas: es lo único con un plazo legal encima.
    expect(await screen.findByText('2 cuentas esperan comprobante')).toBeTruthy();
    expect(screen.getAllByText(/sin subir/)).toHaveLength(2);
  });

  it('con una sola cuenta debiendo, lo dice en singular', async () => {
    pintar([cuenta({ comprobantesPendientes: 1 })]);
    expect(await screen.findByText('1 cuenta espera comprobante')).toBeTruthy();
  });

  it('sin deudas no hay aviso: el ruido enseña a ignorar los avisos', async () => {
    pintar([cuenta()]);
    await screen.findByText('Apart Hotel El Paraíso');
    expect(screen.queryByText(/espera.*comprobante/)).toBeNull();
    expect(screen.getByText('al día')).toBeTruthy();
  });

  it('distingue «sin conectar» de «con problema»: se llama por motivos distintos', async () => {
    pintar([
      cuenta({ canales: 0, ultimoEventoEn: null }),
      cuenta({ tenantId: 'a2', slug: 'roto', nombre: 'Roto', canales: 2, canalesConProblema: 1 }),
    ]);
    expect(await screen.findByText('sin conectar')).toBeTruthy();
    expect(screen.getByText('1 de 2 con problema')).toBeTruthy();
  });

  it('una cuenta con cero mensajes en el mes se marca: se está yendo sin avisar', async () => {
    pintar([cuenta({ mensajesDelMes: 0 })]);
    const celda = await screen.findByText('0');
    expect(celda.className).toContain('debe');
  });

  it('se puede buscar entre las cuentas', async () => {
    pintar([cuenta(), cuenta({ tenantId: 'a2', slug: 'andes', nombre: 'Taller Los Andes' })]);
    await screen.findByText('Taller Los Andes');
    await userEvent.type(screen.getByRole('searchbox'), 'paraiso');
    expect(screen.queryByText('Taller Los Andes')).toBeNull();
    expect(screen.getByText('Apart Hotel El Paraíso')).toBeTruthy();
  });

  it('dice en pantalla que aquí no se ven conversaciones', async () => {
    pintar([cuenta()]);
    // No es decoración: es la promesa que hace aceptable que esta pantalla
    // cruce el aislamiento entre cuentas.
    expect(await screen.findByText(/no se ven conversaciones ni contactos/)).toBeTruthy();
  });

  it('a quien no es de la plataforma se le dice, sin tecnicismos', async () => {
    yo.mockResolvedValue({
      userId: 'u1',
      tenantId: 'te1',
      rol: 'owner',
      suscripcion: 'activa',
      nombre: 'Jefe',
      fotoId: null,
      esOperador: false,
    });
    cuentasDeLaPlataforma.mockRejectedValue(new ErrorDeApi(404, 'no_encontrado', 'No existe.'));
    render(<Operador sesion={SESION} alSalir={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('personal de la plataforma');
  });
});
