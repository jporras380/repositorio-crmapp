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
const CLAVE_APP = 'crmapp_test_app';
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
              contact_identities, contacts CASCADE`,
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
  tipo: 'texto',
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

  it('emite mensaje.recibido en el outbox', async () => {
    await procesarEventoEntrante(deps(), tenantId, await webhook([mensaje('wamid.1')]));
    const { rows } = await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox`);
    expect(rows.map((r) => r.event_type)).toContain('mensaje.recibido');
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
