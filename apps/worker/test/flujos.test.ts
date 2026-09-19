/**
 * Motor de Salesbots contra PostgreSQL real.
 *
 * Esto prueba el criterio de salida de la fase 3 —«un flujo real califica un
 * lead sin humano y sobrevive a un deploy»— y las dos cosas que costarían
 * dinero si fallaran: que un job duplicado no envíe dos veces, y que el bot no
 * escriba con la ventana de 24 h cerrada.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { inicioDePeriodo, migrar, withTenant } from '@crmapp/db';
import { AdaptadorSandbox, type ChannelAdapter } from '@crmapp/channels';
import type { Grafo } from '@crmapp/core';
import { cargarConversacionParaEnvio, enviarPorConversacion } from '@crmapp/envio';
import { manejarTrabajoDeFlujo } from '../src/flujos.js';
import { esperasVencidas } from '../src/mantenimiento.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_flujos';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let admin: Pool;
let app: Pool;
let relay: Pool;
let tenantId: string;
let channelAccountId: string;
let conversationId: string;
let usuarioId: string;
let etiquetaId: string;
const canales = new Map<string, ChannelAdapter>([['whatsapp', new AdaptadorSandbox()]]);
const programarDespertar = vi.fn(async () => undefined);

const deps = (ahora?: () => Date) => ({
  pool: app,
  canales,
  programarDespertar,
  ...(ahora ? { ahora } : {}),
});

/** El flujo de calificación: saluda, pregunta, ramifica, etiqueta y asigna. */
const CALIFICAR = (): Grafo => ({
  inicio: 'saludo',
  nodos: [
    { id: 'saludo', tipo: 'mensaje', texto: '¿Buscas repuestos?', siguiente: 'espera' },
    {
      id: 'espera',
      tipo: 'esperar_respuesta',
      segundos: 3600,
      siguiente: 'ramas',
      alExpirar: 'frio',
    },
    {
      id: 'ramas',
      tipo: 'condicion',
      casos: [{ contiene: ['sí', 'si'], siguiente: 'etiqueta' }],
      siNo: 'fin',
    },
    { id: 'etiqueta', tipo: 'etiquetar', etiquetaId: '', siguiente: 'asignar' },
    { id: 'asignar', tipo: 'asignar', usuarioId: '', siguiente: 'gracias' },
    { id: 'gracias', tipo: 'mensaje', texto: 'Te paso con un asesor.', siguiente: 'fin' },
    { id: 'frio', tipo: 'mensaje', texto: 'Quedo atento si necesitas algo.', siguiente: 'fin' },
    { id: 'fin', tipo: 'fin' },
  ],
});

/** Un bot que saluda, calla cuatro segundos y vuelve a hablar. */
const CON_PAUSA = (): Grafo => ({
  inicio: 'saludo',
  nodos: [
    { id: 'saludo', tipo: 'mensaje', texto: 'Hola', siguiente: 'respira' },
    { id: 'respira', tipo: 'pausa', segundos: 4, siguiente: 'segundo' },
    { id: 'segundo', tipo: 'mensaje', texto: '¿En qué te ayudamos?', siguiente: 'fin' },
    { id: 'fin', tipo: 'fin' },
  ],
});

/** Un agente responde de verdad: por la misma puerta que usa la bandeja. */
async function respondeUnAgente(texto: string): Promise<void> {
  await withTenant(app, tenantId, async (c) => {
    const conversacion = await cargarConversacionParaEnvio(c, conversationId, { bloquear: true });
    await enviarPorConversacion(
      c,
      { canales },
      {
        conversacion,
        peticion: { tipo: 'text', texto },
        remitente: { tenantId, origen: 'human', userId: usuarioId },
      },
    );
  });
}

