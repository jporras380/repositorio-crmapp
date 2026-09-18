/**
 * TOTP.
 *
 * Los vectores del RFC 6238 son la prueba que importa: si coinciden, el
 * algoritmo es el que esperan Google Authenticator y todas las demás. Lo
 * escrito a mano sin esos vectores funciona en los tests propios y falla
 * delante de un móvil real.
 */
import { describe, expect, it } from 'vitest';
import {
  aBase32,
  codigoTotp,
  deBase32,
  enlaceDeAutenticador,
  esCodigoValido,
} from '../src/totp.js';

/** El secreto del RFC 6238 en SHA-1: «12345678901234567890» en base32. */
const SECRETO_RFC = aBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('ida y vuelta conserva los bytes', () => {
    const datos = Buffer.from([0x00, 0xff, 0x10, 0x7a, 0x9b]);
    expect(deBase32(aBase32(datos))).toEqual(datos);
  });

  it('acepta el secreto con espacios y minúsculas, que es como se teclea', () => {
    const datos = Buffer.from('hola mundo!!', 'ascii');
    const texto = aBase32(datos);
    const comoLoTeclea = texto.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(deBase32(comoLoTeclea)).toEqual(datos);
  });

  it('un carácter imposible se rechaza en vez de dar un secreto distinto', () => {
    expect(() => deBase32('AAAA1AAA')).toThrow();
  });
});

describe('codigoTotp contra los vectores del RFC 6238', () => {
  // Del apéndice B del RFC, con SHA-1 y 8 dígitos; aquí se comparan los 6
  // últimos, que es lo que genera esta implementación.
  const casos: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];
  for (const [segundos, esperado] of casos) {
    it(`en ${segundos} da ${esperado.slice(-6)}`, () => {
      expect(codigoTotp(SECRETO_RFC, new Date(segundos * 1000))).toBe(esperado.slice(-6));
    });
  }
});

describe('esCodigoValido', () => {
  const ahora = new Date(1111111109 * 1000);

  it('acepta el de ahora', () => {
    expect(esCodigoValido(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora), ahora)).toBe(true);
  });

  it('acepta el del paso anterior: se tarda en teclear seis dígitos', () => {
    const anterior = codigoTotp(SECRETO_RFC, ahora, -1);
    expect(esCodigoValido(SECRETO_RFC, anterior, ahora)).toBe(true);
  });

  it('rechaza uno de hace cinco minutos', () => {
    const viejo = codigoTotp(SECRETO_RFC, new Date(ahora.getTime() - 300_000));
    expect(esCodigoValido(SECRETO_RFC, viejo, ahora)).toBe(false);
  });

  it('acepta el código escrito con un espacio, como lo copia la gente', () => {
    const codigo = codigoTotp(SECRETO_RFC, ahora);
    expect(esCodigoValido(SECRETO_RFC, `${codigo.slice(0, 3)} ${codigo.slice(3)}`, ahora)).toBe(
      true,
    );
  });

  it('lo que no son seis dígitos se rechaza sin calcular nada', () => {
    for (const malo of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
      expect(esCodigoValido(SECRETO_RFC, malo, ahora)).toBe(false);
    }
  });
});

describe('enlaceDeAutenticador', () => {
  it('lleva emisor y cuenta: sin ellos, cinco cuentas son cinco números iguales', () => {
    const enlace = enlaceDeAutenticador({
      secretoBase32: SECRETO_RFC,
      cuenta: 'rosa@hotel.test',
      emisor: 'CRM del hotel',
    });
    expect(enlace.startsWith('otpauth://totp/')).toBe(true);
    expect(enlace).toContain(encodeURIComponent('CRM del hotel:rosa@hotel.test'));
    expect(enlace).toContain(`secret=${SECRETO_RFC}`);
  });
});
