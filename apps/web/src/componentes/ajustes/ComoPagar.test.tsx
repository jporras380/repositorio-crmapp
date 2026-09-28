/**
 * A dónde pagar, visto por el cliente.
 *
 * La pantalla de Suscripción decía «los pagos se hacen por transferencia» y no
 * decía a dónde. Lo que se prueba es que ahora lo diga, que no prometa un
 * método que el operador no ha cargado, y que avisar de un pago quede claro
 * que **no es pagar**.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ComoPagar as Datos } from '../../api/tipos.ts';
import { ComoPagar } from './ComoPagar.tsx';

afterEach(cleanup);

function datos(p: Partial<Datos> = {}): Datos {
  return {
    banco: null,
    tipoDeCuenta: null,
    numeroDeCuenta: null,
    cci: null,
    titular: null,
    documentoTitular: null,
    numeroBilletera: null,
    titularBilletera: null,
    hayQr: false,
    solesCentimos: null,
    nota: null,
    ...p,
  };
}

const CARGADOS = datos({
  banco: 'BCP',
  numeroDeCuenta: '191-1234567-0-11',
  cci: '00219100123456701159',
  titular: 'Jose Porras',
  numeroBilletera: '999888777',
});

function pintar(d = CARGADOS, extra: Record<string, unknown> = {}, gestor = true) {
  const api = {
    declararPago: vi.fn().mockResolvedValue({}),
    prepararSubida: vi
      .fn()
      .mockResolvedValue({ mediaAssetId: 'md-1', urlDeSubida: 'https://s3/put' }),
    confirmarSubida: vi.fn().mockResolvedValue({ mediaAssetId: 'md-1' }),
    qrDeCobro: vi.fn().mockResolvedValue({ url: 'https://s3/qr.png', expiraEnSegundos: 300 }),
    ...extra,
  } as unknown as Api;
  render(
    <ComoPagar
      api={api}
      datos={d}
      declaraciones={[]}
      importeSugeridoCentimos={7500}
      monedaDelPlan="USD"
      gestor={gestor}
      alCambiar={vi.fn()}
    />,
  );
  return api;
}

describe('A dónde pagar', () => {
  it('sin datos cargados NO promete un método: dice que faltan', () => {
    pintar(datos());
    // Enseñar una tarjeta con campos vacíos es peor que decir que no están.
    expect(screen.getByText(/Todavía no hemos publicado nuestros datos/)).toBeTruthy();
    expect(screen.queryByText('Transferencia')).toBeNull();
  });

  it('con datos, los enseña para copiarlos', () => {
    pintar();
    expect(screen.getByText('00219100123456701159')).toBeTruthy();
    expect(screen.getByText('999888777')).toBeTruthy();
  });

  it('solo enseña el método que el operador cargó', () => {
    pintar(datos({ numeroBilletera: '999888777' }));
    expect(screen.getByText('Yape o Plin')).toBeTruthy();
    expect(screen.queryByText('Transferencia')).toBeNull();
  });

  it('el importe en soles va al lado del de dólares', () => {
    pintar(datos({ ...CARGADOS, solesCentimos: 28500 }));
    // Hacer la conversión de cabeza es cómo llegan pagos que no cuadran.
    expect(screen.getByText(/285/)).toBeTruthy();
  });

  it('el botón dice avisar, no pagar: aquí no se cobra nada', async () => {
    pintar();
    const boton = screen.getByRole('button', { name: /ya pagué/i });
    expect(boton).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Pagar$/ })).toBeNull();

    await userEvent.click(boton);
    expect(screen.getByText(/Esto no cobra nada/)).toBeTruthy();
  });

  it('avisar manda el importe, el método y la fecha', async () => {
    const api = pintar();
    await userEvent.click(screen.getByRole('button', { name: /ya pagué/i }));
    await userEvent.selectOptions(screen.getByLabelText(/Cómo pagaste/), 'yape');
    await userEvent.type(screen.getByLabelText(/Número de operación/), 'OP-123');
    await userEvent.click(screen.getByRole('button', { name: 'Avisar' }));

    await waitFor(() =>
      expect(api.declararPago).toHaveBeenCalledWith(
        expect.objectContaining({
          importeCentimos: 7500,
          moneda: 'USD',
          metodo: 'yape',
          referencia: 'OP-123',
        }),
      ),
    );
  });

  it('quien no gestiona ve los datos pero no avisa', () => {
    pintar(CARGADOS, {}, false);
    expect(screen.getByText('00219100123456701159')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ya pagué/i })).toBeNull();
  });

  it('si el servidor rechaza el voucher, se dice', async () => {
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    try {
      pintar();
      await userEvent.click(screen.getByRole('button', { name: /ya pagué/i }));
      await userEvent.upload(
        document.getElementById('voucher-de-pago') as HTMLInputElement,
        new File(['x'], 'voucher.pdf', { type: 'application/pdf' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain('No se pudo subir');
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('si avisar falla, se dice con las palabras del servidor', async () => {
    pintar(CARGADOS, {
      declararPago: vi
        .fn()
        .mockRejectedValue(new ErrorDeApi(409, 'x', 'Ese archivo no está subido.')),
    });
    await userEvent.click(screen.getByRole('button', { name: /ya pagué/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Avisar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no está subido');
  });

  it('el QR se pide firmado, no se pone directo en el src', async () => {
    const api = pintar(datos({ numeroBilletera: '999', hayQr: true }));
    // Un `<img>` no manda la cabecera de sesión: la URL se pide antes.
    await waitFor(() => expect(api.qrDeCobro).toHaveBeenCalled());
    const img = (await screen.findByAltText(/QR para pagar/)) as HTMLImageElement;
    expect(img.src).toBe('https://s3/qr.png');
  });
});
