import { describe, expect, it } from 'vitest';
import {
  Cifrador,
  ErrorDeCifrado,
  generarClaveMaestra,
  igualesEnTiempoConstante,
  parsearClaveMaestra,
} from '../src/envelope.js';

const v1 = parsearClaveMaestra(generarClaveMaestra());
const v2 = parsearClaveMaestra(generarClaveMaestra());

const cifrador = (versionActual = 1, claves: Record<number, Buffer> = { 1: v1 }) =>
  new Cifrador({ versionActual, claves });

/** Voltea el ultimo byte, para simular manipulacion del dato en reposo. */
function corromperUltimoByte(b: Buffer): void {
  const i = b.length - 1;
  b[i] = (b[i] ?? 0) ^ 0xff;
}

describe('ciclo de cifrado', () => {
  it('lo cifrado se recupera intacto', () => {
    const c = cifrador();
    const token = 'EAAG_token_con_acentos_y_símbolos_€ñ';
    expect(c.descifrarTexto(c.cifrar(token))).toBe(token);
  });

  it('cifrar dos veces el mismo texto da resultados distintos', () => {
    // DEK e IV nuevos en cada llamada. Si dos ciphertexts iguales delataran
    // dos secretos iguales, un atacante con acceso de lectura a la base
    // sabría qué clientes comparten credencial.
    const c = cifrador();
    const a = c.cifrar('mismo valor');
    const b = c.cifrar('mismo valor');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });

  it('un ciphertext manipulado falla en vez de devolver basura', () => {
    // Es lo que aporta GCM sobre un cifrado sin autenticar: detecta la
    // manipulación en lugar de descifrar a datos corruptos silenciosamente.
    const c = cifrador();
    const secreto = c.cifrar('intacto');
    corromperUltimoByte(secreto.ciphertext);
    expect(() => c.descifrar(secreto)).toThrow(ErrorDeCifrado);
  });

  it('una DEK manipulada también falla', () => {
    const c = cifrador();
    const secreto = c.cifrar('intacto');
    corromperUltimoByte(secreto.dekWrapped);
    expect(() => c.descifrar(secreto)).toThrow(ErrorDeCifrado);
  });

  it('otra clave maestra no puede descifrar', () => {
    const secreto = cifrador().cifrar('privado');
    const intruso = new Cifrador({ versionActual: 1, claves: { 1: v2 } });
    expect(() => intruso.descifrar(secreto)).toThrow(ErrorDeCifrado);
  });

  it('un dato truncado da un error claro y no una excepción rara', () => {
    const c = cifrador();
    const secreto = c.cifrar('algo');
    secreto.ciphertext = secreto.ciphertext.subarray(0, 4);
    expect(() => c.descifrar(secreto)).toThrow(/truncado o corrupto/);
  });
});

describe('rotación de clave maestra', () => {
  it('durante la rotación conviven las dos versiones', () => {
    const antiguo = cifrador(1, { 1: v1 });
    const secreto = antiguo.cifrar('token del cliente');

    // El proceso ya cifra con v2 pero sigue sabiendo leer lo de v1.
    const nuevo = cifrador(2, { 1: v1, 2: v2 });
    expect(nuevo.descifrarTexto(secreto)).toBe('token del cliente');
    expect(nuevo.cifrar('nuevo').keyVersion).toBe(2);
  });

  it('reenvolver NO toca el ciphertext', () => {
    // Es la razón de ser del envelope encryption: rotar reescribe 32 bytes por
    // fila, no el secreto entero. Si esto dejara de cumplirse, rotar pasaría a
    // ser una migración de datos de horas.
    const antiguo = cifrador(1, { 1: v1 });
    const secreto = antiguo.cifrar('token del cliente');

    const nuevo = cifrador(2, { 1: v1, 2: v2 });
    const reenvuelto = nuevo.reenvolver(secreto);

    expect(reenvuelto.ciphertext.equals(secreto.ciphertext)).toBe(true);
    expect(reenvuelto.dekWrapped.equals(secreto.dekWrapped)).toBe(false);
    expect(reenvuelto.keyVersion).toBe(2);
    expect(nuevo.descifrarTexto(reenvuelto)).toBe('token del cliente');
  });

  it('reenvolver algo que ya está en la versión actual no hace nada', () => {
    const c = cifrador(2, { 1: v1, 2: v2 });
    const secreto = c.cifrar('x');
    expect(c.reenvolver(secreto)).toBe(secreto);
  });

  it('retirar una clave antes de terminar la rotación deja el dato ilegible', () => {
    // Documenta el modo de fallo, para que quien retire una versión sepa qué
    // está arriesgando. El mensaje del error lo dice explícitamente.
    const secreto = cifrador(1, { 1: v1 }).cifrar('perdido');
    const soloV2 = cifrador(2, { 2: v2 });
    expect(() => soloV2.descifrar(secreto)).toThrow(/irrecuperable/);
  });
});

describe('validación al construir', () => {
  it('rechaza una clave maestra que no mide 32 bytes', () => {
    expect(() => parsearClaveMaestra(Buffer.from('corta').toString('base64'))).toThrow(
      /debe ser de 32 bytes/,
    );
  });

  it('el mensaje de error dice cómo generar una clave válida', () => {
    // Un error de arranque que no dice cómo arreglarlo cuesta media hora.
    expect(() => parsearClaveMaestra('AAAA')).toThrow(/openssl rand -base64 32/);
  });

  it('no se puede construir sin la clave de la versión actual', () => {
    expect(() => new Cifrador({ versionActual: 3, claves: { 1: v1 } })).toThrow(
      /No hay clave para la versión actual/,
    );
  });
});

describe('comparación en tiempo constante', () => {
  it('compara correctamente', () => {
    expect(igualesEnTiempoConstante('token-abc', 'token-abc')).toBe(true);
    expect(igualesEnTiempoConstante('token-abc', 'token-abd')).toBe(false);
  });

  it('longitudes distintas devuelven false sin lanzar', () => {
    // timingSafeEqual lanza si los buffers no miden lo mismo.
    expect(igualesEnTiempoConstante('corto', 'muchísimo más largo')).toBe(false);
  });
});
