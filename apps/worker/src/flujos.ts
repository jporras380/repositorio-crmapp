/**
 * Motor de Salesbots (ADR-002).
 *
 * El estado vive en PostgreSQL —`flow_runs`— y Redis solo es el despertador.
 * Un flujo esperando tres días es una fila con `wait_until` más un delayed
 * job; si el job se pierde, el barrido lo recupera desde la tabla. Esa red de
 * seguridad es la razón por la que no hace falta un motor de workflows
 * externo: el caso que justifica Temporal —perder temporizadores en un
 * deploy— lo cubre un `SELECT` cada minuto.
 *
 * ## Lo que este archivo NO hace
 *
 * No decide qué dice el bot ni a dónde va: eso es `packages/core/flujos.ts`,
 * puro y sin I/O. Aquí solo se ejecutan los efectos que aquel describe y se
 * persiste el avance. La separación es lo que hace que el «modo prueba sin
 * envío real» sea gratis y, sobre todo, seguro: el simulador no puede enviar
 * porque no pasa por aquí.
 *
 * ## Dos veces lo mismo no envía dos veces
 *
 * BullMQ entrega al menos una vez, así que un job duplicado es normal, no una
 * anomalía. La defensa es doble: la fila se toma con `FOR UPDATE` —dos jobs
 * de la misma ejecución se serializan— y cada avance es un compare-and-swap
 * contra `current_node_id`. Si el UPDATE afecta a cero filas, otro ya avanzó y
 * este job se retira sin hacer nada.
 */
import type { Pool, PoolClient } from 'pg';
import { inicioDePeriodo, registrarUso, withTenant } from '@crmapp/db';
import {
  cabeUnoMas,
  contiene,
  decidirPaso,
  ErrorDeNegocio,
  type ContextoDelFlujo,
  type EntradaDelFlujo,
  type Efecto,
  type Grafo,
  type Nodo,
} from '@crmapp/core';
import type { ChannelAdapter } from '@crmapp/channels';
import {
  bloqueadaPorHumano,
  cargarConversacionParaEnvio,
  enviarPorConversacion,
  nuevoId,
} from '@crmapp/envio';
import type { TrabajoDeFlujo } from '@crmapp/queue';

export interface DependenciasDeFlujos {
  pool: Pool;
  canales: Map<string, Pick<ChannelAdapter, 'capacidades' | 'politicaDeVentana'>>;
  /** Programa el despertador de una espera. En tests, un espía. */
  programarDespertar: (t: { tenantId: string; flowRunId: string; enMs: number }) => Promise<void>;
  ahora?: () => Date;
}

export interface ResultadoDeFlujo {
  ejecucionesAvanzadas: number;
  ejecucionesIniciadas: number;
  ejecucionesTerminadas: number;
  ignorado?: string;
}

/**
 * Tope de pasos por invocación. El grafo ya se valida contra bucles sin espera
 * al publicarlo; esto es el cinturón por si un grafo antiguo, publicado antes
 * de una regla nueva, sigue vivo. Cortar en caliente no arregla el flujo, pero
 * evita que un bucle mande mil mensajes mientras alguien lo mira.
 */
const MAX_PASOS_POR_VUELTA = 25;

interface FilaDeEjecucion {
  id: string;
  flow_id: string;
  flow_version_id: string;
  conversation_id: string;
  status: string;
  current_node_id: string | null;
  context: ContextoDelFlujo;
  graph: Grafo;
}

export async function manejarTrabajoDeFlujo(
  deps: DependenciasDeFlujos,
  trabajo: TrabajoDeFlujo,
): Promise<ResultadoDeFlujo> {
  const evento = trabajo.evento;
  return withTenant(deps.pool, trabajo.tenantId, async (c) => {
    if (evento.tipo === 'despertar') {
      return despertar(deps, c, trabajo.tenantId, evento.flowRunId);
    }
    return alLlegarUnMensaje(deps, c, trabajo.tenantId, evento.conversationId, evento.messageId);
  });
}

// ---------------------------------------------------------------------------
// Sucesos
// ---------------------------------------------------------------------------

/**
 * Entró un mensaje del contacto. Dos caminos que se excluyen: o reanuda una
 * ejecución dormida, o dispara una nueva. Nunca las dos — si un bot está
 * esperando, lo que el contacto escribe es para él.
 */
