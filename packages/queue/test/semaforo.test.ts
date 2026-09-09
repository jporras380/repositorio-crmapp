import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { SemaforoPorInquilino, SIN_CUPO } from '../src/semaforo.js';

// Base 15 de Redis, aparte de la de desarrollo: los tests hacen FLUSHDB.
const redis = new Redis({
  host: process.env['TEST_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['TEST_REDIS_PORT'] ?? 6379),
  db: 15,
  maxRetriesPerRequest: null,
});

const A = 'inquilino-a';
const B = 'inquilino-b';

const semaforo = (limite: number, ttlMs = 5000) =>
  new SemaforoPorInquilino({ redis, limite, ttlMs, prefijo: 'test' });

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

describe('límite por inquilino', () => {
  it('concede hasta el límite y luego no', async () => {
    const s = semaforo(2);
    expect(await s.adquirir(A)).not.toBeNull();
    expect(await s.adquirir(A)).not.toBeNull();
    expect(await s.adquirir(A)).toBeNull();
  });

  it('un inquilino saturado NO afecta a otro', async () => {
    // Es la razón de existir de todo esto: la campaña masiva de un cliente no
    // puede dejar a otro sin responder.
    const s = semaforo(2);
    await s.adquirir(A);
    await s.adquirir(A);
    expect(await s.adquirir(A)).toBeNull();
    expect(await s.adquirir(B)).not.toBeNull();
  });

  it('liberar devuelve el hueco', async () => {
    const s = semaforo(1);
    const permiso = await s.adquirir(A);
    expect(await s.adquirir(A)).toBeNull();
    await permiso!.liberar();
    expect(await s.adquirir(A)).not.toBeNull();
  });

  it('liberar dos veces no devuelve dos huecos', async () => {
    // Un liberar() idempotente mal hecho crearía permisos de la nada y el
    // límite dejaría de significar nada.
    const s = semaforo(2);
    const permiso = await s.adquirir(A);
    await permiso!.liberar();
    await permiso!.liberar();
    expect(await s.enVuelo(A)).toBe(0);
    expect(await s.adquirir(A)).not.toBeNull();
    expect(await s.adquirir(A)).not.toBeNull();
    expect(await s.adquirir(A)).toBeNull();
  });
});

describe('el TTL rescata al inquilino de un worker muerto', () => {
  it('los permisos caducados se recuperan solos', async () => {
    // Sin esto, un worker que muere sin soltar su permiso deja al inquilino
    // con un hueco menos para siempre. Con suficientes caídas, ese cliente
    // queda bloqueado y nadie entiende por qué.
    const s = semaforo(1, 60);
    const permiso = await s.adquirir(A);
    expect(permiso).not.toBeNull();
    expect(await s.adquirir(A)).toBeNull();

    // El worker "muere": nunca llama a liberar().
    await new Promise((r) => setTimeout(r, 120));

    expect(await s.adquirir(A)).not.toBeNull();
  });

  it('enVuelo no cuenta los caducados', async () => {
    const s = semaforo(5, 60);
    await s.adquirir(A);
    await s.adquirir(A);
    expect(await s.enVuelo(A)).toBe(2);
    await new Promise((r) => setTimeout(r, 120));
    expect(await s.enVuelo(A)).toBe(0);
  });
});

describe('atomicidad', () => {
  it('veinte peticiones simultáneas no superan el límite', async () => {
    // La adquisición va en Lua justamente por esto: hecha en tres viajes desde
    // Node, dos workers leerían el mismo recuento y ambos se creerían con
    // permiso.
    const s = semaforo(5);
    const resultados = await Promise.all(Array.from({ length: 20 }, () => s.adquirir(A)));
    expect(resultados.filter((r) => r !== null)).toHaveLength(5);
    expect(await s.enVuelo(A)).toBe(5);
  });
});

describe('ejecutar()', () => {
  it('suelta el permiso al terminar', async () => {
    const s = semaforo(1);
    const r = await s.ejecutar(A, async () => 'hecho');
    expect(r).toBe('hecho');
    expect(await s.enVuelo(A)).toBe(0);
  });

  it('suelta el permiso aunque la función lance', async () => {
    // Sin el finally, cada error costaría capacidad al inquilino hasta que
    // caducase el TTL.
    const s = semaforo(1);
    await expect(
      s.ejecutar(A, async () => {
        throw new Error('fallo del worker');
      }),
    ).rejects.toThrow('fallo del worker');
    expect(await s.enVuelo(A)).toBe(0);
  });

  it('devuelve SIN_CUPO en lugar de esperar', async () => {
    // No bloquea: el job se reencola con retraso y el worker queda libre para
    // atender a otro inquilino. Bloquear aquí sería volver al problema.
    const s = semaforo(1);
    await s.adquirir(A);
    expect(await s.ejecutar(A, async () => 'no debería')).toBe(SIN_CUPO);
  });
});

describe('validación', () => {
  it('rechaza configuraciones sin sentido', () => {
    expect(() => semaforo(0)).toThrow(/al menos 1/);
    expect(() => semaforo(1, 0)).toThrow(/positivo/);
  });
});
