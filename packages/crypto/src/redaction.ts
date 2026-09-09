/**
 * Redacción de secretos en logs (ARCH §11).
 *
 * Dos capas, porque una sola no basta:
 *
 * 1. **Por nombre de campo.** `{ accessToken: 'abc' }` se redacta porque la
 *    clave se llama así. Cubre el caso común y es barato.
 *
 * 2. **Por valor registrado.** Los secretos que la aplicación carga al
 *    arrancar se registran aquí, y cualquier aparición de ese valor exacto se
 *    sustituye — dentro de un objeto anidado, de un mensaje concatenado, de
 *    una URL de conexión o del texto de una excepción.
 *
 * La segunda capa es la que importa de verdad. El caso que filtra credenciales
 * en producción casi nunca es `logger.info({ password })`; es un
 * `logger.error(err)` donde la librería de turno metió la cadena de conexión
 * completa en el mensaje. La redacción por nombre de campo no ve eso.
 *
 * Coste que hay que aceptar: un barrido de cadenas por secreto registrado en
 * cada log. Con la decena escasa de secretos que maneja un proceso es
 * despreciable, y hay un mínimo de longitud para no barrer valores cortos que
 * aparecerían por casualidad en cualquier texto.
 *
 * Lo que NO puede hacer, y conviene tenerlo claro: si un secreto se transforma
 * antes de registrarse (se corta, se codifica en base64, se mete en un hash),
 * deja de coincidir. La redacción es una red, no una garantía.
 */

export const MARCA = '[REDACTADO]';

/**
 * Longitud mínima para registrar un valor. Por debajo, la probabilidad de que
 * aparezca por casualidad en un texto normal supera el valor de redactarlo:
 * imagina redactar cada aparición de "dev".
 */
const MINIMO = 8;

/** Campos cuyo contenido nunca debe salir en un log, por nombre. */
const CAMPOS_SENSIBLES = [
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'ciphertext',
  'dek',
  'dek_wrapped',
  'dekwrapped',
  'privatekey',
  'private_key',
  'masterkey',
  'master_key',
  'passwordhash',
  'password_hash',
  'tokenhash',
  'token_hash',
  'mfa',
  'otp',
];

function esCampoSensible(clave: string): boolean {
  const k = clave.toLowerCase().replace(/[^a-z_]/g, '');
  return CAMPOS_SENSIBLES.some((s) => k.includes(s.replace(/_/g, '')) || k.includes(s));
}

/**
 * Registro de secretos vivos del proceso.
 *
 * Es global a propósito: el logger tiene que poder redactar sin que quien
 * llama le pase la lista de secretos en cada línea. Un registro que hay que
 * recordar pasar es un registro que alguien olvidará.
 */
export class RegistroDeSecretos {
  readonly #valores = new Set<string>();

  /**
   * Registra un valor para que nunca aparezca en un log.
   * Los valores por debajo del mínimo de longitud se ignoran en silencio.
   */
  registrar(...valores: (string | undefined | null)[]): this {
    for (const v of valores) {
      if (typeof v === 'string' && v.length >= MINIMO) this.#valores.add(v);
    }
    return this;
  }

  limpiar(): void {
    this.#valores.clear();
  }

  get tamano(): number {
    return this.#valores.size;
  }

  /** Sustituye cualquier secreto registrado que aparezca en el texto. */
  redactarTexto(texto: string): string {
    let salida = texto;
    for (const secreto of this.#valores) {
      if (salida.includes(secreto)) salida = salida.split(secreto).join(MARCA);
    }
    return salida;
  }

  tieneAlguno(texto: string): boolean {
    for (const secreto of this.#valores) if (texto.includes(secreto)) return true;
    return false;
  }
}

/** Registro compartido por el proceso. */
export const secretos = new RegistroDeSecretos();

/**
 * Devuelve una copia del valor con los secretos redactados.
 *
 * No muta la entrada: un logger que modifica lo que le pasan provoca bugs
 * imposibles de encontrar, porque el objeto queda alterado también para quien
 * lo estaba usando.
 */
export function redactar(valor: unknown, registro: RegistroDeSecretos = secretos): unknown {
  return redactarInterno(valor, registro, new WeakSet(), 0);
}

const PROFUNDIDAD_MAXIMA = 12;

function redactarInterno(
  valor: unknown,
  registro: RegistroDeSecretos,
  vistos: WeakSet<object>,
  profundidad: number,
): unknown {
  if (valor === null || valor === undefined) return valor;

  if (typeof valor === 'string') return registro.redactarTexto(valor);

  if (typeof valor !== 'object') return valor;

  if (profundidad >= PROFUNDIDAD_MAXIMA) return '[PROFUNDIDAD MÁXIMA]';

  // Las referencias circulares son comunes en objetos de error y de conexión.
  if (vistos.has(valor)) return '[CIRCULAR]';
  vistos.add(valor);

  if (valor instanceof Error) {
    return {
      name: valor.name,
      // El mensaje de una excepción es justo donde suelen colarse las cadenas
      // de conexión completas.
      message: registro.redactarTexto(valor.message),
      stack: valor.stack ? registro.redactarTexto(valor.stack) : undefined,
      cause:
        valor.cause === undefined
          ? undefined
          : redactarInterno(valor.cause, registro, vistos, profundidad + 1),
    };
  }

  if (Buffer.isBuffer(valor)) return `[BUFFER ${valor.length} bytes]`;

  if (Array.isArray(valor)) {
    return valor.map((v) => redactarInterno(v, registro, vistos, profundidad + 1));
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    salida[clave] = esCampoSensible(clave)
      ? MARCA
      : redactarInterno(v, registro, vistos, profundidad + 1);
  }
  return salida;
}