async function crearFlujo(
  grafo: Grafo,
  disparador: 'conversacion_abierta' | 'palabra_clave',
  horasActivas: 'siempre' | 'solo_abierto' | 'solo_cerrado' = 'siempre',
) {
  const flowId = (
    await admin.query<{ id: string }>(
      `INSERT INTO flows (tenant_id, name, status, active_hours)
       VALUES ($1, $2, 'activo', $3) RETURNING id`,
      [tenantId, `flujo-${Math.random().toString(36).slice(2, 8)}`, horasActivas],
    )
  ).rows[0]!.id;
  const versionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO flow_versions (tenant_id, flow_id, version, graph) VALUES ($1,$2,1,$3) RETURNING id`,
      [tenantId, flowId, JSON.stringify(grafo)],
    )
  ).rows[0]!.id;
  await admin.query(`UPDATE flows SET current_version_id = $2 WHERE id = $1`, [flowId, versionId]);
  await admin.query(
    `INSERT INTO flow_triggers (tenant_id, flow_id, type, config)
     VALUES ($1, $2, $3, $4)`,
    [
      tenantId,
      flowId,
      disparador,
      JSON.stringify(disparador === 'palabra_clave' ? { palabras: ['precio'] } : {}),
    ],
  );
  return flowId;
}

/** Un entrante ya persistido, como lo dejaría `procesar-entrante`. */
async function entrante(texto: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status)
     VALUES ($1,$2,$3,'inbound','text',$4,'delivered') RETURNING id`,
    [tenantId, conversationId, channelAccountId, texto],
  );
  await admin.query(
    `UPDATE conversations SET last_inbound_at = now(), session_expires_at = now() + interval '24 hours' WHERE id = $1`,
    [conversationId],
  );
  return rows[0]!.id;
}

const salientes = async () =>
  (
    await admin.query<{ body: string; sent_by: string }>(
      `SELECT body, sent_by FROM messages WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY created_at`,
      [conversationId],
    )
  ).rows;