async function alLlegarUnMensaje(
  deps: DependenciasDeFlujos,
  c: PoolClient,
  tenantId: string,
  conversationId: string,
  messageId: string,
): Promise<ResultadoDeFlujo> {
  const vacio: ResultadoDeFlujo = {
    ejecucionesAvanzadas: 0,
    ejecucionesIniciadas: 0,
    ejecucionesTerminadas: 0,
  };

  const { rows: mensajes } = await c.query<{ body: string | null; direction: string }>(
    `SELECT body, direction FROM messages WHERE id = $1`,
    [messageId],
  );
  const mensaje = mensajes[0];
  // El evento puede llegar por un saliente o por un mensaje ya purgado: ni uno
  // ni otro dispara nada.
  if (!mensaje || mensaje.direction !== 'inbound') return { ...vacio, ignorado: 'no_es_entrante' };
  const texto = mensaje.body ?? '';

  const dormida = await tomarEjecucion(c, {
    conversationId,
    estados: ['waiting'],
    esperando: 'respuesta',
  });
  if (dormida) {
    const r = await avanzar(deps, c, tenantId, dormida, { tipo: 'respuesta', texto });
    return { ...vacio, ...r };
  }

  // ¿Hay ya un bot vivo en esta conversación? Entonces no entra otro. El
  // índice único solo impide repetir el MISMO flujo; esta regla impide que
  // dos bots distintos hablen a la vez, que para el contacto es lo mismo que
  // hablar con dos personas que no se coordinan.
  const { rows: vivas } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM flow_runs
      WHERE conversation_id = $1 AND status IN ('running', 'waiting')`,
    [conversationId],
  );
  if (Number(vivas[0]?.n ?? 0) > 0) return { ...vacio, ignorado: 'ya_hay_flujo' };

  const disparado = await buscarDisparo(c, conversationId, messageId, texto);
  if (!disparado) return { ...vacio, ignorado: 'sin_disparador' };

  // La conversación la lleva una persona. Apagar el bot cuando el agente
  // escribe (`relevo.ts`) no basta: sin esto, el siguiente mensaje del
  // contacto con una palabra clave volvería a meter un bot encima del agente,
  // que es el mismo daño una hora después.
  if (await bloqueadaPorHumano(c, conversationId)) {
    return { ...vacio, ignorado: 'la_lleva_una_persona' };
  }

  // Tope de bots del plan (ADR-011). Se corta lo que consumimos nosotros, no
  // lo que le llega al cliente: la conversación entra igual y la atiende una
  // persona. Cortar entrantes sería el peor daño posible y no lo arregla
  // ningún cobro.
  if (!(await quedanBots(c, tenantId, deps.ahora ? deps.ahora() : new Date()))) {
    return { ...vacio, ignorado: 'limite_de_bots' };
  }

  const ejecucion = await crearEjecucion(c, tenantId, disparado, conversationId, texto);
  if (!ejecucion) return { ...vacio, ignorado: 'carrera_perdida' };
  const r = await avanzar(deps, c, tenantId, ejecucion, { tipo: 'entrar' });
  return { ...vacio, ...r, ejecucionesIniciadas: 1 };
}

/**
 * ¿Quedan ejecuciones de bot dentro del plan este mes?
 *
 * Se pregunta al ARRANCAR una nueva, nunca al continuar una viva: cortar un
 * bot a mitad de conversación deja al contacto esperando una respuesta que no
 * llega, y eso no lo arregla subir de plan.
 */
async function quedanBots(c: PoolClient, tenantId: string, ahora: Date): Promise<boolean> {
  const { rows } = await c.query<{ usado: string | null; tope: number | null }>(
    `SELECT (SELECT r.quantity FROM usage_rollups r
              WHERE r.tenant_id = $1 AND r.metric = 'bot.runs' AND r.period = $2) AS usado,
            (p.limits ->> 'bot_runs_mes')::int AS tope
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1`,
    [tenantId, inicioDePeriodo(ahora)],
  );
  const f = rows[0];
  // Sin suscripción no hay plan que limitar: lo que decide si puede hablar es
  // la puerta de envío, que ya falla cerrado.
  if (!f) return true;
  return cabeUnoMas(Number(f.usado ?? 0), f.tope);
}

/** Venció una espera. Si otro ya la movió, este job no tiene nada que hacer. */
export async function despertar(
  deps: DependenciasDeFlujos,
  c: PoolClient,
  tenantId: string,
  flowRunId: string,
): Promise<ResultadoDeFlujo> {
  const vacio: ResultadoDeFlujo = {
    ejecucionesAvanzadas: 0,
    ejecucionesIniciadas: 0,
    ejecucionesTerminadas: 0,
  };
  const ejecucion = await tomarEjecucion(c, { id: flowRunId, estados: ['waiting'] });
  if (!ejecucion) return { ...vacio, ignorado: 'ya_no_espera' };
  const r = await avanzar(deps, c, tenantId, ejecucion, { tipo: 'expiro' });
  return { ...vacio, ...r };
}

// ---------------------------------------------------------------------------
// El avance
// ---------------------------------------------------------------------------

async function avanzar(
  deps: DependenciasDeFlujos,
  c: PoolClient,
  tenantId: string,
  ejecucion: FilaDeEjecucion,
  primeraEntrada: EntradaDelFlujo,
): Promise<{ ejecucionesAvanzadas: number; ejecucionesTerminadas: number }> {
  const ahora = (deps.ahora ?? (() => new Date()))();
  const porId = new Map<string, Nodo>(ejecucion.graph.nodos.map((n) => [n.id, n]));
  const contexto: ContextoDelFlujo = { ...ejecucion.context };
  if (primeraEntrada.tipo === 'respuesta') contexto.ultimaRespuesta = primeraEntrada.texto;

  let nodoId: string | null = ejecucion.current_node_id ?? ejecucion.graph.inicio;
  let entrada = primeraEntrada;
  let terminadas = 0;

  for (let i = 0; i < MAX_PASOS_POR_VUELTA; i++) {
    if (nodoId === null) {
      await terminar(c, ejecucion.id, 'done', null, contexto, ahora);
      return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 1 };
    }
    const nodo = porId.get(nodoId);
    if (!nodo) {
      // El grafo cambió bajo los pies de la ejecución: no debería pasar
      // porque `flow_runs` apunta a la VERSIÓN, pero si pasa se para y se
      // deja dicho por qué, en vez de seguir a ciegas.
      await registrarPaso(
        c,
        tenantId,
        ejecucion.id,
        nodoId,
        'desconocido',
        null,
        null,
        'El paso no existe en esta versión del flujo.',
      );
      await terminar(c, ejecucion.id, 'failed', 'paso_desconocido', contexto, ahora);
      return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 1 };
    }

    const paso = decidirPaso(nodo, entrada, contexto);

    for (const efecto of paso.efectos) {
      const problema = await ejecutarEfecto(deps, c, tenantId, ejecucion, efecto);
      await registrarPaso(
        c,
        tenantId,
        ejecucion.id,
        nodo.id,
        nodo.tipo,
        { entrada: entrada.tipo, efecto: efecto.tipo },
        problema ? null : { hecho: true },
        problema,
      );
      if (problema) {
        // Un bot que no puede hablar no sigue caminando: pararía en un nodo
        // cualquiera y el log diría que todo fue bien. Se marca fallida con
        // el motivo, que es lo que después explica el soporte.
        await terminar(c, ejecucion.id, 'failed', problema, contexto, ahora);
        return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 1 };
      }
    }

    if (paso.espera) {
      const hasta = new Date(ahora.getTime() + paso.espera.segundos * 1000);
      const movida = await c.query(
        `UPDATE flow_runs
            SET status = 'waiting', wait_until = $3, wait_for = $4,
                current_node_id = $2, context = $5, updated_at = now()
          WHERE id = $1 AND status IN ('running', 'waiting')`,
        [ejecucion.id, nodo.id, hasta, paso.espera.motivo, JSON.stringify(contexto)],
      );
      if (movida.rowCount === 0) return { ejecucionesAvanzadas: 0, ejecucionesTerminadas: 0 };
      await registrarPaso(c, tenantId, ejecucion.id, nodo.id, nodo.tipo, null, {
        hasta: hasta.toISOString(),
        espera: paso.espera.motivo,
      });
      // El despertador es de Redis, pero la verdad es la fila: si este job se
      // pierde, el barrido lo recoge.
      await deps.programarDespertar({
        tenantId,
        flowRunId: ejecucion.id,
        enMs: Math.max(0, hasta.getTime() - ahora.getTime()),
      });
      return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 0 };
    }

    if (paso.siguiente === null) {
      await registrarPaso(c, tenantId, ejecucion.id, nodo.id, nodo.tipo, null, { fin: true });
      await terminar(c, ejecucion.id, 'done', null, contexto, ahora);
      return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 1 };
    }

    // Compare-and-swap (ADR-002): solo avanza quien tenga la foto correcta.
    const avanzada = await c.query(
      `UPDATE flow_runs
          SET current_node_id = $3, status = 'running', wait_until = NULL, wait_for = NULL,
              context = $4, updated_at = now()
        WHERE id = $1 AND (current_node_id IS NOT DISTINCT FROM $2)`,
      [ejecucion.id, nodoId, paso.siguiente, JSON.stringify(contexto)],
    );
    if (avanzada.rowCount === 0) {
      // Otro worker ya movió esta ejecución: retirarse es lo correcto.
      return { ejecucionesAvanzadas: 0, ejecucionesTerminadas: terminadas };
    }
    nodoId = paso.siguiente;
    entrada = { tipo: 'entrar' };
  }

  // Tope de pasos: el flujo se queda parado y marcado, no se descarta en
  // silencio. Quien lo mire verá el log y el nodo donde se quedó.
  await terminar(c, ejecucion.id, 'failed', 'limite_de_pasos', contexto, ahora);
  return { ejecucionesAvanzadas: 1, ejecucionesTerminadas: 1 };
}

/** Ejecuta un efecto. Devuelve el motivo si no se pudo, o `null` si fue bien. */
async function ejecutarEfecto(
  deps: DependenciasDeFlujos,
  c: PoolClient,
  tenantId: string,
  ejecucion: FilaDeEjecucion,
  efecto: Efecto,
): Promise<string | null> {
  switch (efecto.tipo) {
    case 'enviar_texto': {
      try {
        const conversacion = await cargarConversacionParaEnvio(c, ejecucion.conversation_id, {
          bloquear: true,
        });
        await enviarPorConversacion(
          c,
          { canales: deps.canales, ...(deps.ahora ? { ahora: deps.ahora } : {}) },
          {
            conversacion,
            peticion: { tipo: 'text', texto: efecto.texto },
            // El bot atraviesa la MISMA puerta que el agente: ventana de 24 h,
            // estado de la suscripción y capacidades del canal. Que envíe una
            // máquina no le da permisos extra.
            remitente: { tenantId, origen: 'bot', userId: null },
          },
        );
        return null;
      } catch (error) {
        if (error instanceof ErrorDeNegocio) return error.codigo;
        throw error;
      }
    }
    case 'etiquetar':
      await c.query(
        // Solo si la etiqueta sigue existiendo: la API no deja borrar la que
        // usa la versión vigente de un bot, pero una ejecución en vuelo de una
        // versión anterior podría apuntar a una ya borrada. Sin esto, la FK
        // tumbaría la ejecución entera por una etiqueta.
        `INSERT INTO conversation_tags (tenant_id, conversation_id, tag_id)
         SELECT $1, $2, t.id FROM tags t WHERE t.id = $3
         ON CONFLICT DO NOTHING`,
        [tenantId, ejecucion.conversation_id, efecto.etiquetaId],
      );
      return null;
    case 'asignar':
      await c.query(
        `UPDATE conversations SET assignee_user_id = $2, updated_at = now() WHERE id = $1`,
        [ejecucion.conversation_id, efecto.usuarioId],
      );
      return null;
    case 'cerrar_conversacion':
      await c.query(
        `UPDATE conversations
            SET status = 'closed', closed_at = now(), human_reply_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'closed'`,
        [ejecucion.conversation_id],
      );
      return null;
  }
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

/** Toma una ejecución con la fila bloqueada, junto con el grafo de SU versión. */
async function tomarEjecucion(
  c: PoolClient,
  filtro: {
    id?: string;
    conversationId?: string;
    estados: string[];
    esperando?: 'respuesta';
  },
): Promise<FilaDeEjecucion | null> {
  const condiciones = ['r.status = ANY($1)'];
  const params: unknown[] = [filtro.estados];
  if (filtro.id) {
    params.push(filtro.id);
    condiciones.push(`r.id = $${params.length}`);
  }
  if (filtro.conversationId) {
    params.push(filtro.conversationId);
    condiciones.push(`r.conversation_id = $${params.length}`);
  }
  if (filtro.esperando) {
    params.push(filtro.esperando);
    condiciones.push(`r.wait_for = $${params.length}`);
  }
  const { rows } = await c.query<FilaDeEjecucion>(
    `SELECT r.id, r.flow_id, r.flow_version_id, r.conversation_id, r.status,
            r.current_node_id, r.context, v.graph
       FROM flow_runs r
       JOIN flow_versions v ON v.id = r.flow_version_id
      WHERE ${condiciones.join(' AND ')}
      ORDER BY r.started_at
      LIMIT 1
      FOR UPDATE OF r`,
    params,
  );
  return rows[0] ?? null;
}

interface Disparo {
  flowId: string;
  flowVersionId: string;
  graph: Grafo;
}

/**
 * Primer flujo activo cuyo disparador case. Se ordena por antigüedad del
 * flujo para que el resultado sea estable: dos flujos que casan a la vez
 * tienen que elegir siempre el mismo, o el mismo mensaje daría bots distintos
 * según el humor del planificador.
 */
async function buscarDisparo(
  c: PoolClient,
  conversationId: string,
  messageId: string,
  texto: string,
): Promise<Disparo | null> {
  const { rows } = await c.query<{
    flow_id: string;
    flow_version_id: string;
    graph: Grafo;
    type: string;
    config: { palabras?: string[] };
  }>(
    `SELECT f.id AS flow_id, f.current_version_id AS flow_version_id, v.graph, t.type, t.config
       FROM flows f
       JOIN flow_triggers t ON t.flow_id = f.id AND t.enabled
       JOIN flow_versions v ON v.id = f.current_version_id
      WHERE f.status = 'activo'
      ORDER BY f.created_at, t.created_at`,
  );
  if (rows.length === 0) return null;

  let primeraDelHilo: boolean | null = null;
  for (const r of rows) {
    if (r.type === 'palabra_clave') {
      const palabras = r.config.palabras ?? [];
      if (palabras.some((p) => contiene(texto, p))) {
        return { flowId: r.flow_id, flowVersionId: r.flow_version_id, graph: r.graph };
      }
      continue;
    }
    if (r.type === 'conversacion_abierta') {
      // Se calcula una sola vez y solo si hace falta: es una consulta más.
      if (primeraDelHilo === null) {
        const { rows: previos } = await c.query<{ hay: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM messages
              WHERE conversation_id = $1 AND id <> $2
            ) AS hay`,
          [conversationId, messageId],
        );
        primeraDelHilo = !previos[0]?.hay;
      }
      if (primeraDelHilo) {
        return { flowId: r.flow_id, flowVersionId: r.flow_version_id, graph: r.graph };
      }
    }
  }
  return null;
}

