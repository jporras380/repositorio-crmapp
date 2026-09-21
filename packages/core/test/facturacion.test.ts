/**
 * RUC, DNI y el plazo del comprobante.
 *
 * Lo que se prueba es lo que le cuesta dinero a alguien: un RUC mal tecleado
 * no lo rechaza nadie hasta que SUNAT devuelve la factura, semanas después y
 * con el crédito fiscal perdido.
 */
import { describe, expect, it } from 'vitest';
import {
  esDniValido,
  esRucValido,
  HORAS_PARA_EL_COMPROBANTE,
  problemasDeFacturacion,
  venceElComprobante,
} from '../src/facturacion.js';

describe('esRucValido', () => {
  // RUC reales por su forma (dígito de control correcto), no de empresas
  // concretas: lo que se comprueba es la aritmética, no el registro.
  it('acepta un RUC de persona jurídica bien formado', () => {
    expect(esRucValido('20100070970')).toBe(true);
  });

  it('acepta un RUC de persona natural con negocio', () => {
    expect(esRucValido('10426455868')).toBe(true);
  });

  it('rechaza el que tiene el dígito de control cambiado', () => {
    // El error más común: se teclea un dígito de más o de menos y el número
    // sigue «pareciendo» un RUC.
    expect(esRucValido('20100070971')).toBe(false);
  });

  it('acepta también los prefijos antiguos 15 y 17, que siguen vigentes', () => {
    expect(esRucValido('17123456785')).toBe(true);
  });

  it('rechaza los que no empiezan por 10, 15, 17 o 20', () => {
    // Mismo número con otro prefijo: lo que falla es el tipo, no la
    // aritmética, y hay que distinguirlo.
    expect(esRucValido('30100070970')).toBe(false);
  });

  it('rechaza lo que no son once dígitos', () => {
    expect(esRucValido('2010007097')).toBe(false);
    expect(esRucValido('201000709700')).toBe(false);
    expect(esRucValido('2010007097A')).toBe(false);
    expect(esRucValido('')).toBe(false);
  });

  it('no se cae por los espacios de un copiar y pegar', () => {
    expect(esRucValido('  20100070970  ')).toBe(true);
  });
});

describe('esDniValido', () => {
  it('ocho dígitos y nada más', () => {
    expect(esDniValido('12345678')).toBe(true);
    expect(esDniValido('1234567')).toBe(false);
    expect(esDniValido('123456789')).toBe(false);
    expect(esDniValido('1234567A')).toBe(false);
  });
});

describe('problemasDeFacturacion', () => {
  it('una boleta sin nada es válida: por debajo de S/ 700 no hace falta DNI', () => {
    expect(
      problemasDeFacturacion({ tipo: 'boleta', documento: null, nombre: null, direccion: null }),
    ).toEqual([]);
  });

  it('pero un DNI a medias no vale: no sirve para nada', () => {
    const p = problemasDeFacturacion({
      tipo: 'boleta',
      documento: '1234',
      nombre: 'Rosa',
      direccion: null,
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('DNI');
  });

  it('una factura sin RUC, razón social ni dirección dice LAS TRES cosas', () => {
    // De una en una obligaría a mandar el formulario tres veces.
    const p = problemasDeFacturacion({
      tipo: 'factura',
      documento: null,
      nombre: null,
      direccion: null,
    });
    expect(p).toHaveLength(3);
  });

  it('una factura con RUC malo lo dice, y no se queja además de que falte', () => {
    const p = problemasDeFacturacion({
      tipo: 'factura',
      documento: '20100070971',
      nombre: 'Hotel SAC',
      direccion: 'Av. Grau 100, Barranca',
    });
    expect(p).toEqual(['Ese RUC no es válido. Son 11 dígitos.']);
  });

  it('una factura completa no tiene problemas', () => {
    expect(
      problemasDeFacturacion({
        tipo: 'factura',
        documento: '20100070970',
        nombre: 'Apart Hotel El Paraíso SAC',
        direccion: 'Av. Grau 100, Barranca',
      }),
    ).toEqual([]);
  });
});

describe('venceElComprobante', () => {
  it('son 48 horas desde el pago', () => {
    const pago = new Date('2026-09-21T10:00:00Z');
    expect(venceElComprobante(pago).toISOString()).toBe('2026-09-23T10:00:00.000Z');
    expect(HORAS_PARA_EL_COMPROBANTE).toBe(48);
  });
});
