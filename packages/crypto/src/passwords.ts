/**
 * Hash de contraseñas con scrypt.
 *
 * **Por qué scrypt y no argon2 o bcrypt.** Los dos son mejores opciones en
 * abstracto, pero los dos exigen compilación nativa en la instalación, y este
 * repositorio deniega los scripts de instalación por política
 * (`pnpm-workspace.yaml`). Levantar esa política para el hash de contraseñas
 * sería cambiar una decisión de seguridad para conseguir otra.
 *
 * scrypt viene en `node:crypto`, es memory-hard, y OWASP lo acepta como
 * alternativa cuando argon2 no está disponible. Cero dependencias y cero
 * compilación.
 *
 * El formato guardado lleva los parámetros dentro:
 *
 *     scrypt$N$r$p$salt_b64$hash_b64
 *
 * Eso permite endurecerlos con el tiempo sin invalidar las contraseñas
 * existentes: cada hash sabe con qué coste se generó. `necesitaRehash()` dice
 * cuáles conviene regenerar en el próximo inicio de sesión correcto, que es el
 * único momento en que se tiene la contraseña en claro.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify pierde la sobrecarga de scrypt que acepta opciones, y sin
// opciones no se puede subir maxmem. Se tipa a mano.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Parámetros actuales. N=2^16 tarda del orden de 100 ms y usa unos 64 MB.
 * `maxmem` hay que subirlo a mano: el valor por defecto de Node (32 MB) es
 * menor que lo que N=65536 necesita, y el error que da no lo explica.
 */
export const PARAMS_ACTUALES = { N: 65536, r: 8, p: 1 } as const;
const LONGITUD_CLAVE = 64;
const LONGITUD_SAL = 16;
const maxmem = (N: number, r: number) => 128 * N * r * 2;

export class HashDeContrasenaInvalido extends Error {
  constructor(motivo: string) {
    super(`Hash de contraseña inválido: ${motivo}`);
    this.name = 'HashDeContrasenaInvalido';
  }
}

export async function hashearContrasena(
  contrasena: string,
  params: { N: number; r: number; p: number } = PARAMS_ACTUALES,
): Promise<string> {
  const sal = randomBytes(LONGITUD_SAL);
  const hash = await scrypt(contrasena.normalize('NFKC'), sal, LONGITUD_CLAVE, {
    ...params,
    maxmem: maxmem(params.N, params.r),
  });

  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    sal.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

interface HashDesempaquetado {
  N: number;
  r: number;
  p: number;
  sal: Buffer;
  hash: Buffer;
}

function desempaquetar(almacenado: string): HashDesempaquetado {
  const partes = almacenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') {
    throw new HashDeContrasenaInvalido('formato desconocido');
  }
  const [, N, r, p, sal, hash] = partes;
  const nums = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Number.isInteger(nums.N) || !Number.isInteger(nums.r) || !Number.isInteger(nums.p)) {
    throw new HashDeContrasenaInvalido('parámetros no numéricos');
  }
  return { ...nums, sal: Buffer.from(sal!, 'base64'), hash: Buffer.from(hash!, 'base64') };
}

/**
 * Verifica una contraseña.
 *
 * Devuelve `false` ante un hash corrupto en vez de lanzar: un registro
 * estropeado en la base no debe convertirse en un error 500 que además delata
 * que ese usuario existe.
 */
export async function verificarContrasena(
  contrasena: string,
  almacenado: string,
): Promise<boolean> {
  let d: HashDesempaquetado;
  try {
    d = desempaquetar(almacenado);
  } catch {
    return false;
  }

  const calculado = await scrypt(contrasena.normalize('NFKC'), d.sal, d.hash.length, {
    N: d.N,
    r: d.r,
    p: d.p,
    maxmem: maxmem(d.N, d.r),
  });

  // Comparación en tiempo constante: comparar con === filtra por el tiempo
  // cuántos bytes iniciales coinciden.
  return calculado.length === d.hash.length && timingSafeEqual(calculado, d.hash);
}

/**
 * Si el hash se generó con parámetros más débiles que los actuales.
 *
 * Se comprueba tras un inicio de sesión correcto, que es el único momento en
 * que se tiene la contraseña en claro para poder regenerarlo.
 */
export function necesitaRehash(almacenado: string): boolean {
  try {
    const d = desempaquetar(almacenado);
    return d.N < PARAMS_ACTUALES.N || d.r < PARAMS_ACTUALES.r || d.p < PARAMS_ACTUALES.p;
  } catch {
    // Un hash ilegible hay que regenerarlo sí o sí.
    return true;
  }
}
