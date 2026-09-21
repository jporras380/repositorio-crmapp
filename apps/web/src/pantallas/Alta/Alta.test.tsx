/**
 * El alta pública.
 *
 * Es la primera pantalla del producto para quien todavía no es cliente, así
 * que lo que se prueba es lo que le hace abandonar: no ver el precio antes de
 * dar el correo, descubrir que el identificador está ocupado después de
 * rellenarlo todo, o que le rechacen la contraseña sin haberle dicho el mínimo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Alta, comoIdentificador } from './Alta.tsx';

const planes = vi.fn();
const slugDisponible = vi.fn();
const crearCuenta = vi.fn();
vi.mock('../../api/cliente.ts', async () => {
  const real = await vi.importActual<typeof import('../../api/cliente.ts')>('../../api/cliente.ts');
  return { ...real, crearApi: () => ({ planes, slugDisponible, crearCuenta }) };
});

const PLANES = [
  {
    codigo: 'starter',
    nombre: 'Starter',
    precioPorAsientoCentimos: 2500,
    moneda: 'USD',
    mesesDePrueba: 1,
    limites: { agentes: 3, conversaciones_mes: 1000 },
  },
  {
    codigo: 'growth',
    nombre: 'Growth',
    precioPorAsientoCentimos: 4900,
    moneda: 'USD',
    mesesDePrueba: 1,
    limites: { agentes: 10, conversaciones_mes: 5000 },
  },
];

beforeEach(() => {
  planes.mockResolvedValue(PLANES);
  slugDisponible.mockResolvedValue({ libre: true, motivo: null });
  crearCuenta.mockResolvedValue({
    token: 't',
    tenantId: 'te1',
    userId: 'u1',
    rol: 'owner',
    expiraEn: 900,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function pintar(alEntrar = vi.fn()) {
  render(<Alta alEntrar={alEntrar} alVolver={vi.fn()} />);
  return { alEntrar };
}

describe('comoIdentificador', () => {
  it('quita tildes, espacios y símbolos', () => {
    expect(comoIdentificador('Apart Hotel El Paraíso')).toBe('apart-hotel-el-paraiso');
    expect(comoIdentificador('  Ñandú & Co.  ')).toBe('nandu-co');
  });

  it('no deja guiones colgando en los extremos', () => {
    // «-mi-hotel-» lo rechazaría el servidor por formato, y el mensaje
    // llegaría después de haber rellenado todo.
    expect(comoIdentificador('¡¡ Mi Hotel !!')).toBe('mi-hotel');
  });
});

describe('Alta pública', () => {
  it('enseña el precio y lo que incluye ANTES de pedir ningún dato', async () => {
    pintar();
    expect(await screen.findByText('Starter')).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
    // Pedir correo y contraseña antes del precio es el orden de quien quiere
    // capturar un contacto, no el de quien quiere que le compren.
    expect(screen.queryByLabelText('Correo')).toBeNull();
  });

  it('al elegir plan aparece el formulario, con el plan en el título', async () => {
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Growth' }));
    expect(screen.getByText(/plan Growth/)).toBeTruthy();
    expect(screen.getByLabelText('Correo')).toBeTruthy();
  });

  it('el identificador se saca del nombre y se puede cambiar', async () => {
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Starter' }));
    await userEvent.type(screen.getByLabelText('Nombre del negocio'), 'Apart Hotel El Paraíso');

    const id = screen.getByLabelText(/^Identificador/) as HTMLInputElement;
    expect(id.value).toBe('apart-hotel-el-paraiso');

    // Al tocarlo deja de seguir al nombre: si no, corregirlo sería imposible.
    await userEvent.clear(id);
    await userEvent.type(id, 'paraiso');
    await userEvent.type(screen.getByLabelText('Nombre del negocio'), ' SAC');
    expect(id.value).toBe('paraiso');
  });

  it('dice que está ocupado MIENTRAS se escribe, no al enviar', async () => {
    slugDisponible.mockResolvedValue({ libre: false, motivo: null });
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Starter' }));
    await userEvent.type(screen.getByLabelText('Nombre del negocio'), 'Acme');

    expect(await screen.findByText(/Ya hay una cuenta con ese identificador/)).toBeTruthy();
    // Y no deja enviar: descubrirlo después de la contraseña pierde a alguien
    // que ya había decidido comprar.
    expect(
      (screen.getByRole('button', { name: 'Crear cuenta' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('avisa del mínimo de contraseña antes de enviar, no después del rechazo', async () => {
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Starter' }));
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'corta');

    const ayuda = screen.getByText('Al menos 10 caracteres.');
    expect(ayuda.className).toContain('ayudaMal');
    expect(
      (screen.getByRole('button', { name: 'Crear cuenta' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('crea la cuenta con el plan elegido y entra directo', async () => {
    const { alEntrar } = pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Growth' }));
    await userEvent.type(screen.getByLabelText('Nombre del negocio'), 'Hostal Miraflores');
    await userEvent.type(screen.getByLabelText('Tu nombre'), 'Rosa');
    await userEvent.type(screen.getByLabelText('Correo'), 'rosa@miraflores.test');
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'una-contrasena-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    await waitFor(() =>
      expect(crearCuenta).toHaveBeenCalledWith(
        expect.objectContaining({
          nombreDeCuenta: 'Hostal Miraflores',
          slug: 'hostal-miraflores',
          planCode: 'growth',
        }),
      ),
    );
    // Entra directo: mandarle a iniciar sesión es pedirle la contraseña que
    // acaba de escribir.
    expect(alEntrar).toHaveBeenCalledWith({
      token: 't',
      tenantId: 'te1',
      userId: 'u1',
      rol: 'owner',
    });
  });

  it('si el servidor rechaza el alta, se ve el motivo y no se pierde lo escrito', async () => {
    const { ErrorDeApi } =
      await vi.importActual<typeof import('../../api/cliente.ts')>('../../api/cliente.ts');
    crearCuenta.mockRejectedValue(
      new ErrorDeApi(409, 'slug_ocupado', 'Ya existe una cuenta con ese identificador.'),
    );
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Starter' }));
    await userEvent.type(screen.getByLabelText('Nombre del negocio'), 'Acme');
    await userEvent.type(screen.getByLabelText('Tu nombre'), 'Rosa');
    await userEvent.type(screen.getByLabelText('Correo'), 'rosa@acme.test');
    await userEvent.type(screen.getByLabelText(/^Contraseña/), 'una-contrasena-larga');
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Ya existe');
    expect((screen.getByLabelText('Correo') as HTMLInputElement).value).toBe('rosa@acme.test');
  });

  it('se puede volver a los planes sin perder la pantalla', async () => {
    pintar();
    await userEvent.click(await screen.findByRole('button', { name: 'Elegir Starter' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar de plan' }));
    expect(await screen.findByRole('button', { name: 'Elegir Growth' })).toBeTruthy();
  });

  it('si los planes no cargan, se dice; no se queda una pantalla en blanco', async () => {
    planes.mockRejectedValue(new Error('red'));
    pintar();
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudieron cargar');
  });
});