const ejecucion = async () =>
  (
    await admin.query<{
      id: string;
      status: string;
      current_node_id: string | null;
      wait_until: Date | null;
      error: string | null;
    }>(`SELECT id, status, current_node_id, wait_until, error FROM flow_runs ORDER BY started_at`)
  ).rows;

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();
  await migrar(url(DB));

  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  for (const rol of ['crmapp_app', 'crmapp_relay']) {
    // Los roles son del CLÚSTER, no de la base: dos archivos de test que
    // corren a la vez pueden chocar en el mismo `ALTER ROLE` y PostgreSQL
    // responde «tuple concurrently updated». Es una carrera del banco de
    // pruebas, no del producto, y se resuelve reintentando.
    for (let intento = 0; ; intento++) {
      try {
        await conf.query(`ALTER ROLE ${rol} LOGIN PASSWORD 'crmapp_dev'`);
        break;
      } catch (error) {
        if (intento >= 4) throw error;
        await new Promise((ok) => setTimeout(ok, 150 * (intento + 1)));
      }
    }
    await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO ${rol}`);
  }
  tenantId = (
    await conf.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Bots','bots') RETURNING id`,
    )
  ).rows[0]!.id;
  // Sin suscripción viva, la puerta de envío rechaza todo: core falla cerrado.
  await conf.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at)
     VALUES ($1, (SELECT id FROM plans WHERE code = 'growth'), 'trialing', now() + interval '20 days')`,
    [tenantId],
  );
  usuarioId = (
    await conf.query<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash) VALUES ('bot@test.test','Asesor','x') RETURNING id`,
    )
  ).rows[0]!.id;
  etiquetaId = (
    await conf.query<{ id: string }>(
      `INSERT INTO tags (tenant_id, name, color) VALUES ($1,'Lead','#ff9500') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  channelAccountId = (
    await conf.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name, status)
       VALUES ($1,'whatsapp','pn-flujos','WA','connected') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const contacto = (
    await conf.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,'Ana') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const identidad = (
    await conf.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1,$2,'whatsapp',$3,'wa-ana') RETURNING id`,
      [tenantId, contacto, channelAccountId],
    )
  ).rows[0]!.id;
  conversationId = (
    await conf.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, session_expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '24 hours') RETURNING id`,
      [tenantId, identidad, contacto, channelAccountId],
    )
  ).rows[0]!.id;
  await conf.end();

  admin = new Pool({ connectionString: url(DB) });
  app = new Pool({ connectionString: url(DB, 'crmapp_app', 'crmapp_dev') });
  relay = new Pool({ connectionString: url(DB, 'crmapp_relay', 'crmapp_dev') });
});

afterEach(async () => {
  programarDespertar.mockClear();
  await admin.query(`DELETE FROM usage_rollups`);
  await admin.query(`DELETE FROM usage_event_keys`);
  await admin.query(`DELETE FROM usage_events`);
  await admin.query(`DELETE FROM flow_run_steps`);
  await admin.query(`DELETE FROM flow_runs`);
  await admin.query(`DELETE FROM flow_triggers`);
  await admin.query(`DELETE FROM flow_versions`);
  await admin.query(`DELETE FROM flows`);
  await admin.query(`DELETE FROM messages`);
  await admin.query(`DELETE FROM conversation_tags`);
  await admin.query(
    `UPDATE conversations SET assignee_user_id = NULL, status = 'open', human_reply_at = NULL,
            session_expires_at = now() + interval '24 hours' WHERE id = $1`,
    [conversationId],
  );
});

afterAll(async () => {
  await app?.end();
  await relay?.end();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

describe('criterio de salida de la fase 3', () => {
  it('califica un lead sin humano: saluda, espera, ramifica, etiqueta y asigna', async () => {
    const grafo = CALIFICAR();
    (grafo.nodos.find((n) => n.id === 'etiqueta') as { etiquetaId: string }).etiquetaId =
      etiquetaId;
    (grafo.nodos.find((n) => n.id === 'asignar') as { usuarioId: string }).usuarioId = usuarioId;
    await crearFlujo(grafo, 'conversacion_abierta');

    const primero = await entrante('Hola');
    const r1 = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: primero },
    });
    expect(r1.ejecucionesIniciadas).toBe(1);
    expect((await salientes()).map((m) => m.body)).toEqual(['¿Buscas repuestos?']);
    // Quien envía es el bot, y queda dicho en la fila: es lo que responde a
    // «¿esto lo escribió una persona?».
    expect((await salientes())[0]!.sent_by).toBe('bot');

    const [enEspera] = await ejecucion();
    expect(enEspera).toMatchObject({ status: 'waiting', current_node_id: 'espera' });
    expect(programarDespertar).toHaveBeenCalledOnce();

    const segundo = await entrante('Sí, necesito filtros');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c2',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: segundo },
    });

    expect((await salientes()).map((m) => m.body)).toEqual([
      '¿Buscas repuestos?',
      'Te paso con un asesor.',
    ]);
    const { rows: etiquetas } = await admin.query(
      `SELECT 1 FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2`,
      [conversationId, etiquetaId],
    );
    expect(etiquetas).toHaveLength(1);
    const { rows: conv } = await admin.query<{ assignee_user_id: string | null }>(
      `SELECT assignee_user_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(conv[0]!.assignee_user_id).toBe(usuarioId);
    expect((await ejecucion())[0]).toMatchObject({ status: 'done' });

    // El log paso a paso: la respuesta a «¿por qué el bot dijo eso?».
    const { rows: pasos } = await admin.query<{ node_id: string }>(
      `SELECT node_id FROM flow_run_steps ORDER BY at`,
    );
    expect(pasos.map((p) => p.node_id)).toEqual([
      'saludo',
      'espera',
      'etiqueta',
      'asignar',
      'gracias',
      'fin',
    ]);
  });

  it('mide la ejecución al arrancarla, no al terminarla', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: await entrante('Hola') },
    });

    // Queda ESPERANDO —no ha terminado— y el consumo ya está contado: lo que
    // gasta un bot es el trabajo del motor y el mensaje que mandó, no su final.
    expect((await ejecucion())[0]).toMatchObject({ status: 'waiting' });
    const { rows } = await admin.query<{ metric: string; quantity: string }>(
      `SELECT metric, quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = 'bot.runs'`,
      [tenantId],
    );
    expect(rows[0]).toMatchObject({ quantity: '1' });
  });

  it('sobrevive a un deploy: el barrido rescata la espera cuyo temporizador se perdió', async () => {
    const grafo = CALIFICAR();
    (grafo.nodos.find((n) => n.id === 'etiqueta') as { etiquetaId: string }).etiquetaId =
      etiquetaId;
    (grafo.nodos.find((n) => n.id === 'asignar') as { usuarioId: string }).usuarioId = usuarioId;
    await crearFlujo(grafo, 'conversacion_abierta');
    const primero = await entrante('Hola');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: primero },
    });

    // Se pierde Redis con el delayed job dentro y además vence el plazo.
    await admin.query(`UPDATE flow_runs SET wait_until = now() - interval '1 minute'`);

    // El barrido lo encuentra leyendo la base con el rol del relay, que solo
    // puede ver cuatro columnas de `flow_runs`.
    const vencidas = await esperasVencidas(relay, 10);
    expect(vencidas).toHaveLength(1);
    expect(vencidas[0]!.tenantId).toBe(tenantId);

    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'rescate',
      evento: { tipo: 'despertar', flowRunId: vencidas[0]!.id },
    });

    // El silencio tiene su propio camino: ni etiqueta ni asigna.
    expect((await salientes()).map((m) => m.body)).toEqual([
      '¿Buscas repuestos?',
      'Quedo atento si necesitas algo.',
    ]);
    const { rows: etiquetas } = await admin.query(`SELECT 1 FROM conversation_tags`);
    expect(etiquetas).toHaveLength(0);
    expect((await ejecucion())[0]).toMatchObject({ status: 'done' });
  });
});

