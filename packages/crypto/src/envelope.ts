/**
 * Envelope encryption para los secretos de inquilino (ARCH §11).
 *
 * Cada secreto se cifra con una clave propia de un solo uso (la DEK), y esa
 * DEK se cifra con la clave maestra del proceso. En la base quedan las dos
 * cosas: `ciphertext` y `dek_wrapped`.
 *
 * Por qué no cifrar directamente con la maestra, que sería más simple:
 *
 * - **Rotar la maestra no obliga a reescribir los secretos.** Basta con volver
 *   a envolver las DEK, que son 32 bytes cada una, en vez de descifrar y
 *   recifrar tokens completos de miles de clientes.
 * - **Un secreto comprometido no compromete a los demás**, porque cada uno
 *   tiene su propia DEK.
 * - `key_version` va por fila, así que las claves viejas siguen descifrando lo
 *   suyo mientras la migración avanza. Una rotación que exige parar el mundo
 *   no se hace nunca.
 *
 * AES-256-GCM en las dos capas: cifra y autentica a la vez, así que un
 * ciphertext manipulado falla al descifrar en lugar de devolver basura.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const LONGITUD_CLAVE = 32;
const LONGITUD_IV = 12; // 96 bits, el tamaño recomendado para GCM
const LONGITUD_TAG = 16;

export interface SecretoCifrado {
  ciphertext: Buffer;
  dekWrapped: Buffer;
  keyVersion: number;
}

export class ErrorDeCifrado extends Error {
  constructor(mensaje: string, options?: { cause?: unknown }) {
    super(mensaje, options);
    this.name = 'ErrorDeCifrado';
  }
}

/** Une IV + tag + datos en un solo buffer, para guardar una sola columna. */
function empaquetar(iv: Buffer, tag: Buffer, datos: Buffer): Buffer {
  return Buffer.concat([iv, tag, datos]);
}

function desempaquetar(blob: Buffer): { iv: Buffer; tag: Buffer; datos: Buffer } {
  if (blob.length < LONGITUD_IV + LONGITUD_TAG) {
    throw new ErrorDeCifrado('El dato cifrado está truncado o corrupto.');
  }
  return {
    iv: blob.subarray(0, LONGITUD_IV),
    tag: blob.subarray(LONGITUD_IV, LONGITUD_IV + LONGITUD_TAG),
    datos: blob.subarray(LONGITUD_IV + LONGITUD_TAG),
  };
}

function cifrarCon(clave: Buffer, textoPlano: Buffer): Buffer {
  const iv = randomBytes(LONGITUD_IV);
  const cipher = createCipheriv(ALGORITMO, clave, iv);
  const datos = Buffer.concat([cipher.update(textoPlano), cipher.final()]);
  return empaquetar(iv, cipher.getAuthTag(), datos);
}

function descifrarCon(clave: Buffer, blob: Buffer): Buffer {
  const { iv, tag, datos } = desempaquetar(blob);
  const decipher = createDecipheriv(ALGORITMO, clave, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(datos), decipher.final()]);
  } catch (error) {
    // GCM falla aquí si el ciphertext o el tag fueron manipulados. El mensaje
    // de la librería no aporta nada y sí puede confundir.
    throw new ErrorDeCifrado('No se pudo descifrar: clave incorrecta o dato manipulado.', {
      cause: error,
    });
  }
}

/** Convierte una clave maestra en base64 a buffer, validando su tamaño. */
export function parsearClaveMaestra(base64: string): Buffer {
  let clave: Buffer;
  try {
    clave = Buffer.from(base64, 'base64');
  } catch (error) {
    throw new ErrorDeCifrado('La clave maestra no es base64 válido.', { cause: error });
  }
  if (clave.length !== LONGITUD_CLAVE) {
    throw new ErrorDeCifrado(
      `La clave maestra debe ser de ${LONGITUD_CLAVE} bytes (${clave.length} recibidos). ` +
        `Genera una con: openssl rand -base64 32`,
    );
  }
  return clave;
}

