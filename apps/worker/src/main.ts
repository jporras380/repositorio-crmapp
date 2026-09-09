/**
 * Proceso worker (ARCH §4): relay del outbox + consumidores de BullMQ.
 *
 * Separado de la API a propósito: un pico de ingesta no puede degradar la
 * latencia del WebSocket de la bandeja. Coste: dos despliegues.
 */
import { Pool } from 'pg';
import { DelayedError, Queue, Worker } from 'bullmq';
import { cargarConfig, configParaLog } from '@crmapp/config';
import { crearLogger } from '@crmapp/observability';
import {
  AdaptadorSandbox,
  AdaptadorWhatsapp,
  IngestaSandbox,
  IngestaWhatsapp,
  type ChannelAdapter,
} from '@crmapp/channels';
import { Cifrador, parsearClaveMaestra } from '@crmapp/crypto';
import { crearResolverDeCredencialesWhatsapp } from '@crmapp/db';
import {
  COLAS,
  OPCIONES_POR_DEFECTO,
  SemaforoPorInquilino,
  SIN_CUPO,
  arrancarRelay,
  type TrabajoDeEnvio,
  type TrabajoDeIngesta,
} from '@crmapp/queue';
import { Redis } from 'ioredis';
import { marcarFallo, procesarEventoEntrante } from './procesar-entrante.js';
import { enviarMensajeSaliente, type CargaDeEnvio } from './enviar-saliente.js';

const config = cargarConfig();
const log = crearLogger({ nivel: config.LOG_LEVEL, contexto: { proceso: 'worker' } });

const pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
// El relay necesita ver TODOS los inquilinos: rol crmapp_relay (migración 0006).
const poolRelay = new Pool({
  connectionString: config.DATABASE_RELAY_URL ?? config.DATABASE_URL,
  max: 2,
});

const conexion = { url: config.REDIS_URL };
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// Credenciales de canal: se leen con el rol de solo lectura y se descifran
// con la clave maestra. Sin DATABASE_AUTH_URL el pool de aplicacion no las
// veria (RLS) y el envio fallaria con "cuenta no existe".
const poolAuth = new Pool({
  connectionString: config.DATABASE_AUTH_URL ?? config.DATABASE_URL,
  max: 2,
});
const cifrador = new Cifrador({
  versionActual: config.MASTER_ENCRYPTION_KEY_VERSION,
  claves: {
    [config.MASTER_ENCRYPTION_KEY_VERSION]: parsearClaveMaestra(config.MASTER_ENCRYPTION_KEY),
  },
});

const ingesta = new Map([
  ['whatsapp', new IngestaWhatsapp()],
  ['instagram', new IngestaSandbox('instagram')],
]);
const canales = new Map<string, ChannelAdapter>([
  [
    'whatsapp',
    new AdaptadorWhatsapp({
      resolverCredenciales: crearResolverDeCredencialesWhatsapp(poolAuth, cifrador),
    }),
  ],
  ['instagram', new AdaptadorSandbox({ canal: 'instagram' })],
]);

const colaIngesta = new Queue(COLAS.ingestaEntrante, {
  connection: conexion,
  defaultJobOptions: OPCIONES_POR_DEFECTO,
});
// Una cola de salida por canal: sus límites de tasa son distintos (ARCH §10).
const colasDeSalida: Record<string, Queue> = {
  whatsapp: new Queue(COLAS.salidaWhatsapp, {
    connection: conexion,
    defaultJobOptions: OPCIONES_POR_DEFECTO,
  }),
  instagram: new Queue(COLAS.salidaInstagram, {
    connection: conexion,
    defaultJobOptions: OPCIONES_POR_DEFECTO,
  }),
};

