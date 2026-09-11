/**
 * Importar clientes.
 *
 * Lo que importa aquí no es que suba un archivo: es que **diga lo que pasó**.
 * Una importación que contesta «listo» y se ha comido dos columnas y tres
 * filas es la forma más rápida de que alguien pierda la confianza en el CRM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Api } from '../../api/cliente.ts';
import { Importar } from './Importar.tsx';

afterEach(cleanup);

const RESULTADO = {
  creados: 2,
  actualizados: 1,
  omitidos: 1,
  errores: [{ linea: 7, motivo: 'El teléfono o el correo ya están en otro cliente.' }],
  columnasIgnoradas: ['signo del zodiaco'],
};

function pintar(importar = vi.fn().mockResolvedValue(RESULTADO)) {
  const api = { importarClientes: importar } as unknown as Api;
  render(<Importar api={api} alCerrar={vi.fn()} alTerminar={vi.fn()} />);
  return importar;
}

const archivo = () =>
  new File(['nombre,telefono\nAna,+51999111222'], 'clientes.csv', { type: 'text/csv' });

describe('Importar', () => {
  it('sin archivo no deja importar', () => {
    pintar();
    expect(screen.getByRole('button', { name: 'Importar' }).hasAttribute('disabled')).toBe(true);
  });

  it('manda el CSV con el prefijo elegido, no con uno adivinado', async () => {
    const importar = pintar();
    await userEvent.upload(screen.getByLabelText('Archivo CSV'), archivo());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Importar' }).hasAttribute('disabled')).toBe(false),
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), '+56');
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));

    await waitFor(() => expect(importar).toHaveBeenCalled());
    expect(importar.mock.calls[0]![0]).toContain('Ana,+51999111222');
    expect(importar.mock.calls[0]![1]).toBe('+56');
  });

  it('se puede pedir que NO complete ningún prefijo', async () => {
    const importar = pintar();
    await userEvent.upload(screen.getByLabelText('Archivo CSV'), archivo());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Importar' }).hasAttribute('disabled')).toBe(false),
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await waitFor(() => expect(importar).toHaveBeenCalled());
    expect(importar.mock.calls[0]![1]).toBeUndefined();
  });

  it('cuenta lo que hizo, y también lo que dejó fuera', async () => {
    pintar();
    await userEvent.upload(screen.getByLabelText('Archivo CSV'), archivo());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Importar' }).hasAttribute('disabled')).toBe(false),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));

    const informe = await screen.findByRole('status');
    expect(informe.textContent).toContain('2');
    expect(informe.textContent).toContain('1 sin datos suficientes');
    // Las columnas ignoradas se dicen: tragárselas en silencio es peor.
    expect(screen.getByText(/signo del zodiaco/)).toBeTruthy();
    expect(screen.getByText(/Línea 7/)).toBeTruthy();
  });

  it('si el servidor rechaza el archivo, se ve el motivo', async () => {
    pintar(vi.fn().mockRejectedValue(new Error('No se reconoce ninguna columna.')));
    await userEvent.upload(screen.getByLabelText('Archivo CSV'), archivo());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Importar' }).hasAttribute('disabled')).toBe(false),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Importar' }));
    expect(await screen.findByText('No se reconoce ninguna columna.')).toBeTruthy();
  });
});