describe('los bots respetan el horario del hotel (0030)', () => {
  const HORARIO = { '1': [['09:00', '18:00']], '2': [['09:00', '18:00']] };
  /** Martes 11:00 y 23:00 en Lima (UTC−5). */
  const abierto = () => new Date('2026-09-15T16:00:00Z');
  const cerrado = () => new Date('2026-09-16T04:00:00Z');

  const conHorario = async (tz = 'America/Lima') => {
    await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
    await admin.query(
      `INSERT INTO business_hours (tenant_id, timezone, schedule) VALUES ($1, $2, $3)`,
      [tenantId, tz, JSON.stringify(HORARIO)],
    );
  };

  afterEach(async () => {
    await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
  });

  /**
   * Dispara por palabra clave, no por «primer mensaje de la conversación»:
   * así se puede probar la misma conversación a dos horas distintas dentro de
   * un mismo test sin que el disparador se agote en el primer intento.
   */
  const dispara = async (cuando: () => Date, correlationId: string) => {
    const id = await entrante('quiero el precio');
    return manejarTrabajoDeFlujo(deps(cuando), {
      tenantId,
      correlationId,
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
  };

  it('un bot «solo en horario» calla de madrugada y arranca por la mañana', async () => {
    await conHorario();
    await crearFlujo(CALIFICAR(), 'palabra_clave', 'solo_abierto');

    const deNoche = await dispara(cerrado, 'h-noche');
    expect(deNoche.ignorado).toBe('sin_disparador');
    expect(deNoche.ejecucionesIniciadas).toBe(0);

    const deDia = await dispara(abierto, 'h-dia');
    expect(deDia.ejecucionesIniciadas).toBe(1);
  });

  it('un bot «solo fuera de horario» hace justo lo contrario', async () => {
    await conHorario();
    await crearFlujo(CALIFICAR(), 'palabra_clave', 'solo_cerrado');

    expect((await dispara(abierto, 'c-dia')).ignorado).toBe('sin_disparador');
    expect((await dispara(cerrado, 'c-noche')).ejecucionesIniciadas).toBe(1);
  });

  it('sin horario puesto, el bot habla igual: callar en silencio sería peor', async () => {
    // No hay fila en `business_hours`: no se puede saber si está abierto, y un
    // bot que calla sin dejar rastro es un cliente sin contestar y sin error.
    await crearFlujo(CALIFICAR(), 'palabra_clave', 'solo_abierto');
    expect((await dispara(cerrado, 'sin-horario')).ejecucionesIniciadas).toBe(1);
  });

  it('con una zona horaria que no se entiende, también habla', async () => {
    await conHorario('Marte/Olympus');
    await crearFlujo(CALIFICAR(), 'palabra_clave', 'solo_abierto');
    expect((await dispara(cerrado, 'tz-rara')).ejecucionesIniciadas).toBe(1);
  });
});

describe('cuando el bot se rinde y pide una persona', () => {
  /** Saluda y se rinde: es el caso real del bot que no sabe seguir. */
  const PIDE_AYUDA: Grafo = {
    inicio: 'saludo',
    nodos: [
      { id: 'saludo', tipo: 'mensaje', texto: 'Hola, soy el asistente.', siguiente: 'ayuda' },
      { id: 'ayuda', tipo: 'relevo', motivo: 'pregunta por un grupo de 20 personas' },
    ],
  };

  const relevoDeLaConversacion = async () =>
    (
      await admin.query<{ handoff_reason: string | null; handoff_at: Date | null }>(
        `SELECT handoff_reason, handoff_at FROM conversations WHERE id = $1`,
        [conversationId],
      )
    ).rows[0]!;

  it('deja escrito el motivo en la conversación, y contestar lo borra', async () => {
    await crearFlujo(PIDE_AYUDA, 'conversacion_abierta');
    const id = await entrante('Hola');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'r1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });

    // El aviso está puesto y la ejecución terminó: el relevo no deja cola.
    const pedida = await relevoDeLaConversacion();
    expect(pedida.handoff_reason).toBe('pregunta por un grupo de 20 personas');
    expect(pedida.handoff_at).not.toBeNull();
    expect((await ejecucion())[0]!.status).toBe('done');

    // Y se apaga solo al atenderlo. Sin esto haría falta un botón «visto» que
    // nadie pulsa, y la bandeja acabaría llena de avisos viejos.
    await respondeUnAgente('Claro, para 20 personas te preparo presupuesto.');
    const atendida = await relevoDeLaConversacion();
    expect(atendida.handoff_reason).toBeNull();
    expect(atendida.handoff_at).toBeNull();
  });
});

describe('el bot se aparta cuando entra una persona', () => {
  it('un agente responde y el bot dormido se apaga, con el motivo escrito', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    const id = await entrante('Hola');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'h1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
    const dormida = (await ejecucion())[0]!;
    expect(dormida.status).toBe('waiting');

    await respondeUnAgente('Ya sigo yo, Ana. Soy Marta.');

    const tras = (await ejecucion())[0]!;
    expect(tras.status).toBe('cancelled');
    expect(tras.error).toBe('humano_tomo_el_control');
    // Y queda dicho en la auditoría del flujo, que es donde se mira cuando
    // alguien pregunta por qué el bot dejó de hablar.
    const { rows: pasos } = await admin.query<{ kind: string }>(
      `SELECT kind FROM flow_run_steps WHERE flow_run_id = $1 ORDER BY at`,
      [dormida.id],
    );
    expect(pasos.at(-1)!.kind).toBe('relevo');

    // El despertador de Redis sigue programado y sonará igual: no debe hacer nada.
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'h2',
      evento: { tipo: 'despertar', flowRunId: dormida.id },
    });
    expect(r.ignorado).toBe('ya_no_espera');
    expect((await salientes()).map((m) => m.sent_by)).toEqual(['bot', 'human']);
  });

  it('después de que responda un agente, una palabra clave no vuelve a meter un bot', async () => {
    await crearFlujo(CALIFICAR(), 'palabra_clave');
    await respondeUnAgente('Hola, soy Marta. ¿Qué necesitas?');

    const id = await entrante('quiero el precio');
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'h3',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
    expect(r.ignorado).toBe('la_lleva_una_persona');
    expect(await ejecucion()).toHaveLength(0);
  });

  it('cerrar la conversación devuelve el turno a los bots', async () => {
    await crearFlujo(CALIFICAR(), 'palabra_clave');
    await respondeUnAgente('Resuelto, cierro.');
    // Cerrar es lo que hace la bandeja al terminar: borra la marca.
    await admin.query(
      `UPDATE conversations SET status = 'closed', closed_at = now(), human_reply_at = NULL
        WHERE id = $1`,
      [conversationId],
    );
    // Y el entrante siguiente la reabre, como hace la ingesta.
    const id = await entrante('precio');
    await admin.query(`UPDATE conversations SET status = 'open' WHERE id = $1`, [conversationId]);

    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'h4',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
    expect(r.ejecucionesIniciadas).toBe(1);
  });

  /*
   * «Poner en espera» (0036) contra «marcar resuelto».
   *
   * Los dos sacan la conversación de pendientes. La diferencia entera está
   * aquí: en espera el bot NO vuelve a hablarle aunque nadie del equipo haya
   * contestado nunca; cerrada, sí. Sin esta distinción, la única forma de
   * quitarse de encima un cliente difícil era cerrarle, y el bot le saludaba
   * al siguiente mensaje.
   */
  it('en espera el bot se calla, aunque NADIE haya respondido nunca', async () => {
    await crearFlujo(CALIFICAR(), 'palabra_clave');
    // Ni `respondeUnAgente` ni nada: la conversación está virgen.
    await admin.query(`UPDATE conversations SET on_hold_at = now() WHERE id = $1`, [
      conversationId,
    ]);

    const id = await entrante('quiero el precio');
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'e1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
    expect(r.ignorado).toBe('la_lleva_una_persona');
    expect(await ejecucion()).toHaveLength(0);
  });

  it('cerrar levanta la espera y el bot vuelve a atender', async () => {
    await crearFlujo(CALIFICAR(), 'palabra_clave');
    await admin.query(`UPDATE conversations SET on_hold_at = now() WHERE id = $1`, [
      conversationId,
    ]);
    // Marcar resuelto, tal como lo hace la bandeja.
    await admin.query(
      `UPDATE conversations
          SET status = 'closed', closed_at = now(), human_reply_at = NULL, on_hold_at = NULL
        WHERE id = $1`,
      [conversationId],
    );

    const id = await entrante('precio');
    await admin.query(`UPDATE conversations SET status = 'open' WHERE id = $1`, [conversationId]);
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'e2',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });
    expect(r.ejecucionesIniciadas).toBe(1);
  });
});

