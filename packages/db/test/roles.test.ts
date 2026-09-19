/**
 * El reintento cuando dos procesos pisan el mismo catálogo.
 *
 * Lo que se prueba es exactamente el fallo que tumbó el CI: dos suites
 * poniendo a la vez la contraseña del mismo rol y PostgreSQL contestando
 * «tuple concurrently updated». Sin este test, el reintento sería un trozo de
 * código que nadie sabe por qué está.
 */
import { describe, expect, it, vi } from 'vitest';
import { reintentandoSiChocaElCatalogo } from '../src/roles.js';

const choque = () => new Error('tuple concurrently updated');

describe('reintentandoSiChocaElCatalogo', () => {
  it('a la primera, no reintenta nada', async () => {
    const orden = vi.fn().mockResolvedValue('hecho');
    expect(await reintentandoSiChocaElCatalogo(orden)).toBe('hecho');
    expect(orden).toHaveBeenCalledTimes(1);
  });

  it('si otro proceso lo pisa, insiste y sale bien', async () => {
    const orden = vi
      .fn()
      .mockRejectedValueOnce(choque())
      .mockRejectedValueOnce(choque())
      .mockResolvedValue('hecho');
    expect(await reintentandoSiChocaElCatalogo(orden)).toBe('hecho');
    expect(orden).toHaveBeenCalledTimes(3);
  });

  it('otro error NO se reintenta: se ve tal cual', async () => {
    // Una contraseña mal escrita o un rol que no existe no mejoran repitiendo;
    // tragárselos cinco veces solo retrasaría el mensaje que hace falta leer.
    const orden = vi.fn().mockRejectedValue(new Error('role "nadie" does not exist'));
    await expect(reintentandoSiChocaElCatalogo(orden)).rejects.toThrow('does not exist');
    expect(orden).toHaveBeenCalledTimes(1);
  });

  it('si insiste y sigue chocando, se rinde y dice por qué', async () => {
    const orden = vi.fn().mockRejectedValue(choque());
    await expect(reintentandoSiChocaElCatalogo(orden, 3)).rejects.toThrow(
      'tuple concurrently updated',
    );
    expect(orden).toHaveBeenCalledTimes(3);
  });
});
