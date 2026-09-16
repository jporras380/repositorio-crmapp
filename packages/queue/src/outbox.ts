/**
 * Relay del outbox (requisito 8.2 del ARCH).
 *
 * El problema que resuelve: entre el COMMIT de una transacción y el publish a
 * la cola hay un hueco. Si el proceso muere ahí, el cambio quedó en la base y
 * el evento no salió nunca — un mensaje guardado que jamás se envía, y nadie
 * se entera. Publicar *antes* del commit es peor: se publican eventos de
 * transacciones que luego hacen rollback.
 *
 * La solución es escribir el evento en la misma transacción que el cambio de
 * negocio, y que un proceso aparte lo publique después. Este es ese proceso.
 *
 * **Entrega al menos una vez, no exactamente una.** El relay puede publicar y
 * morir antes de marcar `published_at`, y entonces republica. Es inevitable
 * sin transacciones distribuidas, y la respuesta correcta no es perseguir el
 * "exactamente una" sino que los consumidores sean idempotentes. Igual que la
 * ingesta lo es con `message_keys` (ADR-006).
 *
 * ## Por qué sondeo y no decodificación lógica
 *
 * Leer el WAL con `pgoutput` daría latencia menor y cero carga de sondeo. Pero
 * exige `wal_level = logical`, gestionar slots de replicación —que si se
 * quedan colgados llenan el disco del primario— y un proceso que sepa
 * reanudarse desde un LSN. Con el volumen de S-3, un sondeo cada 200 ms cuesta
 * una consulta trivial sobre un índice parcial que casi siempre está vacío.
 *
 * Se reconsidera si la latencia de publicación importa de verdad o si el
 * sondeo aparece en el perfil de carga de la base.
 */
import type { Pool, PoolClient } from 'pg';

export interface EventoDeOutbox {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
}

/** Publica el evento donde corresponda. Debe lanzar si no lo consigue. */
export type Publicador = (evento: EventoDeOutbox) => Promise<void>;

export interface OpcionesDeRelay {
  /**
   * Pool con el rol del relay (`crmapp_relay`), que sí ve todos los
   * inquilinos. Con el rol de aplicación este relay no vería nada — y lo peor
   * es que no fallaría: se quedaría publicando cero eventos en silencio.
   */
  pool: Pool;
  publicar: Publicador;
  /** Eventos por vuelta. */
  lote?: number;
  /** Máximo de intentos antes de dejar de reintentar. */
  intentosMaximos?: number;
  onError?: (error: unknown, evento?: EventoDeOutbox) => void;
}

export interface ResultadoDeVuelta {
  publicados: number;
  fallidos: number;
}

interface FilaOutbox {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

function aEvento(f: FilaOutbox): EventoDeOutbox {
  return {
    id: f.id,
    tenantId: f.tenant_id,
    aggregateType: f.aggregate_type,
    aggregateId: f.aggregate_id,
    eventType: f.event_type,
    payload: f.payload,
    attempts: f.attempts,
    createdAt: f.created_at,
  };
}

/**
 * Escribe un evento en el outbox usando el cliente de una transacción en curso.
 *
 * Recibe un `PoolClient` y no un `Pool` **a propósito**: obliga a quien lo
 * llama a estar dentro de una transacción ya abierta. Si aceptara un `Pool`,
 * tomaría una conexión distinta y el evento se escribiría fuera de la
 * transacción de negocio — que es exactamente el bug que el patrón outbox
 * existe para evitar. La firma impide escribirlo mal.
 */
export async function escribirEnOutbox(
  client: PoolClient,
  evento: {
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      evento.tenantId,
      evento.aggregateType,
      evento.aggregateId,
      evento.eventType,
      JSON.stringify(evento.payload),
    ],
  );

