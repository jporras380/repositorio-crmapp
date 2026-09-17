/**
 * Procesamiento de webhooks contra PostgreSQL real.
 *
 * Aquí es donde ADR-006 (idempotencia por message_keys) y ADR-007 (identidad
 * separada de persona) dejan de ser documentos: se comprueba que un reenvío
 * no duplica, que una identidad nueva crea persona, que la ventana la reinicia
 * el entrante, y que una cuenta suspendida guarda el crudo sin mostrarlo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar, withTenant } from '@crmapp/db';
import { AdaptadorSandbox, IngestaSandbox } from '@crmapp/channels';
import {
  marcarFallo,
  procesarEventoEntrante,
  type Dependencias,
} from '../src/procesar-entrante.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_worker';
const CLAVE_APP = 'crmapp_dev';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

// Primer dia del mes actual y no una fecha fija: las particiones de `messages`
// existen desde el mes anterior al real hasta tres por delante (migracion
// 0001). Un reloj falso fuera de ese rango falla con "no partition found",
// que es exactamente lo que pasaria en produccion si el job de precreacion
// dejara de correr. Toda la aritmetica de abajo es relativa a T0.
const T0 = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 10, 0, 0));
})();
const horas = (n: number) => n * 3_600_000;

let admin: Pool;
let app: Pool;
let tenantId: string;
let channelAccountId: string;
let ahora = T0;

const deps = (): Dependencias => ({
  pool: app,
  ingesta: new Map([['whatsapp', new IngestaSandbox('whatsapp')]]),
  canales: new Map([['whatsapp', new AdaptadorSandbox({ canal: 'whatsapp' })]]),
  ahora: () => ahora,
});

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();
  await migrar(url(DB));

  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${CLAVE_APP}'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app`);
  const t = await conf.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
  );
  tenantId = t.rows[0]!.id;
  const ca = await conf.query<{ id: string }>(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name)
     VALUES ($1, 'whatsapp', 'pn-1', 'WA') RETURNING id`,
    [tenantId],
  );
  channelAccountId = ca.rows[0]!.id;
  // El embudo por defecto, igual que lo monta el alta de cuenta.
  await conf.query(`SELECT app.sembrar_embudo($1)`, [tenantId]);
  // Suscripción en prueba, vigente durante todo el test.
  const plan = await conf.query<{ id: string }>(`SELECT id FROM plans WHERE code = 'starter'`);
  await conf.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at, grace_days)
     VALUES ($1, $2, 'trialing', $3, 7)`,
    [tenantId, plan.rows[0]!.id, new Date('2026-12-31T00:00:00.000Z')],
  );
  await conf.end();

  admin = new Pool({ connectionString: url(DB) });
  // El worker corre con el rol de aplicación, sujeto a RLS.
  app = new Pool({ connectionString: url(DB, 'crmapp_app', CLAVE_APP) });
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

beforeEach(async () => {
  ahora = T0;
  // CASCADE: conversations la referencian notas y etiquetas; contacts, las
  // fusiones. Enumerarlas a mano se rompe en la primera tabla nueva.
  await admin.query(
    `TRUNCATE inbound_events, outbox, messages, message_keys, conversations,
              contact_identities, contacts, media_assets, wa_templates,
              usage_events, usage_event_keys, usage_rollups CASCADE`,
  );
});

/** Persiste un webhook crudo como lo haría la API, y devuelve su id. */
async function webhook(eventos: unknown[]): Promise<string> {
  return withTenant(app, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>('SELECT uuidv7() AS id');
    const id = rows[0]!.id;
    await c.query(
      `INSERT INTO inbound_events (id, tenant_id, channel, channel_account_id, signature_ok, raw, status)
       VALUES ($1, $2, 'whatsapp', $3, true, $4, 'pending')`,
      [id, tenantId, channelAccountId, JSON.stringify({ cuenta: 'pn-1', eventos })],
    );
    return id;
  });
}