// --- Relay: outbox → BullMQ ------------------------------------------------
const pararRelay = arrancarRelay({
  pool: poolRelay,
  publicar: async (evento) => {
    if (evento.eventType === 'webhook.recibido') {
      const trabajo: TrabajoDeIngesta = {
        tenantId: evento.tenantId,
        correlationId: evento.id,
        inboundEventId: evento.aggregateId,
        inboundEventCreatedAt: evento.createdAt.toISOString(),
      };
      // jobId = id del evento del outbox: si el relay republica (entrega al
      // menos una vez), BullMQ descarta el duplicado en vez de procesarlo dos
      // veces.
      await colaIngesta.add('webhook', trabajo, { jobId: `outbox-${evento.id}` });
    }
    if (evento.eventType === 'mensaje.enviar') {
      const carga = evento.payload as CargaDeEnvio;
      const cola = colasDeSalida[carga.canal];
      if (!cola) throw new Error(`Sin cola de salida para el canal "${carga.canal}".`);
      const trabajo: TrabajoDeEnvio = {
        tenantId: evento.tenantId,
        correlationId: evento.id,
        messageId: carga.messageId,
        carga,
      };
      await cola.add('enviar', trabajo, { jobId: `outbox-${evento.id}` });
    }
    // Otros tipos de evento se enrutarán aquí a medida que existan consumidores.
  },
  onError: (error, evento) => log.error('relay del outbox', { error, evento }),
});

// --- Consumidor de ingesta con semáforo por inquilino (ADR-003) ------------
const semaforo = new SemaforoPorInquilino({
  redis,
  limite: 4,
  ttlMs: 60_000,
  prefijo: COLAS.ingestaEntrante,
});

const worker = new Worker<TrabajoDeIngesta>(
  COLAS.ingestaEntrante,
  async (job) => {
    const { tenantId, inboundEventId } = job.data;
    const resultado = await semaforo.ejecutar(tenantId, async () => {
      try {
        return await procesarEventoEntrante({ pool, ingesta, canales }, tenantId, inboundEventId);
      } catch (error) {
        await marcarFallo(pool, tenantId, inboundEventId, error);
        throw error;
      }
    });

    if (resultado === SIN_CUPO) {
      // Reencolar con retraso corto, sin contarlo como fallo: el reintento por
      // saturación se mide aparte del reintento por error (ARCH §10).
      await job.moveToDelayed(Date.now() + 500, job.token);
      throw new DelayedError();
    }

    log.info('webhook procesado', { tenantId, inboundEventId, ...resultado });
  },
  { connection: conexion, concurrency: 8 },
);

// --- Consumidores de salida, uno por canal --------------------------------
const workersDeSalida = Object.entries(colasDeSalida).map(
  ([canal, cola]) =>
    new Worker<TrabajoDeEnvio>(
      cola.name,
      async (job) => {
        const { tenantId, carga } = job.data;
        const r = await semaforo.ejecutar(tenantId, () =>
          enviarMensajeSaliente({ pool, canales }, tenantId, carga as CargaDeEnvio),
        );
        if (r === SIN_CUPO) {
          await job.moveToDelayed(Date.now() + 500, job.token);
          throw new DelayedError();
        }
        log.info('mensaje saliente', {
          canal,
          tenantId,
          messageId: job.data.messageId,
          resultado: r,
        });
      },
      { connection: conexion, concurrency: 4 },
    ),
);
for (const w of workersDeSalida) {
  w.on('failed', (job, error) => log.error('envío fallido', { jobId: job?.id, error }));
}

worker.on('failed', (job, error) =>
  log.error('job fallido', { jobId: job?.id, tenantId: job?.data.tenantId, error }),
);

log.info('worker arrancado', { config: configParaLog(config) });

const apagar = async () => {
  log.info('apagando worker');
  await pararRelay();
  await worker.close();
  await Promise.all(workersDeSalida.map((w) => w.close()));
  await colaIngesta.close();
  await Promise.all(Object.values(colasDeSalida).map((q) => q.close()));
  await redis.quit();
  await pool.end();
  await poolRelay.end();
  await poolAuth.end();
  process.exit(0);
};
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
