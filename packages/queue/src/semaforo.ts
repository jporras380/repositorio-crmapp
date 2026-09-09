/**
 * Semáforo de concurrencia por inquilino (ADR-003).
 *
 * El problema: una campaña masiva de un cliente llena la cola y deja a otro
 * cliente sin responder mensajes entrantes durante veinte minutos. BullMQ
 * *open source* no tiene reparto justo entre grupos — esa es la restricción
 * que manda.
 *
 * La solución: antes de procesar, el worker pide un permiso para su inquilino.
 * Si ese inquilino ya tiene N trabajos en vuelo, el job se reencola con un
 * retraso corto en lugar de ocupar el worker. El inquilino saturado se ralentiza
 * a sí mismo; los demás no se enteran.
 *
 * ## El detalle que lo hace seguro: el TTL
 *
 * Un worker que muere sin soltar su permiso dejaría al inquilino con un hueco
 * menos, para siempre. Con suficientes caídas, ese cliente se queda bloqueado
 * y nadie entiende por qué. Por eso los permisos caducan: se guardan en un
 * ZSET con el instante de adquisición como puntuación, y cada adquisición
 * limpia primero los caducados.
 *
 * El TTL debe ser holgadamente mayor que el trabajo más largo esperado. Si se
 * queda corto, dos workers creen tener el mismo permiso y el límite deja de
 * cumplirse — degrada la equidad, no la corrección, pero conviene saberlo.
 *
 * ## Coste que hay que aceptar
 *
 * Un job de un inquilino saturado puede rebotar varias veces antes de
 * ejecutarse. Eso genera latencia extra para ese inquilino y ruido en las
 * métricas: **el reintento por saturación tiene que contarse aparte del
 * reintento por error**, o las alertas mienten (ARCH §10).
 */
// Import NOMBRADO y no por defecto: ioredis es CommonJS, y con
// module: NodeNext el import por defecto resuelve al namespace del modulo, no
// al constructor. Falla en Node real aunque vitest lo tolere.
import type { Redis } from 'ioredis';

/**
 * Adquisición atómica.
 *
 * En Lua porque limpiar caducados, contar y añadir tienen que ocurrir sin que
 * nadie se cuele en medio. Hecho en tres viajes desde Node, dos workers pueden
 * leer el mismo recuento y ambos creerse con permiso.
 */
const LUA_ADQUIRIR = `
local clave   = KEYS[1]
local ahora   = tonumber(ARGV[1])
local ttl     = tonumber(ARGV[2])
local limite  = tonumber(ARGV[3])
local permiso = ARGV[4]

-- Suelta los permisos de workers que murieron sin liberarlos.
redis.call('ZREMRANGEBYSCORE', clave, '-inf', ahora - ttl)

if redis.call('ZCARD', clave) >= limite then
  return 0
end

redis.call('ZADD', clave, ahora, permiso)
-- Caducidad de la clave entera, para que un inquilino inactivo no deje basura.
redis.call('PEXPIRE', clave, ttl * 2)
return 1
`;

export interface OpcionesDeSemaforo {
  redis: Redis;
  /** Trabajos simultáneos por inquilino. */
  limite: number;
  /**
   * Vida del permiso en milisegundos. Holgadamente mayor que el trabajo más
   * largo esperado: si se queda corto, el límite deja de cumplirse.
   */
  ttlMs: number;
  /** Prefijo de las claves; normalmente el nombre de la cola. */
  prefijo: string;
}

export interface Permiso {
  /** Suelta el permiso. Idempotente: llamarla dos veces no rompe nada. */
  liberar(): Promise<void>;
}

export class SemaforoPorInquilino {
  readonly #redis: Redis;
  readonly #limite: number;
  readonly #ttlMs: number;
  readonly #prefijo: string;

  constructor(opciones: OpcionesDeSemaforo) {
    if (opciones.limite < 1) throw new Error('El límite del semáforo debe ser al menos 1.');
    if (opciones.ttlMs < 1) throw new Error('El TTL del semáforo debe ser positivo.');
    this.#redis = opciones.redis;
    this.#limite = opciones.limite;
    this.#ttlMs = opciones.ttlMs;
    this.#prefijo = opciones.prefijo;
  }

  #clave(tenantId: string): string {
    return `sem:${this.#prefijo}:${tenantId}`;
  }

  /** Devuelve el permiso, o `null` si el inquilino ya está al límite. */
  async adquirir(tenantId: string): Promise<Permiso | null> {
    const clave = this.#clave(tenantId);
    const permiso = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const concedido = (await this.#redis.eval(
      LUA_ADQUIRIR,
      1,
      clave,
      String(Date.now()),
      String(this.#ttlMs),
      String(this.#limite),
      permiso,
    )) as number;

    if (concedido !== 1) return null;

    let liberado = false;
    return {
      liberar: async () => {
        if (liberado) return;
        liberado = true;
        await this.#redis.zrem(clave, permiso);
      },
    };
  }

  /**
   * Ejecuta `fn` con un permiso, o devuelve `SIN_CUPO` si no lo hay.
   *
   * El `finally` no es opcional: si una excepción se lleva el permiso sin
   * soltarlo, el hueco solo vuelve cuando caduca el TTL, y el inquilino paga
   * cada error con capacidad reducida durante ese tiempo.
   */
  async ejecutar<T>(tenantId: string, fn: () => Promise<T>): Promise<T | typeof SIN_CUPO> {
    const permiso = await this.adquirir(tenantId);
    if (!permiso) return SIN_CUPO;
    try {
      return await fn();
    } finally {
      await permiso.liberar();
    }
  }

  /** Permisos en vuelo, ya descontados los caducados. Para métricas y tests. */
  async enVuelo(tenantId: string): Promise<number> {
    const clave = this.#clave(tenantId);
    await this.#redis.zremrangebyscore(clave, '-inf', Date.now() - this.#ttlMs);
    return this.#redis.zcard(clave);
  }
}

/** Marca de "no había cupo". Un símbolo, para no confundirlo con un resultado. */
export const SIN_CUPO = Symbol('SIN_CUPO');
