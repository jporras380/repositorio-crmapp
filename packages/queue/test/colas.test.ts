/**
 * Verifica el cableado de BullMQ.
 *
 * Existe sobre todo por una razon concreta: `msgpackr-extract` esta DENEGADO
 * en pnpm-workspace.yaml. Es el acelerador nativo que BullMQ usa para
 * serializar, y msgpackr cae de vuelta a JavaScript sin el. Este test
 * comprueba que esa caida funciona y que un trabajo sobrevive al viaje de ida
 * y vuelta por Redis con su forma intacta.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { COLAS, OPCIONES_POR_DEFECTO, crearCola, type TrabajoDeCorreo } from '../src/colas.js';

const connection = {
  host: process.env['TEST_REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['TEST_REDIS_PORT'] ?? 6379),
  db: 14,
};

let cola: Queue;

beforeEach(async () => {
  cola = crearCola(COLAS.correo, connection);
  await cola.obliterate({ force: true });
});

afterAll(async () => {
  await cola?.obliterate({ force: true });
  await cola?.close();
});

describe('cableado de BullMQ', () => {
  it('un trabajo va y vuelve con su forma intacta', async () => {
    const trabajo: TrabajoDeCorreo = {
      tenantId: '00000000-0000-7000-8000-000000000001',
      correlationId: 'corr-1',
      tipo: 'invitacion',
      para: 'ana@ejemplo.com',
      datos: { nombre: 'Ana', acentos: 'ñáéíóú', anidado: { n: 1 } },
    };

    const encolado = await cola.add('invitacion', trabajo);
    const leido = await cola.getJob(encolado.id!);

    expect(leido?.data).toEqual(trabajo);
  });

  it('aplica las opciones por defecto', async () => {
    // Backoff exponencial y reintentos acotados vienen de la definicion, no de
    // que cada quien se acuerde de ponerlos al encolar.
    const encolado = await cola.add('invitacion', {
      tenantId: '00000000-0000-7000-8000-000000000001',
      correlationId: 'c',
      tipo: 'invitacion',
      para: 'a@b.c',
      datos: {},
    } satisfies TrabajoDeCorreo);

    expect(encolado.opts.attempts).toBe(OPCIONES_POR_DEFECTO.attempts);
    expect(encolado.opts.backoff).toEqual(OPCIONES_POR_DEFECTO.backoff);
  });
});
