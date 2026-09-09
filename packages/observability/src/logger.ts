/**
 * Logger estructurado (ARCH §13).
 *
 * **Por qué escrito a mano y no pino.** Añadir una librería de logging es una
 * dependencia de peso y está en la lista de parada, así que se pregunta antes
 * (P-22). Mientras tanto, esto: JSON por línea, niveles, contexto heredado y
 * redacción obligatoria.
 *
 * El cambio a pino, si se aprueba, es pequeño **porque la redacción vive en
 * `@crmapp/crypto` y no aquí**. Lo específico del proyecto —qué es un secreto
 * y cómo se oculta— no depende de qué librería escriba la línea. Esa
 * separación es deliberada: es lo que hace que esta decisión sea barata de
 * revertir.
 *
 * Todo lo que se registra pasa por `redactar()`. No hay forma de saltárselo
 * sin editar este archivo, y eso es a propósito: un camino de escape cómodo se
 * acaba usando.
 */
import { redactar, type RegistroDeSecretos } from '@crmapp/crypto';

export type Nivel = 'debug' | 'info' | 'warn' | 'error';

const ORDEN: Record<Nivel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Contexto {
  /** Presente en todo lo que ocurre dentro de una petición o un job. */
  correlationId?: string;
  /** Nunca es el secreto de nadie, y hace filtrable todo lo demás. */
  tenantId?: string;
  [clave: string]: unknown;
}

export interface OpcionesDeLogger {
  nivel?: Nivel;
  contexto?: Contexto;
  /** Destino. Se inyecta en los tests para capturar la salida. */
  escribir?: (linea: string) => void;
  /** Registro de secretos. Por defecto, el global del proceso. */
  registro?: RegistroDeSecretos;
  /** Reloj. Se inyecta en los tests para que la salida sea determinista. */
  ahora?: () => Date;
}

export interface Logger {
  debug(mensaje: string, datos?: Record<string, unknown>): void;
  info(mensaje: string, datos?: Record<string, unknown>): void;
  warn(mensaje: string, datos?: Record<string, unknown>): void;
  error(mensaje: string, datos?: Record<string, unknown> | Error): void;
  /** Deriva un logger con contexto añadido. El original no se toca. */
  con(contexto: Contexto): Logger;
}

export function crearLogger(opciones: OpcionesDeLogger = {}): Logger {
  const nivelMinimo = ORDEN[opciones.nivel ?? 'info'];
  const contextoBase = opciones.contexto ?? {};
  const escribir = opciones.escribir ?? ((linea: string) => process.stdout.write(linea + '\n'));
  const ahora = opciones.ahora ?? (() => new Date());
  const registro = opciones.registro;

  function emitir(nivel: Nivel, mensaje: string, datos?: Record<string, unknown> | Error): void {
    if (ORDEN[nivel] < nivelMinimo) return;

    const cuerpo =
      datos instanceof Error ? { error: datos } : (datos ?? ({} as Record<string, unknown>));

    // El mensaje también se redacta. Es el hueco por el que se filtran las
    // cadenas de conexión: `logger.error('fallo al conectar a ' + url)`.
    const linea = {
      ts: ahora().toISOString(),
      nivel,
      mensaje,
      ...contextoBase,
      ...cuerpo,
    };

    const seguro = redactar(linea, registro);

    let serializado: string;
    try {
      serializado = JSON.stringify(seguro);
    } catch {
      // Un objeto que no se puede serializar no debe tumbar el proceso ni,
      // peor, hacer que se pierda la línea entera en silencio.
      serializado = JSON.stringify({
        ts: linea.ts,
        nivel,
        mensaje: typeof seguro === 'object' ? mensaje : String(seguro),
        _error: 'no serializable',
      });
    }

    escribir(serializado);
  }

  return {
    debug: (m, d) => emitir('debug', m, d),
    info: (m, d) => emitir('info', m, d),
    warn: (m, d) => emitir('warn', m, d),
    error: (m, d) => emitir('error', m, d),
    con: (contexto) =>
      crearLogger({
        ...opciones,
        contexto: { ...contextoBase, ...contexto },
      }),
  };
}

/** Identificador de correlación para seguir una petición por todo el sistema. */
export function nuevoCorrelationId(): string {
  return crypto.randomUUID();
}