async function crearEjecucion(
  c: PoolClient,
  tenantId: string,
  disparo: Disparo,
  conversationId: string,
  texto: string,
): Promise<FilaDeEjecucion | null> {
  const id = await nuevoId(c);
  const contexto: ContextoDelFlujo = { ultimaRespuesta: texto };
  const { rowCount } = await c.query(
    `INSERT INTO flow_runs (id, tenant_id, flow_id, flow_version_id, conversation_id,
                            status, current_node_id, context)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      id,
      tenantId,
      disparo.flowId,
      disparo.flowVersionId,
      conversationId,
      disparo.graph.inicio,
      JSON.stringify(contexto),
    ],
  );
  // El índice único parcial es quien decide la carrera: si otro worker metió
  // la ejecución primero, aquí no hay nada que hacer.
  if (rowCount === 0) return null;

  // Se mide al ARRANCAR y en la misma transacción que la crea (ARCH §5.9). Al
  // arrancar y no al terminar porque una ejecución que se queda esperando tres
  // días ya consumió lo que consume: el trabajo del motor y el mensaje que
  // mandó. Contarla al final dejaría el mes en curso sin datos que cobrar.
  await registrarUso(c, {
    tenantId,
    metric: 'bot.runs',
    dedupKey: `flow_run:${id}:started`,
    meta: { flowId: disparo.flowId },
  });
  return {
    id,
    flow_id: disparo.flowId,
    flow_version_id: disparo.flowVersionId,
    conversation_id: conversationId,
    status: 'running',
    current_node_id: disparo.graph.inicio,
    context: contexto,
    graph: disparo.graph,
  };
}

async function registrarPaso(
  c: PoolClient,
  tenantId: string,
  flowRunId: string,
  nodeId: string,
  kind: string,
  input: unknown,
  output: unknown,
  error: string | null = null,
): Promise<void> {
  await c.query(
    `INSERT INTO flow_run_steps (tenant_id, flow_run_id, node_id, kind, input, output, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      flowRunId,
      nodeId,
      kind,
      input === null ? null : JSON.stringify(input),
      output === null ? null : JSON.stringify(output),
      error,
    ],
  );
}

async function terminar(
  c: PoolClient,
  flowRunId: string,
  status: 'done' | 'failed',
  error: string | null,
  contexto: ContextoDelFlujo,
  ahora: Date,
): Promise<void> {
  await c.query(
    `UPDATE flow_runs
        SET status = $2, error = $3, context = $4, wait_until = NULL, wait_for = NULL,
            ended_at = $5, updated_at = now()
      WHERE id = $1`,
    [flowRunId, status, error, JSON.stringify(contexto), ahora],
  );
}
