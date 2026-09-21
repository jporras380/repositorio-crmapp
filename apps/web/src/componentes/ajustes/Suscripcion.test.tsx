import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ResumenDeSuscripcion } from '../../api/tipos.ts';
import { Suscripcion } from './Suscripcion.tsx';

afterEach(cleanup);

const BASE: ResumenDeSuscripcion = {
  plan: { codigo: 'starter', nombre: 'Starter', precioPorAsientoCentimos: 2500, moneda: 'USD' },
  estado: 'activa',
  asientos: 3,
  importeMensualCentimos: 7500,
  pruebaHasta: '2026-10-09T00:00:00Z',
  periodoHasta: '2026-11-09T00:00:00Z',
  graciaHasta: '2026-11-16T00:00:00Z',
  pagos: [
    {
      id: 'p1',
      importeCentimos: 7500,
      moneda: 'USD',
      cubreDesde: '2026-10-09T00:00:00Z',
      cubreHasta: '2026-11-09T00:00:00Z',
      metodo: 'transferencia',
      referencia: 'OP-1',
      comprobante: {
        estado: 'pendiente',
        medioId: null,
        numero: null,
        venceEn: '2026-11-11T00:00:00Z',
        subidoEn: null,
      },
    },
  ],
  avisos: [],
  facturacion: { tipo: 'boleta', documento: null, nombre: null, direccion: null },
};

const api = (d: Partial<ResumenDeSuscripcion> = {}, extra: Record<string, unknown> = {}) =>
  ({
    suscripcion: vi.fn().mockResolvedValue({ ...BASE, ...d }),
    guardarFacturacion: vi.fn().mockResolvedValue({ ...BASE, ...d }),
    urlDeMedio: vi.fn().mockResolvedValue({ url: 'blob:pdf', expiraEnSegundos: 300, mime: null }),
    ...extra,
  }) as unknown as Api;

describe('Suscripción', () => {
  it('muestra el importe por asientos ocupados y hasta cuándo está cubierta', async () => {
    render(<Suscripcion api={api()} />);
    // Dos veces a propósito: el importe del mes y el pago que lo cubrió.
    expect(await screen.findAllByText('75,00 USD')).toHaveLength(2);
    expect(screen.getByText('3 asientos ocupados')).toBeTruthy();
    // Sin el día exacto: la fecha se pinta en el huso de quien mira, y el
    // test correría igual de bien en Lima que en Madrid.
    expect(screen.getAllByText(/de noviembre de 2026/).length).toBeGreaterThan(0);
    expect(screen.getByText('OP-1')).toBeTruthy();
  });

  it('deja claro que la mensajería la cobra Meta, no nosotros', async () => {
    render(<Suscripcion api={api()} />);
    expect(await screen.findByText(/lo cobra Meta directamente/)).toBeTruthy();
  });

  it('al llegar al límite explica que lo que se detiene son los bots, no los mensajes', async () => {
    render(
      <Suscripcion
        api={api({ avisos: [{ limite: 'bot_runs_mes', nivel: 'pasado', usado: 500, tope: 500 }] })}
      />,
    );
    expect(await screen.findByText(/las conversaciones siguen entrando/i)).toBeTruthy();
  });

  it('no ofrece pagar: el cobro es manual y un botón que no cobra sería peor', async () => {
    render(<Suscripcion api={api()} />);
    await screen.findAllByText('75,00 USD');
    // Desde 0039 sí hay botón —el de guardar los datos del comprobante—, así
    // que se comprueba lo que la regla dice de verdad: que no hay ninguno que
    // prometa cobrar.
    for (const b of screen.getAllByRole('button')) {
      expect(b.textContent).not.toMatch(/pagar|pago|tarjeta|suscribir/i);
    }
  });
});

/**
 * Factura o boleta, y el comprobante (0039).
 *
 * Lo que se prueba es lo que cuesta dinero —una factura sin RUC no da crédito
 * fiscal— y lo que evita una llamada: saber si el comprobante está en camino
 * o si nos hemos retrasado.
 */