describe('el motor no se deja engañar', () => {
  it('un job duplicado no envía dos veces', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    const id = await entrante('Hola');
    const trabajo = {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido' as const, conversationId, messageId: id },
    };
    await manejarTrabajoDeFlujo(deps(), trabajo);
    const segundo = await manejarTrabajoDeFlujo(deps(), trabajo);

    expect(await salientes()).toHaveLength(1);
    // El segundo job no arranca otra ejecución: hay una viva en la conversación.
    expect(segundo.ejecucionesIniciadas).toBe(0);
    expect(await ejecucion()).toHaveLength(1);
  });

  it('despertar una espera que ya avanzó no hace nada', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: await entrante('Hola') },
    });
    const runId = (await ejecucion())[0]!.id;
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c2',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: await entrante('no') },
    });
    expect((await ejecucion())[0]).toMatchObject({ status: 'done' });

    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'tarde',
      evento: { tipo: 'despertar', flowRunId: runId },
    });
    expect(r.ignorado).toBe('ya_no_espera');
  });

  it('con la ventana de 24 h cerrada el bot no envía: la ejecución falla y lo dice', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    const id = await entrante('Hola');
    await admin.query(
      `UPDATE conversations SET session_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [conversationId],
    );

    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });

    expect(await salientes()).toHaveLength(0);
    expect((await ejecucion())[0]).toMatchObject({ status: 'failed', error: 'fuera_de_ventana' });
    const { rows: pasos } = await admin.query<{ error: string | null }>(
      `SELECT error FROM flow_run_steps`,
    );
    expect(pasos[0]!.error).toBe('fuera_de_ventana');
  });

  it('la palabra clave dispara; una conversación que ya habló, no', async () => {
    await crearFlujo(CALIFICAR(), 'palabra_clave');
    // Primer mensaje sin la palabra: no dispara nada.
    const uno = await entrante('Buenos días');
    const r1 = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: uno },
    });
    expect(r1.ignorado).toBe('sin_disparador');

    const dos = await entrante('¿Cuál es el precio?');
    const r2 = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c2',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: dos },
    });
    expect(r2.ejecucionesIniciadas).toBe(1);
  });

  it('pasado el tope de bots del plan no arranca ninguno más, y las conversaciones siguen entrando', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    // El plan growth trae 5000 ejecuciones al mes; se dan por gastadas.
    // El periodo se calcula con la MISMA función que usa el registro de uso:
    // `period` es un `date` y compararlo contra un `date_trunc` de SQL depende
    // del huso de la sesión, que es como no comparar nada.
    await admin.query(
      `INSERT INTO usage_rollups (tenant_id, metric, period, quantity)
       VALUES ($1, 'bot.runs', $2, 5000)`,
      [tenantId, inicioDePeriodo(new Date())],
    );

    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: await entrante('Hola') },
    });

    expect(r.ignorado).toBe('limite_de_bots');
    expect(await ejecucion()).toHaveLength(0);
    // Lo que NO pasa: el mensaje del contacto sigue en su conversación. Cortar
    // entrantes sería el peor daño posible y no lo arregla ningún cobro.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM messages WHERE conversation_id = $1 AND direction = 'inbound'`,
      [conversationId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('un saliente no dispara flujos: si no, el bot se contestaría a sí mismo', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status)
       VALUES ($1,$2,$3,'outbound','text','hola','sent') RETURNING id`,
      [tenantId, conversationId, channelAccountId],
    );
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'c1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: rows[0]!.id },
    });
    expect(r.ignorado).toBe('no_es_entrante');
  });

  it('la pausa duerme sin escuchar: un entrante no la adelanta ni mete otro bot', async () => {
    await crearFlujo(CON_PAUSA(), 'conversacion_abierta');
    const id = await entrante('Hola');
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'p1',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
    });

    // Ha saludado y se ha dormido en la pausa, no en una espera de respuesta.
    expect((await salientes()).map((m) => m.body)).toEqual(['Hola']);
    const enPausa = (
      await admin.query<{ wait_for: string; current_node_id: string }>(
        `SELECT wait_for, current_node_id FROM flow_runs`,
      )
    ).rows[0]!;
    expect(enPausa).toMatchObject({ wait_for: 'pausa', current_node_id: 'respira' });

    // El contacto escribe mientras el bot calla: ni lo despierta ni arranca otro.
    const otro = await entrante('¿hola?');
    const r = await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'p2',
      evento: { tipo: 'mensaje_recibido', conversationId, messageId: otro },
    });
    expect(r.ignorado).toBe('ya_hay_flujo');
    expect(await salientes()).toHaveLength(1);

    // Suena el despertador: sigue donde estaba.
    await manejarTrabajoDeFlujo(deps(), {
      tenantId,
      correlationId: 'p3',
      evento: { tipo: 'despertar', flowRunId: (await ejecucion())[0]!.id },
    });
    expect((await salientes()).map((m) => m.body)).toEqual(['Hola', '¿En qué te ayudamos?']);
    expect((await ejecucion())[0]!.status).toBe('done');
  });

  it('el aislamiento entre inquilinos vale también para los bots', async () => {
    await crearFlujo(CALIFICAR(), 'conversacion_abierta');
    const id = await entrante('Hola');
    // Otro inquilino pide procesar ESTE mensaje: con RLS no existe para él.
    const otro = (
      await admin.query<{ id: string }>(
        `INSERT INTO tenants (name, slug) VALUES ('Otra','otra-${Date.now()}') RETURNING id`,
      )
    ).rows[0]!.id;
    const r = await withTenant(app, otro, async () =>
      manejarTrabajoDeFlujo(deps(), {
        tenantId: otro,
        correlationId: 'ajeno',
        evento: { tipo: 'mensaje_recibido', conversationId, messageId: id },
      }),
    );
    expect(r.ignorado).toBe('no_es_entrante');
    expect(await salientes()).toHaveLength(0);
  });
});