const mensaje = (externalMessageId: string, extra: Record<string, unknown> = {}) => ({
  clase: 'mensaje',
  externalMessageId,
  externalUserId: 'wa-ana',
  tipo: 'text',
  texto: 'hola',
  nombre: 'Ana',
  telefono: '+34600111222',
  ...extra,
});

const contar = async (tabla: string) =>
  (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0]!.n;

describe('mensaje nuevo', () => {
  it('crea contacto, identidad, conversación y mensaje en una transacción', async () => {
    const id = await webhook([mensaje('wamid.1')]);
    const r = await procesarEventoEntrante(deps(), tenantId, id);

    expect(r).toMatchObject({ mensajesNuevos: 1, duplicados: 0 });
    expect(await contar('contacts')).toBe(1);
    expect(await contar('contact_identities')).toBe(1);
    expect(await contar('conversations')).toBe(1);
    expect(await contar('messages')).toBe(1);

    const { rows } = await admin.query<{ status: string; processed_at: Date }>(
      `SELECT status, processed_at FROM inbound_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('processed');
    expect(rows[0]!.processed_at).toBeTruthy();
  });

  it('la identidad es del canal y la persona es nuestra (ADR-007)', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    const { rows } = await admin.query<{
      external_user_id: string;
      phone_e164: string;
      display_name: string;
    }>(
      `SELECT ci.external_user_id, ci.phone_e164, c.display_name
         FROM contact_identities ci JOIN contacts c ON c.id = ci.contact_id`,
    );
    expect(rows[0]!.external_user_id).toBe('wa-ana');
    expect(rows[0]!.phone_e164).toBe('+34600111222');
    expect(rows[0]!.display_name).toBe('Ana');
  });

  it('un segundo mensaje del mismo contacto NO crea otra persona ni otra conversación', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.2')]));
    expect(await contar('contacts')).toBe(1);
    expect(await contar('conversations')).toBe(1);
    expect(await contar('messages')).toBe(2);
  });

  it('un medio entrante crea media_asset pending y encola su descarga por el outbox', async () => {
    const id = await webhook([
      mensaje('wamid.img', { tipo: 'image', texto: undefined, mediaId: 'media-9' }),
    ]);
    await procesarEventoEntrante(deps(), tenantId, id);

    const m = await admin.query<{ media_asset_id: string | null }>(
      `SELECT media_asset_id FROM messages WHERE external_message_id = 'wamid.img'`,
    );
    const mediaAssetId = m.rows[0]!.media_asset_id;
    expect(mediaAssetId).toBeTruthy();
    const ma = await admin.query<{ status: string; kind: string }>(
      `SELECT status, kind FROM media_assets WHERE id = $1`,
      [mediaAssetId],
    );
    expect(ma.rows[0]).toEqual({ status: 'pending', kind: 'image' });

    const o = await admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE event_type = 'media.descargar'`,
    );
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]!.payload).toMatchObject({
      mediaAssetId,
      mediaId: 'media-9',
      canal: 'whatsapp',
    });
  });

  it('el handle de WhatsApp es el teléfono, no el nombre de perfil', async () => {
    // Un contacto real llegó con profile.name = "." y la bandeja no decía a
    // quién se estaba escribiendo.
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.handle', { nombre: '.', telefono: '+51925300224' })]),
    );
    const { rows } = await admin.query<{ handle: string; phone_e164: string }>(
      `SELECT handle, phone_e164 FROM contact_identities WHERE external_user_id = 'wa-ana'`,
    );
    expect(rows[0]).toEqual({ handle: '+51925300224', phone_e164: '+51925300224' });
    const c = await admin.query<{ display_name: string }>(`SELECT display_name FROM contacts`);
    expect(c.rows[0]!.display_name).toBe('.');
  });

  it('nombres de usuario: la misma persona con número hoy y solo con BSUID mañana es UNA', async () => {
    // Primer mensaje: número, BSUID y @usuario.
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([
        mensaje('wamid.u1', {
          externalUserId: '51999888777',
          telefono: '+51999888777',
          bsuid: 'PE.1349',
          usuario: 'rosa.viajera',
          nombre: 'Rosa',
        }),
      ]),
    );
    // Segundo: Meta ya no manda el número (nombre de usuario activo).
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([
        mensaje('wamid.u2', {
          externalUserId: 'PE.1349',
          telefono: undefined,
          bsuid: 'PE.1349',
          usuario: 'rosa.viajera',
          nombre: 'Rosa',
        }),
      ]),
    );
    expect(await contar('contacts')).toBe(1);
    expect(await contar('conversations')).toBe(1);
    expect(await contar('messages')).toBe(2);
    const { rows } = await admin.query(
      `SELECT external_user_id, phone_e164, provider_user_id, username, handle FROM contact_identities`,
    );
    expect(rows[0]).toEqual({
      external_user_id: '51999888777',
      phone_e164: '+51999888777',
      provider_user_id: 'PE.1349',
      username: 'rosa.viajera',
      handle: '+51999888777 · @rosa.viajera',
    });
  });

  it('quien llega solo con @usuario se ve como @usuario, nunca por su BSUID', async () => {
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([
        mensaje('wamid.u3', {
          externalUserId: 'PE.7777',
          telefono: undefined,
          bsuid: 'PE.7777',
          usuario: 'carlos_bca',
          nombre: undefined,
        }),
      ]),
    );
    const { rows } = await admin.query(
      `SELECT ci.handle, c.display_name FROM contact_identities ci JOIN contacts c ON c.id = ci.contact_id`,
    );
    expect(rows[0]).toEqual({ handle: '@carlos_bca', display_name: '@carlos_bca' });
  });

  it('el nombre que puso un agente no lo pisa el siguiente mensaje', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.n1')]));
    await admin.query(`UPDATE contacts SET display_name = 'Ana · reserva julio'`);
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.n2', { nombre: 'Ana P.' })]),
    );
    const c = await admin.query<{ display_name: string }>(`SELECT display_name FROM contacts`);
    expect(c.rows[0]!.display_name).toBe('Ana · reserva julio');
  });

  it('un comentario abre un hilo comment_thread por publicación; el siguiente lo continúa; el duplicado no', async () => {
    const comentario = (id: string, post: string, texto: string) => ({
      clase: 'comentario',
      externalCommentId: id,
      externalUserId: 'ig-caro',
      externalPostId: post,
      texto,
      nombre: 'caro.rp',
    });
    const r1 = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([comentario('c.1', 'post.A', 'Precio?')]),
    );
    expect(r1).toMatchObject({ comentariosNuevos: 1, mensajesNuevos: 0, duplicados: 0 });

    const hilos = await admin.query<{ kind: string; external_thread_id: string; status: string }>(
      `SELECT kind, external_thread_id, status FROM conversations ORDER BY created_at`,
    );
    expect(hilos.rows).toEqual([
      { kind: 'comment_thread', external_thread_id: 'post.A', status: 'open' },
    ]);
    const contacto = await admin.query<{ display_name: string }>(
      `SELECT display_name FROM contacts`,
    );
    expect(contacto.rows[0]!.display_name).toBe('caro.rp');

    // Segundo comentario en la misma publicación: mismo hilo. Otra publicación: hilo nuevo.
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([comentario('c.2', 'post.A', 'Sigue?')]),
    );
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([comentario('c.3', 'post.B', 'Y este?')]),
    );
    expect(await contar('conversations')).toBe(2);
    expect(await contar('messages')).toBe(3);

    // Reenvío del mismo comentario: duplicado.
    const r4 = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([comentario('c.2', 'post.A', 'Sigue?')]),
    );
    expect(r4).toMatchObject({ comentariosNuevos: 0, duplicados: 1 });

    const m = await admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM messages WHERE external_message_id = 'c.1'`,
    );
    expect(m.rows[0]!.payload).toMatchObject({ comentario: { id: 'c.1', postId: 'post.A' } });
  });

  it('un cambio de estado de plantilla desde Meta se refleja y se anuncia', async () => {
    await admin.query(
      `INSERT INTO wa_templates (tenant_id, channel_account_id, name, language, status)
       VALUES ($1, $2, 'bienvenida', 'es', 'aprobada')`,
      [tenantId, channelAccountId],
    );
    const id = await webhook([
      { clase: 'plantilla', nombre: 'bienvenida', idioma: 'es', estado: 'pausada' },
    ]);
    const r = await procesarEventoEntrante(deps(), tenantId, id);
    expect(r).toMatchObject({ plantillasActualizadas: 1, ignorados: 0 });

    const t = await admin.query<{ status: string }>(
      `SELECT status FROM wa_templates WHERE name = 'bienvenida'`,
    );
    expect(t.rows[0]!.status).toBe('pausada');
    const o = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox WHERE event_type = 'plantilla.actualizada'`,
    );
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]!.payload).toMatchObject({ nombre: 'bienvenida', estado: 'pausada' });
  });

  it('una plantilla que no conocíamos se registra al llegar su estado', async () => {
    const id = await webhook([
      {
        clase: 'plantilla',
        nombre: 'promo',
        idioma: 'es',
        estado: 'rechazada',
        motivoDeRechazo: 'INVALID_FORMAT',
      },
    ]);
    await procesarEventoEntrante(deps(), tenantId, id);
    const t = await admin.query<{
      status: string;
      rejection_reason: string;
      current_version_id: string;
    }>(
      `SELECT status, rejection_reason, current_version_id FROM wa_templates WHERE name = 'promo'`,
    );
    expect(t.rows[0]).toMatchObject({ status: 'rechazada', rejection_reason: 'INVALID_FORMAT' });
    expect(t.rows[0]!.current_version_id).toBeTruthy();
  });

  it('mide: cada entrante suma messages.inbound; la conversación se cuenta al abrirse o reabrirse', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.u1')]));
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.u2')]));
    const uso = async (metric: string) =>
      (
        await admin.query<{ quantity: string }>(
          `SELECT quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = $2`,
          [tenantId, metric],
        )
      ).rows[0]?.quantity ?? '0';
    expect(await uso('messages.inbound')).toBe('2');
    expect(await uso('conversations.opened')).toBe('1');

    // Se cierra y vuelve a escribir: reapertura, suma una.
    await admin.query(`UPDATE conversations SET status = 'closed'`);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.u3')]));
    expect(await uso('conversations.opened')).toBe('2');
    expect(await uso('messages.inbound')).toBe('3');

    // Un reenvío duplicado no suma.
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.u3')]));
    expect(await uso('messages.inbound')).toBe('3');
  });

  it('un texto no crea media_asset aunque el proveedor mande mediaId vacío', async () => {
    const id = await webhook([mensaje('wamid.txt')]);
    await procesarEventoEntrante(deps(), tenantId, id);
    expect(await contar('media_assets')).toBe(0);
  });

  it('emite mensaje.recibido en el outbox', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    const { rows } = await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox`);
    expect(rows.map((r) => r.event_type)).toContain('mensaje.recibido');
  });
});

describe('embudo', () => {
  const leads = async () =>
    (
      await admin.query<{ title: string; stage: string; conversation_id: string | null }>(
        `SELECT l.title, s.name AS stage, l.conversation_id
           FROM leads l JOIN pipeline_stages s ON s.id = l.stage_id
          ORDER BY l.created_at`,
      )
    ).rows;

  it('una conversación nueva abre un lead, y el título es lo que pidió el cliente', async () => {
    await procesarEventoEntrante(
      deps(),
      tenantId,
      // `text` y no `texto`: es la clave del formato CRUDO del sandbox.
      await webhook([mensaje('wamid.lead-1', { text: 'Hola, ¿tienen bungalow para el 28?' })]),
    );
    expect(await leads()).toEqual([
      {
        title: 'Hola, ¿tienen bungalow para el 28?',
        stage: 'Consulta',
        conversation_id: expect.any(String),
      },
    ]);
  });

  it('el segundo mensaje del mismo huésped NO abre otra tarjeta', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.lead-2')]));
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.lead-3')]));
    // Tres mensajes seguidos abriendo tres tarjetas iguales destrozan el
    // tablero en una tarde: por eso la regla es «uno abierto por contacto».
    expect(await leads()).toHaveLength(1);
  });

  it('sin embudo no se pierde el mensaje: el lead es lo accesorio', async () => {
    await admin.query(`DELETE FROM pipelines`);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.lead-4')]));
    expect(await contar('messages')).toBe(1);
    expect(await leads()).toHaveLength(0);
    await admin.query(`SELECT app.sembrar_embudo($1)`, [tenantId]);
  });
});

describe('idempotencia (ADR-006)', () => {
  it('el reenvío de Meta con el mismo external_message_id no duplica', async () => {
    // Meta reenvía si duda del 200. La API acepta el reenvío (segunda fila
    // cruda); el worker es quien deduplica contra message_keys.
    const a = await webhook([mensaje('wamid.REPETIDO')]);
    const b = await webhook([mensaje('wamid.REPETIDO')]);
    const r1 = await procesarEventoEntrante(deps(), tenantId, a);
    const r2 = await procesarEventoEntrante(deps(), tenantId, b);

    expect(r1.mensajesNuevos).toBe(1);
    expect(r2).toMatchObject({ mensajesNuevos: 0, duplicados: 1 });
    expect(await contar('messages')).toBe(1);
    // Gana el primero: el segundo evento queda procesado, no fallido.
    const { rows } = await admin.query<{ status: string }>(
      `SELECT status FROM inbound_events WHERE id = $1`,
      [b],
    );
    expect(rows[0]!.status).toBe('processed');
  });

  it('reprocesar el mismo inbound_event es un no-op', async () => {
    // El relay entrega al menos una vez y un job puede correr dos veces.
    const id = await webhook([mensaje('wamid.1')]);
    await procesarEventoEntrante(deps(), tenantId, id);
    const r = await procesarEventoEntrante(deps(), tenantId, id);
    expect(r.mensajesNuevos).toBe(0);
    expect(await contar('messages')).toBe(1);
  });

  it('dos procesamientos simultáneos del mismo mensaje producen uno solo', async () => {
    const a = await webhook([mensaje('wamid.CARRERA')]);
    const b = await webhook([mensaje('wamid.CARRERA')]);
    const [r1, r2] = await Promise.all([
      procesarEventoEntrante(deps(), tenantId, a),
      procesarEventoEntrante(deps(), tenantId, b),
    ]);
    expect(r1.mensajesNuevos + r2.mensajesNuevos).toBe(1);
    expect(await contar('messages')).toBe(1);
    expect(await contar('contacts')).toBe(1);
  });
});

describe('ventana de sesión', () => {
  const expiracion = async () =>
    (
      await admin.query<{ session_expires_at: Date }>(
        `SELECT session_expires_at FROM conversations`,
      )
    ).rows[0]!.session_expires_at;

  it('un entrante abre la ventana de 24 h', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    expect((await expiracion()).getTime()).toBe(T0.getTime() + horas(24));
  });

  it('cada entrante la reinicia', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    ahora = new Date(T0.getTime() + horas(10));
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.2')]));
    expect((await expiracion()).getTime()).toBe(T0.getTime() + horas(34));
  });

  it('la entrada gratuita (Click-to-WhatsApp) da 72 h', async () => {
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.1', { entradaGratuita: true })]),
    );
    expect((await expiracion()).getTime()).toBe(T0.getTime() + horas(72));
  });

  it('un mensaje reabre una conversación cerrada en vez de crear otra', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    await admin.query(`UPDATE conversations SET status = 'closed', closed_at = now()`);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.2')]));
    expect(await contar('conversations')).toBe(1);
    const { rows } = await admin.query<{ status: string; unread_count: number }>(
      `SELECT status, unread_count FROM conversations`,
    );
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.unread_count).toBe(2);
  });
});

describe('estados de entrega', () => {
  const estadoDe = async () =>
    (await admin.query<{ status: string }>(`SELECT status FROM messages`)).rows[0]!.status;

  it('avanza delivered → read', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([{ clase: 'estado', externalMessageId: 'wamid.1', estado: 'read' }]),
    );
    expect(r.estadosAplicados).toBe(1);
    expect(await estadoDe()).toBe('read');
  });

  it('un estado que llega tarde y desordenado no retrocede', async () => {
    // Es normal recibir `delivered` antes que `sent`.
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([{ clase: 'estado', externalMessageId: 'wamid.1', estado: 'read' }]),
    );
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([{ clase: 'estado', externalMessageId: 'wamid.1', estado: 'sent' }]),
    );
    expect(r).toMatchObject({ estadosAplicados: 0, ignorados: 1 });
    expect(await estadoDe()).toBe('read');
  });

  it('failed se acepta siempre', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([{ clase: 'estado', externalMessageId: 'wamid.1', estado: 'failed' }]),
    );
    expect(await estadoDe()).toBe('failed');
  });

  it('el estado de un mensaje desconocido se ignora sin fallar', async () => {
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([{ clase: 'estado', externalMessageId: 'wamid.NUNCA', estado: 'read' }]),
    );
    expect(r).toMatchObject({ estadosAplicados: 0, ignorados: 1 });
  });
});

describe('cuenta suspendida', () => {
  it('guarda el crudo pero no crea nada visible', async () => {
    // Caso de carrera del ARCH: un evento en vuelo cuando se desconectó el
    // canal. Se responde 200, se guarda, y no se muestra.
    await admin.query(
      `UPDATE subscriptions SET trial_ends_at = $1, grace_days = 0 WHERE tenant_id = $2`,
      [new Date(T0.getTime() - horas(48)), tenantId],
    );
    try {
      const id = await webhook([mensaje('wamid.1')]);
      const r = await procesarEventoEntrante(deps(), tenantId, id);
      expect(r.omitidoPorSuspension).toBe(true);
      expect(await contar('messages')).toBe(0);
      expect(await contar('contacts')).toBe(0);
      const { rows } = await admin.query<{ status: string; error: { motivo: string } }>(
        `SELECT status, error FROM inbound_events WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.status).toBe('processed');
      expect(rows[0]!.error.motivo).toBe('cuenta_suspendida');
    } finally {
      await admin.query(
        `UPDATE subscriptions SET trial_ends_at = $1, grace_days = 7 WHERE tenant_id = $2`,
        [new Date('2026-12-31T00:00:00.000Z'), tenantId],
      );
    }
  });
});

