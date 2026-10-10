/**
 * «Conectar con Meta» (ADR-015). Lo que se prueba es el recorrido que hace el
 * dueño: lee lo que cambia en su celular, pulsa, vuelve de la ventana de Meta
 * y conecta sin haber pegado nada. Y que quien tiene su propia app de Meta
 * puede seguir pegando sus credenciales.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PlataformaMeta } from '../../api/tipos.ts';
import { ConectarCanal } from './ConectarCanal.tsx';

const sdk = vi.hoisted(() => ({
  cargarSdkDeMeta: vi.fn(),
  abrirVentanaDeMeta: vi.fn(),
}));
vi.mock('../../vista/metaSdk.ts', () => sdk);

const PLATAFORMA: PlataformaMeta = {
  disponible: true,
  appId: 'APP1',
  version: 'v21.0',
  configWhatsapp: 'CFG-WA',
  configPaginas: 'CFG-PG',
};

const SESION = {
  necesitaWaba: false,
  caducaEn: null,
  credencial: 'SOBRE-SELLADO',
  cuentas: [
    {
      wabaId: 'WABA-1',
      nombre: 'El Paraíso',
      numeros: [
        {
          phoneNumberId: 'PN-1',
          numero: '+51 955 000 000',
          nombreVerificado: 'El Paraíso',
          calidad: 'GREEN',
          yaConectado: false,
        },
      ],
    },
  ],
};

function pintar(
  canal: 'whatsapp' | 'instagram' | 'facebook' = 'whatsapp',
  extra: Record<string, unknown> = {},
  plataforma: PlataformaMeta | null = PLATAFORMA,
) {
  const api = {
    sesionMetaWhatsapp: vi.fn().mockResolvedValue(SESION),
    sesionMetaPaginas: vi.fn().mockResolvedValue({
      credencial: 'SOBRE-PG',
      facebook: [{ paginaId: 'PG-1', pagina: 'Apart Hotel', yaConectado: false }],
      instagram: [
        {
          igUserId: 'IG-1',
          usuario: '@paraiso',
          paginaId: 'PG-1',
          pagina: 'Apart Hotel',
          yaConectado: false,
        },
      ],
    }),
    conectarWhatsapp: vi.fn().mockResolvedValue({ id: 'c1', historialPedido: true }),
    conectarInstagram: vi.fn().mockResolvedValue({ id: 'c2' }),
    conectarFacebook: vi.fn().mockResolvedValue({ id: 'c3' }),
    ...extra,
  } as unknown as Api;
  const alConectar = vi.fn().mockResolvedValue(undefined);
  render(
    <ConectarCanal
      api={api}
      canal={canal}
      plataforma={plataforma}
      alCancelar={vi.fn()}
      alConectar={alConectar}
    />,
  );
  return { api, alConectar };
}

beforeEach(() => {
  sdk.cargarSdkDeMeta.mockResolvedValue(undefined);
  sdk.abrirVentanaDeMeta.mockResolvedValue({
    code: 'CODIGO',
    wabaId: 'WABA-1',
    phoneNumberId: 'PN-1',
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Conectar con Meta', () => {
  it('antes de pulsar dice lo que cambia en el celular: no se deshace con «atrás»', async () => {
    pintar();
    const lista = await screen.findByRole('list', { name: 'Antes de conectar' });
    expect(lista.textContent).toContain('cada 14 días');
    expect(lista.textContent).toContain('hasta 6 meses');
    expect(lista.textContent).toContain('listas de difusión');
    expect(lista.textContent).toContain('avisará a tus clientes');
  });

  it('WhatsApp: pulsa, vuelve de Meta y conecta con el sobre, sin pegar nada', async () => {
    const { api, alConectar } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Meta' }));

    expect(sdk.abrirVentanaDeMeta).toHaveBeenCalledWith({ configId: 'CFG-WA', whatsapp: true });
    await waitFor(() =>
      expect(api.sesionMetaWhatsapp).toHaveBeenCalledWith({ code: 'CODIGO', wabaId: 'WABA-1' }),
    );
    // El número que Meta dijo llega ya elegido.
    expect(((await screen.findByRole('radio')) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Conectar este número' }));

    await waitFor(() =>
      expect(api.conectarWhatsapp).toHaveBeenCalledWith({
        phoneNumberId: 'PN-1',
        wabaId: 'WABA-1',
        credencial: 'SOBRE-SELLADO',
      }),
    );
    // Los chats llegan después: se dice, para que la bandeja no parezca vacía.
    expect(alConectar.mock.calls[0]![0]).toContain('trayendo los chats');
  });

  it('cerrar la ventana de Meta no enseña un error', async () => {
    sdk.abrirVentanaDeMeta.mockResolvedValue(null);
    const { api } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Meta' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Conectar con Meta' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.sesionMetaWhatsapp).not.toHaveBeenCalled();
  });

  it('si Meta no dice qué cuenta se compartió, se pide repetir y no se llama al servidor', async () => {
    sdk.abrirVentanaDeMeta.mockResolvedValue({ code: 'CODIGO', wabaId: null, phoneNumberId: null });
    const { api } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Meta' }));
    expect((await screen.findByRole('alert')).textContent).toContain('qué cuenta compartiste');
    // El código vale una vez: no se gasta sin saber la cuenta.
    expect(api.sesionMetaWhatsapp).not.toHaveBeenCalled();
  });

  it('lo que diga el servidor —sin plaza en el plan, código caducado— se enseña tal cual', async () => {
    pintar('whatsapp', {
      sesionMetaWhatsapp: vi
        .fn()
        .mockRejectedValue(
          new ErrorDeApi(402, 'limite_de_canales', 'Tu plan incluye 1 canal y ya está conectado.'),
        ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Meta' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Tu plan incluye 1 canal');
  });

  it('Instagram: un inicio de sesión, y se conecta la cuenta con el sobre', async () => {
    sdk.abrirVentanaDeMeta.mockResolvedValue({
      code: 'CODIGO-PG',
      wabaId: null,
      phoneNumberId: null,
    });
    const { api } = pintar('instagram');
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar con Facebook' }));
    expect(sdk.abrirVentanaDeMeta).toHaveBeenCalledWith({ configId: 'CFG-PG', whatsapp: false });
    expect(await screen.findByText('@paraiso')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Conectar esta cuenta' }));
    await waitFor(() =>
      expect(api.conectarInstagram).toHaveBeenCalledWith({
        igUserId: 'IG-1',
        credencial: 'SOBRE-PG',
      }),
    );
  });

  it('quien tiene su propia app de Meta puede seguir pegando sus credenciales', async () => {
    pintar();
    await userEvent.click(
      await screen.findByRole('button', { name: /prefiero pegar sus credenciales/ }),
    );
    expect(screen.getByText('Token de acceso')).toBeTruthy();
    expect(screen.getByText('Clave secreta de la app')).toBeTruthy();
  });

  it('sin plataforma configurada, se conecta pegando credenciales, como siempre', () => {
    pintar('whatsapp', {}, { ...PLATAFORMA, disponible: false, appId: null });
    expect(screen.getByText('Token de acceso')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conectar con Meta' })).toBeNull();
  });

  it('con WhatsApp sin configurar pero páginas sí, cada canal usa lo que tiene', () => {
    pintar('whatsapp', {}, { ...PLATAFORMA, configWhatsapp: null });
    expect(screen.getByText('Token de acceso')).toBeTruthy();
  });
});
