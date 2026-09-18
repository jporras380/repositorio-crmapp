/**
 * Códigos de un solo uso por tiempo (TOTP, RFC 6238).
 *
 * Es lo que usan Google Authenticator, Authy y 1Password: un secreto
 * compartido y un contador que avanza cada 30 segundos. No hace falta red, ni
 * SMS —que son interceptables y cuestan dinero—, ni ningún proveedor.
 *
 * ## Por qué escrito aquí y no con una librería
 *
 * Son cuarenta líneas sobre `crypto` de Node: HMAC-SHA1 del contador y un
 * truncado que define el RFC. Una dependencia para esto es superficie que
 * mantener, y el algoritmo lleva sin cambiar desde 2011.
 *
 * ## Por qué vive en `core`
 *
 * Es una función pura: mismo secreto y mismo instante, mismo código. Se puede
 * probar sin base de datos y sin red, que es justo lo que se quiere de algo
 * que decide si alguien entra.
 */
import { createHmac } from 'node:crypto';

/** Cada cuánto cambia el código. 30 s es lo que esperan todas las apps. */
const PASO_SEGUNDOS = 30;
const DIGITOS = 6;

/**
 * Cuántos pasos atrás y adelante se aceptan.
 *
 * Uno: el reloj del móvil rara vez va más de medio minuto desviado, y cada
 * paso extra multiplica por dos las combinaciones que valen. Cero sería
 * correcto y rechazaría a quien tarda tres segundos en teclear.
 */
const TOLERANCIA = 1;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 sin relleno, que es como lo piden las apps de autenticación. */
export function aBase32(datos: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of datos) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  return salida;
}

export function deBase32(texto: string): Buffer {
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const caracter of texto.toUpperCase().replace(/[\s=]/g, '')) {
    const i = ALFABETO_BASE32.indexOf(caracter);
    if (i === -1) throw new Error(`Carácter no válido en base32: "${caracter}"`);
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** El código de ese secreto en ese instante. */
export function codigoTotp(secretoBase32: string, instante: Date, paso = 0): string {
  const contador = Math.floor(instante.getTime() / 1000 / PASO_SEGUNDOS) + paso;
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(contador));
  const hmac = createHmac('sha1', deBase32(secretoBase32)).update(buffer).digest();
  // Truncado dinámico del RFC: los 4 últimos bits dicen dónde empieza.
  const desde = hmac[hmac.length - 1]! & 15;
  const numero =
    ((hmac[desde]! & 127) << 24) |
    (hmac[desde + 1]! << 16) |
    (hmac[desde + 2]! << 8) |
    hmac[desde + 3]!;
  return String(numero % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

/**
 * ¿Es válido este código ahora?
 *
 * Se comparan TODOS los pasos tolerados aunque el primero ya coincida: salir
 * antes filtra por tiempo y le dice a quien mide cuál de los códigos acertó.
 * A esta escala da igual, pero cuesta lo mismo hacerlo bien.
 */
export function esCodigoValido(secretoBase32: string, codigo: string, instante: Date): boolean {
  const limpio = codigo.replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpio)) return false;
  let acierto = false;
  for (let paso = -TOLERANCIA; paso <= TOLERANCIA; paso++) {
    if (iguales(codigoTotp(secretoBase32, instante, paso), limpio)) acierto = true;
  }
  return acierto;
}

/** Comparación sin salida anticipada. Las dos cadenas miden lo mismo. */
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

/**
 * El enlace que leen las apps de autenticación.
 *
 * El emisor sale en la app junto al código: sin él, quien tenga cinco cuentas
 * ve cinco números sin saber cuál es cuál.
 */
export function enlaceDeAutenticador(p: {
  secretoBase32: string;
  cuenta: string;
  emisor: string;
}): string {
  const etiqueta = encodeURIComponent(`${p.emisor}:${p.cuenta}`);
  const parametros = new URLSearchParams({
    secret: p.secretoBase32,
    issuer: p.emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASO_SEGUNDOS),
  });
  return `otpauth://totp/${etiqueta}?${parametros.toString()}`;
}
