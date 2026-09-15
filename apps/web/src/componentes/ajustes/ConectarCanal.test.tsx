/**
 * Conectar eligiendo en vez de copiar ids (P-26, opción A).
 *
 * Lo que se prueba es lo que el cliente vive: pega el token, ve sus números,
 * elige uno, y lo que viaja al alta es lo que eligió. Y los desvíos: Meta no
 * deja listar (se pide UN dato), un número ya conectado y un token rechazado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { DescubrimientoWhatsapp } from '../../api/tipos.ts';
import { ConectarCanal } from './ConectarCanal.tsx';

afterEach(cleanup);

const DOS_NUMEROS: DescubrimientoWhatsapp = {
  necesitaWaba: false,
  caducaEn: null,
  cuentas: [
    {
      wabaId: '999',
      nombre: 'Paraíso Barranca',
      numeros: [
        {
          phoneNumberId: '111',
          numero: '+51 929 833 609',
          nombreVerificado: 'El Paraíso',
          calidad: 'GREEN',
          yaConectado: true,
        },
        {
          phoneNumberId: '222',
          numero: '+51 900 000 000',
          nombreVerificado: 'El Paraíso',
          calidad: null,
          yaConectado: false,
        },
      ],
    },
  ],
};

async function pegarCredenciales() {
  await userEvent.type(screen.getByLabelText('Token de acceso'), 'EAAG-token-largo-de-prueba');
  await userEvent.type(screen.getByLabelText(/Clave secreta de la app/), 'secreto-largo-16');
}

function pintar(
  api: Record<string, unknown>,
  canal: 'whatsapp' | 'instagram' | 'facebook' = 'whatsapp',
) {
  const alConectar = vi.fn().mockResolvedValue(undefined);
  render(
    <ConectarCanal
      api={api as unknown as Api}
      canal={canal}
      alCancelar={() => {}}
      alConectar={alConectar}
    />,
  );
  return alConectar;
}

describe('ConectarCanal · WhatsApp', () => {
  it('con solo el token lista los números; el conectado no se elige; conecta el elegido', async () => {
    const conectarWhatsapp = vi.fn().mockResolvedValue({});
    const descubrirWhatsapp = vi.fn().mockResolvedValue(DOS_NUMEROS);
    const alConectar = pintar({ descubrirWhatsapp, conectarWhatsapp });

    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis números' }));
    expect(descubrirWhatsapp).toHaveBeenCalledWith({ accessToken: 'EAAG-token-largo-de-prueba' });

    const conectado = await screen.findByRole('radio', { name: /\+51 929 833 609/ });
    expect((conectado as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Ya conectado')).toBeTruthy();

    // Un solo número libre: queda elegido sin hacer nada.
    const libre = screen.getByRole('radio', { name: /\+51 900 000 000/ }) as HTMLInputElement;
    expect(libre.checked).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Conectar este número' }));
    expect(conectarWhatsapp).toHaveBeenCalledWith({
      phoneNumberId: '222',
      wabaId: '999',
      accessToken: 'EAAG-token-largo-de-prueba',
      appSecret: 'secreto-largo-16',
    });
    expect(alConectar).toHaveBeenCalled();
  });

  it('si Meta no deja listar las cuentas, pide solo el id de la cuenta y busca con él', async () => {
    const descubrirWhatsapp = vi
      .fn()
      .mockResolvedValueOnce({ cuentas: [], necesitaWaba: true, caducaEn: null })
      .mockResolvedValueOnce(DOS_NUMEROS);
    pintar({ descubrirWhatsapp });

    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis números' }));
    expect(await screen.findByText(/Falta un solo dato/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText(/ID de la cuenta de WhatsApp Business/), '999');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis números' }));
    expect(descubrirWhatsapp).toHaveBeenLastCalledWith({
      accessToken: 'EAAG-token-largo-de-prueba',
      wabaId: '999',
    });
    expect(await screen.findByRole('radio', { name: /\+51 900 000 000/ })).toBeTruthy();
  });

  it('un token temporal avisa de cuándo caduca', async () => {
    pintar({
      descubrirWhatsapp: vi
        .fn()
        .mockResolvedValue({ ...DOS_NUMEROS, caducaEn: '2026-09-15T12:00:00Z' }),
    });
    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis números' }));
    expect(await screen.findByText(/Este token caduca el/)).toBeTruthy();
  });

  it('un token rechazado muestra el motivo de Meta', async () => {
    pintar({
      descubrirWhatsapp: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(422, 'credenciales_rechazadas', 'Meta rechazó el token.'),
        ),
    });
    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis números' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Meta rechazó el token.');
  });
});

describe('ConectarCanal · Instagram', () => {
  it('lista las cuentas vinculadas a páginas y conecta la elegida por su id', async () => {
    const conectarInstagram = vi.fn().mockResolvedValue({});
    pintar(
      {
        descubrirInstagram: vi.fn().mockResolvedValue([
          {
            igUserId: '1784',
            usuario: '@paraisobarranca',
            paginaId: 'P1',
            pagina: 'Paraíso Barranca',
            yaConectado: false,
          },
          {
            igUserId: '1785',
            usuario: '@otra',
            paginaId: 'P2',
            pagina: 'Otra',
            yaConectado: false,
          },
        ]),
        conectarInstagram,
      },
      'instagram',
    );
    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis cuentas' }));
    // Dos libres: hay que elegir, y hasta entonces no se puede conectar.
    const boton = (await screen.findByRole('button', {
      name: 'Conectar esta cuenta',
    })) as HTMLButtonElement;
    expect(boton.disabled).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: /@paraisobarranca/ }));
    await userEvent.click(boton);
    expect(conectarInstagram).toHaveBeenCalledWith({
      igUserId: '1784',
      accessToken: 'EAAG-token-largo-de-prueba',
      appSecret: 'secreto-largo-16',
    });
  });

  it('si el token no ve ninguna cuenta, explica qué revisar', async () => {
    pintar({ descubrirInstagram: vi.fn().mockResolvedValue([]) }, 'instagram');
    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis cuentas' }));
    expect(await screen.findByText(/no ve ninguna cuenta de Instagram/)).toBeTruthy();
  });
});

describe('ConectarCanal · Facebook', () => {
  it('lista las páginas; con una sola libre queda elegida y se conecta por su id', async () => {
    const conectarFacebook = vi.fn().mockResolvedValue({});
    pintar(
      {
        descubrirFacebook: vi.fn().mockResolvedValue([
          { paginaId: '111', pagina: 'Apart Hotel El Paraíso', yaConectado: false },
          { paginaId: '222', pagina: 'Otra página', yaConectado: true },
        ]),
        conectarFacebook,
      },
      'facebook',
    );
    expect(screen.getByRole('heading', { name: 'Conectar Facebook' })).toBeTruthy();
    await pegarCredenciales();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar mis páginas' }));
    const libre = (await screen.findByRole('radio', {
      name: /Apart Hotel El Paraíso/,
    })) as HTMLInputElement;
    expect(libre.checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Conectar esta página' }));
    expect(conectarFacebook).toHaveBeenCalledWith({
      paginaId: '111',
      accessToken: 'EAAG-token-largo-de-prueba',
      appSecret: 'secreto-largo-16',
    });
  });
});
