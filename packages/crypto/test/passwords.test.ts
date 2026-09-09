import { describe, expect, it } from 'vitest';
import {
  PARAMS_ACTUALES,
  hashearContrasena,
  necesitaRehash,
  verificarContrasena,
} from '../src/passwords.js';

// Parametros bajos para que los tests no tarden minutos. La produccion usa
// PARAMS_ACTUALES; aqui se prueba la mecanica, no el coste.
const RAPIDO = { N: 1024, r: 8, p: 1 };

describe('hash y verificacion', () => {
  it('acepta la contrasena correcta', async () => {
    const h = await hashearContrasena('correcta-horse-battery', RAPIDO);
    expect(await verificarContrasena('correcta-horse-battery', h)).toBe(true);
  });

  it('rechaza la incorrecta', async () => {
    const h = await hashearContrasena('correcta', RAPIDO);
    expect(await verificarContrasena('incorrecta', h)).toBe(false);
  });

  it('dos hashes de la misma contrasena son distintos', async () => {
    // Sal aleatoria por hash. Si fueran iguales, la base delataria que dos
    // usuarios comparten contrasena.
    const a = await hashearContrasena('misma', RAPIDO);
    const b = await hashearContrasena('misma', RAPIDO);
    expect(a).not.toBe(b);
    expect(await verificarContrasena('misma', a)).toBe(true);
    expect(await verificarContrasena('misma', b)).toBe(true);
  });

  it('normaliza Unicode', async () => {
    // "ñ" se puede escribir de dos formas distintas en Unicode. Sin
    // normalizar, un usuario con teclado distinto no puede entrar.
    const compuesta = 'contraseña';
    const precompuesta = 'contraseña';
    expect(compuesta).not.toBe(precompuesta);
    const h = await hashearContrasena(compuesta, RAPIDO);
    expect(await verificarContrasena(precompuesta, h)).toBe(true);
  });

  it('soporta contrasenas largas y con emoji', async () => {
    const larga = 'a'.repeat(200) + ' 🔐 ñ';
    const h = await hashearContrasena(larga, RAPIDO);
    expect(await verificarContrasena(larga, h)).toBe(true);
  });
});

describe('robustez ante datos corruptos', () => {
  it.each([
    ['vacio', ''],
    ['sin prefijo', 'bcrypt$1024$8$1$c2Fs$aGFzaA=='],
    ['campos de menos', 'scrypt$1024$8$1'],
    ['parametros no numericos', 'scrypt$x$8$1$c2Fs$aGFzaA=='],
    ['basura', 'no-es-un-hash'],
  ])('devuelve false y no lanza con %s', async (_caso, almacenado) => {
    // Un registro estropeado no debe convertirse en un 500, que ademas
    // delataria que ese usuario existe.
    await expect(verificarContrasena('lo-que-sea', almacenado)).resolves.toBe(false);
  });
});

describe('rehash', () => {
  it('marca los hashes generados con parametros mas debiles', async () => {
    const debil = await hashearContrasena('x', RAPIDO);
    expect(necesitaRehash(debil)).toBe(true);
  });

  it('no marca los generados con los parametros actuales', async () => {
    const actual = await hashearContrasena('x', PARAMS_ACTUALES);
    expect(necesitaRehash(actual)).toBe(false);
  });

  it('un hash ilegible hay que regenerarlo si o si', () => {
    expect(necesitaRehash('basura')).toBe(true);
  });

  it('el hash lleva sus parametros dentro', async () => {
    // Es lo que permite endurecerlos con el tiempo sin invalidar las
    // contrasenas existentes.
    const h = await hashearContrasena('x', RAPIDO);
    expect(h.startsWith('scrypt$1024$8$1$')).toBe(true);
  });
});
