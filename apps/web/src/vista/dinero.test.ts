/**
 * Importes.
 *
 * Lo que se prueba aquí es lo que cuesta dinero equivocar: que «1,500» no se
 * guarde como un sol y medio, y que el formato de la tarjeta sea legible sin
 * decimales inventados.
 */
import { describe, expect, it } from 'vitest';
import { aCampo, aCentimos, importe } from './dinero.ts';

describe('aCentimos', () => {
  it('lo que escribe una persona, en céntimos', () => {
    expect(aCentimos('120')).toBe(12_000);
    expect(aCentimos('120.5')).toBe(12_050);
    expect(aCentimos('120,50')).toBe(12_050);
    expect(aCentimos('S/ 1,234.56')).toBe(123_456);
  });

  it('el separador de miles NO es decimal: «1,500» son mil quinientos', () => {
    // El caso que arruina un pronóstico: tres dígitos detrás de la coma no
    // pueden ser céntimos, así que es separador de miles.
    expect(aCentimos('1,500')).toBe(150_000);
    expect(aCentimos('1.500')).toBe(150_000);
    expect(aCentimos('1 234 567')).toBe(123_456_700);
  });

  it('lo vacío y lo absurdo valen cero, no NaN', () => {
    expect(aCentimos('')).toBe(0);
    expect(aCentimos('abc')).toBe(0);
    expect(aCentimos('-40')).toBe(4000); // el signo se ignora: no hay ventas negativas
  });
});

describe('importe', () => {
  it('pinta la moneda del embudo y se ahorra los decimales cuando sobran', () => {
    expect(importe(12_000, 'PEN')).toMatch(/120/);
    expect(importe(12_000, 'PEN')).not.toMatch(/,00|\.00/);
    expect(importe(12_050, 'PEN')).toMatch(/120[.,]50/);
  });

  it('una moneda desconocida no deja la tarjeta en blanco', () => {
    expect(importe(5000, 'XXX')).toContain('50');
  });
});

describe('aCampo', () => {
  it('ida y vuelta sin perder nada', () => {
    for (const texto of ['0', '120', '120.50', '1,500']) {
      expect(aCentimos(aCampo(aCentimos(texto)))).toBe(aCentimos(texto));
    }
    expect(aCampo(0)).toBe('');
  });
});