  // Aviso en vivo para las pantallas abiertas (PR-49). `pg_notify` se entrega
  // **al confirmar** la transacción: si esta se deshace, nadie recibe nada.
  //
  // Va aquí y no en el relay porque esto es una notificación, no una entrega:
  // quien no esté escuchando en ese instante se la pierde, y da igual — la
  // pantalla se recarga sola de todas formas. El trabajo de verdad lo sigue
  // garantizando el outbox.
  //
  // La carga se recorta a ids: el límite de `NOTIFY` son 8000 bytes y un
  // payload grande tumbaría el INSERT, que sí importa.
  await client.query(`SELECT pg_notify('crmapp_eventos', $1)`, [
    JSON.stringify({
      t: evento.tenantId,
      e: evento.eventType,
      a: evento.aggregateId,
      c: conversacionDe(evento.payload),
    }),
  ]);
}

/** Id de conversación dentro de la carga, si lo lleva. Evita recargar de más. */
function conversacionDe(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const c = (payload as Record<string, unknown>)['conversationId'];
  return typeof c === 'string' ? c : null;
}

/**
 * Procesa una vuelta del relay.
 *
 * `FOR UPDATE SKIP LOCKED` es lo que permite tener varias instancias del relay
 * a la vez: cada una toma un lote distinto en lugar de bloquearse esperando a
 * la otra. Sin `SKIP LOCKED`, dos relays se serializan y la segunda instancia
 * no aporta nada.
 *
 * La publicación ocurre DENTRO de la transacción que sostiene el bloqueo. Es
 * más lento que soltar el bloqueo primero, pero evita que dos relays publiquen
 * el mismo evento cuando uno va lento.
 */
export async function procesarVuelta(opciones: OpcionesDeRelay): Promise<ResultadoDeVuelta> {
  const lote = opciones.lote ?? 50;
  const intentosMaximos = opciones.intentosMaximos ?? 10;
  const onError = opciones.onError ?? (() => {});

  const client = await opciones.pool.connect();
  let publicados = 0;
  let fallidos = 0;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<FilaOutbox>(
      `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type,
              payload, attempts, created_at
         FROM outbox
        WHERE published_at IS NULL
          AND attempts < $2
        ORDER BY created_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [lote, intentosMaximos],
    );

    for (const fila of rows) {
      const evento = aEvento(fila);
      try {
        await opciones.publicar(evento);
        await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [fila.id]);
        publicados += 1;
      } catch (error) {
        // El fallo de un evento no debe tumbar el lote entero: el siguiente
        // puede ir a otra cola que sí funciona.
        await client.query(
          `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
          [fila.id, (error as Error).message?.slice(0, 1000) ?? 'desconocido'],
        );
        fallidos += 1;
        onError(error, evento);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    onError(error);
    throw error;
  } finally {
    client.release();
  }

  return { publicados, fallidos };
}

export interface OpcionesDeBucle extends OpcionesDeRelay {
  /** Espera entre vueltas cuando no había nada que publicar. */
  intervaloMs?: number;
}

/**
 * Bucle del relay. Devuelve una función para pararlo.
 *
 * Cuando una vuelta publica un lote completo, encadena la siguiente sin
 * esperar: si hay acumulación, sondear cada 200 ms tardaría minutos en
 * drenarla.
 */
export function arrancarRelay(opciones: OpcionesDeBucle): () => Promise<void> {
  const intervalo = opciones.intervaloMs ?? 200;
  const lote = opciones.lote ?? 50;
  let parando = false;
  let enCurso: Promise<void> = Promise.resolve();

  const bucle = async (): Promise<void> => {
    while (!parando) {
      let resultado: ResultadoDeVuelta;
      try {
        resultado = await procesarVuelta(opciones);
      } catch {
        // procesarVuelta ya avisó por onError. Esperar antes de reintentar
        // evita machacar una base que está caída.
        await esperar(intervalo);
        continue;
      }

      const huboTrabajo = resultado.publicados + resultado.fallidos >= lote;
      if (!huboTrabajo) await esperar(intervalo);
    }
  };

  enCurso = bucle();

  return async () => {
    parando = true;
    await enCurso;
  };
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