describe('fallos', () => {
  it('un fallo a mitad no deja nada a medias y marca el evento', async () => {
    const id = await webhook([mensaje('wamid.1')]);
    const rotas: Dependencias = { ...deps(), canales: new Map() }; // sin política de ventana
    await expect(procesarEventoEntrante(rotas, tenantId, id)).rejects.toThrow(/Sin adaptador/);
    await marcarFallo(app, tenantId, id, new Error('Sin adaptador para el canal'));

    expect(await contar('messages')).toBe(0);
    expect(await contar('contacts')).toBe(0);
    const { rows } = await admin.query<{ status: string; attempts: number; error: unknown }>(
      `SELECT status, attempts, error FROM inbound_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.error).toBeTruthy();
  });
});

describe('reparto automático (0026)', () => {
  let ana: string;
  let beto: string;

  const usuario = async (email: string) => {
    const u = (
      await admin.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name) VALUES ($1::text, 'x', $1::text)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
        [email],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'agent')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', accepts_assignments = true`,
      [tenantId, u],
    );
    return u;
  };
  const asignadoDe = async (externalMessageId: string) =>
    (
      await admin.query<{ assignee_user_id: string | null }>(
        `SELECT c.assignee_user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.external_message_id = $1`,
        [externalMessageId],
      )
    ).rows[0]!.assignee_user_id;
  /** Conversación abierta ya asignada, para cargar a alguien de trabajo. */
  const cargar = async (userId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await procesarEventoEntrante(
        deps(),
        tenantId,
        await webhook([
          mensaje(`wamid.carga-${userId}-${i}`, { externalUserId: `carga-${userId}-${i}` }),
        ]),
      );
      await admin.query(
        `UPDATE conversations SET assignee_user_id = $1
          WHERE id = (SELECT conversation_id FROM messages WHERE external_message_id = $2)`,
        [userId, `wamid.carga-${userId}-${i}`],
      );
    }
  };

  beforeAll(async () => {
    ana = await usuario('ana-reparto@test.test');
    beto = await usuario('beto-reparto@test.test');
  });
  afterAll(async () => {
    await admin.query(`UPDATE tenants SET auto_assignment = 'off' WHERE id = $1`, [tenantId]);
    await admin.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id IN ($2, $3)`, [
      tenantId,
      ana,
      beto,
    ]);
  });

  it('apagado (por defecto): la conversación nueva queda sin asignar', async () => {
    await admin.query(`UPDATE tenants SET auto_assignment = 'off' WHERE id = $1`, [tenantId]);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.r0')]));
    expect(await asignadoDe('wamid.r0')).toBeNull();
  });

  it('encendido: va a quien tiene menos conversaciones abiertas, y el lead con ella', async () => {
    await admin.query(`UPDATE tenants SET auto_assignment = 'least_busy' WHERE id = $1`, [
      tenantId,
    ]);
    await admin.query(
      `UPDATE memberships SET accepts_assignments = false WHERE tenant_id = $1 AND user_id NOT IN ($2, $3)`,
      [tenantId, ana, beto],
    );
    await cargar(ana, 2);
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.r1', { externalUserId: 'nuevo-1' })]),
    );
    expect(await asignadoDe('wamid.r1')).toBe(beto);
    const lead = await admin.query<{ assignee_user_id: string | null }>(
      `SELECT l.assignee_user_id FROM leads l JOIN messages m ON m.conversation_id = l.conversation_id
        WHERE m.external_message_id = 'wamid.r1'`,
    );
    expect(lead.rows[0]?.assignee_user_id).toBe(beto);
  });

  it('quien no acepta asignaciones no recibe, aunque esté libre', async () => {
    await admin.query(`UPDATE tenants SET auto_assignment = 'least_busy' WHERE id = $1`, [
      tenantId,
    ]);
    await admin.query(
      `UPDATE memberships SET accepts_assignments = false WHERE tenant_id = $1 AND user_id <> $2`,
      [tenantId, ana],
    );
    await cargar(ana, 3);
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.r2', { externalUserId: 'nuevo-2' })]),
    );
    expect(await asignadoDe('wamid.r2')).toBe(ana);
  });

  it('al reabrirse, conserva a su responsable si sigue en el reparto', async () => {
    await admin.query(`UPDATE tenants SET auto_assignment = 'least_busy' WHERE id = $1`, [
      tenantId,
    ]);
    await admin.query(`UPDATE memberships SET accepts_assignments = true WHERE tenant_id = $1`, [
      tenantId,
    ]);
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.r3', { externalUserId: 'vuelve' })]),
    );
    await admin.query(
      `UPDATE conversations SET assignee_user_id = $1, status = 'closed'
        WHERE id = (SELECT conversation_id FROM messages WHERE external_message_id = 'wamid.r3')`,
      [ana],
    );
    await cargar(ana, 4); // Ana es la más ocupada, pero ya conocía a esta persona.
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.r4', { externalUserId: 'vuelve' })]),
    );
    expect(await asignadoDe('wamid.r4')).toBe(ana);
  });
});

describe('aviso fuera de horario (0027)', () => {
  const HORARIO = { '1': [['09:00', '18:00']], '2': [['09:00', '18:00']] };
  /** Martes 11:00 y 23:00 en Lima (UTC−5). */
  const abierto = new Date('2026-09-15T16:00:00Z');
  const cerrado = new Date('2026-09-16T04:00:00Z');

  const configurar = async (opciones: { encendido: boolean; texto?: string; tz?: string }) => {
    await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
    await admin.query(
      `INSERT INTO business_hours (tenant_id, timezone, schedule, auto_reply_enabled, auto_reply_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        opciones.tz ?? 'America/Lima',
        JSON.stringify(HORARIO),
        opciones.encendido,
        opciones.texto ??
          'Gracias por escribir. Atendemos de 9:00 a 18:00 y te respondemos mañana.',
      ],
    );
  };
  const salientes = async () =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages WHERE direction = 'outbound'`,
      )
    ).rows[0]!.n;

  afterAll(async () => {
    await admin.query(`DELETE FROM business_hours WHERE tenant_id = $1`, [tenantId]);
  });

  it('dentro del horario no dice nada', async () => {
    await configurar({ encendido: true });
    ahora = abierto;
    const r = await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.h1')]));
    expect(r.avisosFueraDeHorario).toBe(0);
    expect(await salientes()).toBe(0);
  });

  it('fuera del horario responde una vez, con el texto del hotel y como bot', async () => {
    ahora = cerrado;
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h2', { externalUserId: 'noche' })]),
    );
    expect(r.avisosFueraDeHorario).toBe(1);
    const { rows } = await admin.query<{ body: string; sent_by: string; status: string }>(
      `SELECT body, sent_by, status FROM messages WHERE direction = 'outbound'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sent_by: 'bot', status: 'queued' });
    expect(rows[0]!.body).toContain('Atendemos de 9:00 a 18:00');
  });

  it('no repite el aviso con cada mensaje de la misma noche, pero sí a las seis horas', async () => {
    await configurar({ encendido: true });
    ahora = cerrado;
    await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h3a', { externalUserId: 'noche' })]),
    );
    // Sigue escribiendo a los dos minutos: ya se le avisó.
    ahora = new Date(cerrado.getTime() + 120_000);
    const seguido = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h3b', { externalUserId: 'noche' })]),
    );
    expect(seguido.avisosFueraDeHorario).toBe(0);
    expect(await salientes()).toBe(1);

    // Siete horas después (sigue de madrugada) se le vuelve a avisar.
    ahora = new Date(cerrado.getTime() + 7 * 3_600_000);
    const luego = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h4', { externalUserId: 'noche' })]),
    );
    expect(luego.avisosFueraDeHorario).toBe(1);
    expect(await salientes()).toBe(2);
  });

  it('apagado no envía nada, aunque esté cerrado', async () => {
    await configurar({ encendido: false });
    ahora = cerrado;
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h5', { externalUserId: 'otra-noche' })]),
    );
    expect(r.avisosFueraDeHorario).toBe(0);
  });

  it('una zona horaria que no se entiende no dispara avisos a deshora', async () => {
    await configurar({ encendido: true, tz: 'Marte/Olympus' });
    ahora = cerrado;
    const r = await procesarEventoEntrante(
      deps(),
      tenantId,
      await webhook([mensaje('wamid.h6', { externalUserId: 'marciano' })]),
    );
    expect(r.avisosFueraDeHorario).toBe(0);
  });
});

describe('señal de vida del canal', () => {
  const ultimoEvento = async () =>
    (
      await admin.query<{ last_event_at: Date | null }>(
        `SELECT last_event_at FROM channel_accounts WHERE id = $1`,
        [channelAccountId],
      )
    ).rows[0]!.last_event_at;

  it('un webhook deja escrito cuándo llegó: es lo que contesta «¿por qué no entra nada?»', async () => {
    await admin.query(`UPDATE channel_accounts SET last_event_at = NULL WHERE id = $1`, [
      channelAccountId,
    ]);
    ahora = T0;
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.vida1')]));
    expect(await ultimoEvento()).toEqual(T0);
  });

  it('no se escribe en cada webhook: la misma fila la leen todos los envíos', async () => {
    // Un solo mensaje trae hasta tres webhooks de estado seguidos. Saber el
    // minuto basta, y así no se castiga una fila caliente.
    ahora = new Date(T0.getTime() + 30_000);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.vida2')]));
    expect(await ultimoEvento()).toEqual(T0);

    ahora = new Date(T0.getTime() + 120_000);
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.vida3')]));
    expect(await ultimoEvento()).toEqual(ahora);
  });
});