/** Genera una clave maestra nueva en base64. Para el arranque y la rotación. */
export function generarClaveMaestra(): string {
  return randomBytes(LONGITUD_CLAVE).toString('base64');
}

export interface OpcionesDeCifrador {
  /** Versión con la que se cifra lo nuevo. */
  versionActual: number;
  /**
   * Todas las versiones que el proceso sabe descifrar.
   *
   * Durante una rotación conviven al menos dos: se cifra con la nueva y se
   * sigue pudiendo leer lo cifrado con la anterior. Quitar la vieja antes de
   * terminar la migración deja secretos ilegibles.
   */
  claves: Record<number, Buffer>;
}

export class Cifrador {
  readonly #claves: Map<number, Buffer>;
  readonly #versionActual: number;

  constructor(opciones: OpcionesDeCifrador) {
    this.#claves = new Map(Object.entries(opciones.claves).map(([v, k]) => [Number(v), k]));
    this.#versionActual = opciones.versionActual;

    if (!this.#claves.has(this.#versionActual)) {
      throw new ErrorDeCifrado(
        `No hay clave para la versión actual (${this.#versionActual}). ` +
          `Versiones disponibles: ${[...this.#claves.keys()].join(', ') || 'ninguna'}.`,
      );
    }
    for (const [version, clave] of this.#claves) {
      if (clave.length !== LONGITUD_CLAVE) {
        throw new ErrorDeCifrado(`La clave de versión ${version} no mide ${LONGITUD_CLAVE} bytes.`);
      }
    }
  }

  get versionActual(): number {
    return this.#versionActual;
  }

  /** Cifra un secreto con una DEK nueva, envuelta con la clave maestra actual. */
  cifrar(textoPlano: string | Buffer): SecretoCifrado {
    const dek = randomBytes(LONGITUD_CLAVE);
    const maestra = this.#claves.get(this.#versionActual)!;
    const datos = typeof textoPlano === 'string' ? Buffer.from(textoPlano, 'utf8') : textoPlano;

    return {
      ciphertext: cifrarCon(dek, datos),
      dekWrapped: cifrarCon(maestra, dek),
      keyVersion: this.#versionActual,
    };
  }

  descifrar(secreto: SecretoCifrado): Buffer {
    const maestra = this.#claves.get(secreto.keyVersion);
    if (!maestra) {
      throw new ErrorDeCifrado(
        `No hay clave maestra de versión ${secreto.keyVersion}. ` +
          `Si se retiró antes de terminar una rotación, este secreto es irrecuperable.`,
      );
    }
    const dek = descifrarCon(maestra, secreto.dekWrapped);
    return descifrarCon(dek, secreto.ciphertext);
  }

  descifrarTexto(secreto: SecretoCifrado): string {
    return this.descifrar(secreto).toString('utf8');
  }

  /**
   * Vuelve a envolver la DEK con la clave actual, SIN tocar el ciphertext.
   *
   * Es la operación que hace barata la rotación: se reescriben 32 bytes por
   * fila en vez de descifrar y recifrar el secreto completo. El
   * `ciphertext` sale idéntico, y hay un test que lo comprueba.
   */
  reenvolver(secreto: SecretoCifrado): SecretoCifrado {
    if (secreto.keyVersion === this.#versionActual) return secreto;

    const antigua = this.#claves.get(secreto.keyVersion);
    if (!antigua) {
      throw new ErrorDeCifrado(`No hay clave maestra de versión ${secreto.keyVersion}.`);
    }
    const dek = descifrarCon(antigua, secreto.dekWrapped);
    const actual = this.#claves.get(this.#versionActual)!;

    return {
      ciphertext: secreto.ciphertext,
      dekWrapped: cifrarCon(actual, dek),
      keyVersion: this.#versionActual,
    };
  }
}

/**
 * Comparación en tiempo constante, para verificar tokens de invitación y
 * webhooks sin filtrar información por el tiempo que tarda en fallar.
 */
export function igualesEnTiempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual exige la misma longitud; comparar longitudes antes ya
  // filtra ese dato, pero la longitud de un token no es un secreto útil.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