describe('Suscripción · comprobantes', () => {
  it('la factura pide RUC, razón social y dirección; la boleta no', async () => {
    render(<Suscripcion api={api()} />);
    const tipo = await screen.findByLabelText(/^Tipo/);

    // En boleta el DNI es opcional y no se pide dirección.
    expect(screen.getByLabelText(/DNI \(opcional\)/)).toBeTruthy();
    expect(screen.queryByLabelText('Dirección fiscal')).toBeNull();

    await userEvent.selectOptions(tipo, 'factura');
    expect(screen.getByLabelText(/^RUC/)).toBeTruthy();
    expect(screen.getByLabelText('Dirección fiscal')).toBeTruthy();
  });

  it('el campo del documento solo admite dígitos', async () => {
    render(<Suscripcion api={api()} />);
    const doc = await screen.findByLabelText(/DNI/);
    await userEvent.type(doc, '12a34b5678');
    expect((doc as HTMLInputElement).value).toBe('12345678');
  });

  it('guardar manda lo que hay en pantalla', async () => {
    const a = api();
    render(<Suscripcion api={a} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^Tipo/), 'factura');
    await userEvent.type(screen.getByLabelText(/^RUC/), '20100070970');
    await userEvent.type(screen.getByLabelText('Razón social'), 'Paraíso SAC');
    await userEvent.type(screen.getByLabelText('Dirección fiscal'), 'Av. Grau 100');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    expect(a.guardarFacturacion).toHaveBeenCalledWith({
      tipo: 'factura',
      documento: '20100070970',
      nombre: 'Paraíso SAC',
      direccion: 'Av. Grau 100',
    });
  });

  it('si el servidor rechaza los datos, se ve el motivo', async () => {
    const a = api(
      {},
      {
        guardarFacturacion: vi
          .fn()
          .mockRejectedValue(
            new ErrorDeApi(422, 'facturacion_incompleta', 'La factura necesita el RUC.'),
          ),
      },
    );
    render(<Suscripcion api={a} />);
    await userEvent.selectOptions(await screen.findByLabelText(/^Tipo/), 'factura');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('RUC');
  });

  it('un comprobante pendiente dice PARA CUÁNDO, no solo que falta', async () => {
    render(<Suscripcion api={api()} />);
    expect(await screen.findByText(/Antes del/)).toBeTruthy();
  });

  it('pasadas las 48 horas se dice que nos hemos retrasado', async () => {
    render(
      <Suscripcion
        api={api({
          pagos: [
            {
              ...BASE.pagos[0]!,
              comprobante: { ...BASE.pagos[0]!.comprobante, estado: 'retrasado' },
            },
          ],
        })}
      />,
    );
    // Es un incumplimiento nuestro; el hotel no debería tener que preguntar.
    expect(await screen.findByText('Nos hemos retrasado')).toBeTruthy();
  });

  it('cuando está subido se descarga, y el enlace se pide AL PULSAR', async () => {
    const a = api({
      pagos: [
        {
          ...BASE.pagos[0]!,
          comprobante: {
            estado: 'disponible',
            medioId: 'm1',
            numero: 'F001-00000123',
            venceEn: '2026-11-11T00:00:00Z',
            subidoEn: '2026-11-10T00:00:00Z',
          },
        },
      ],
    });
    render(<Suscripcion api={a} />);
    const boton = await screen.findByRole('button', { name: 'F001-00000123' });
    // La URL se firma para unos minutos: pedirla al pintar caducaría antes de
    // que nadie la usara.
    expect(a.urlDeMedio).not.toHaveBeenCalled();

    vi.spyOn(window, 'open').mockReturnValue(null);
    await userEvent.click(boton);
    expect(a.urlDeMedio).toHaveBeenCalledWith('m1');
  });
});
