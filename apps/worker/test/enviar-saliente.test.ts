/**
 * Entrega de salientes: idempotencia ante reintentos y destino según
 * `reintentable`. Contra PostgreSQL real y el adaptador sandbox, que sabe fallar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar, withTenant } from '@crmapp/db';
import { AdaptadorSandbox, type ChannelAdapter } from '@crmapp/channels';
import { AlmacenEnMemoria } from '@crmapp/storage';
import { enviarMensajeSaliente, type CargaDeEnvio } from '../src/enviar-saliente.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_salida';
const url = (db: string, u = SU, p = PASS) => `postgres://${u}:${p}@${HOST}:${PORT}/${db}`;

let admin: Pool;
let app: Pool;
let tenantId: string;
let channelAccountId: string;
let conversationId: string;
let sandbox: AdaptadorSandbox;
const canales = (): Map<string, ChannelAdapter> => new Map([['whatsapp', sandbox]]);

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();
  await migrar(url(DB));
  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  await conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD 'crmapp_dev'`);
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app`);
  tenantId = (
    await conf.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('A','a') RETURNING id`,
    )
  ).rows[0]!.id;
  channelAccountId = (
    await conf.query<{ id: string }>(
      `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name) VALUES ($1,'whatsapp','pn','WA') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const c = (
    await conf.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,'Ana') RETURNING id`,
      [tenantId],
    )
  ).rows[0]!.id;
  const ci = (
    await conf.query<{ id: string }>(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id)
       VALUES ($1,$2,'whatsapp',$3,'wa-ana') RETURNING id`,
      [tenantId, c, channelAccountId],
    )
  ).rows[0]!.id;
  conversationId = (
    await conf.query<{ id: string }>(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, ci, c, channelAccountId],
    )
  ).rows[0]!.id;
  await conf.end();
  admin = new Pool({ connectionString: url(DB) });
  app = new Pool({ connectionString: url(DB, 'crmapp_app', 'crmapp_dev') });
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
  sandbox = new AdaptadorSandbox({ canal: 'whatsapp' });
  await admin.query(
    'TRUNCATE messages, message_keys, outbox, media_assets, usage_events, usage_event_keys, usage_rollups CASCADE',
  );
});

/** Inserta un saliente en `queued` como lo hace la API y devuelve su carga. */
async function encolado(texto = 'hola'): Promise<CargaDeEnvio> {
  return withTenant(app, tenantId, async (c) => {
    const id = (await c.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    const createdAt = new Date();
    await c.query(
      `INSERT INTO messages (id, tenant_id, conversation_id, channel_account_id, direction, type, body, status, sent_by, created_at)
       VALUES ($1,$2,$3,$4,'outbound','text',$5,'queued','human',$6)`,
      [id, tenantId, conversationId, channelAccountId, texto, createdAt],
    );
    return {
      messageId: id,
      createdAt: createdAt.toISOString(),
      conversationId,
      channelAccountId,
      canal: 'whatsapp',
      externalUserId: 'wa-ana',
      peticion: { tipo: 'text', texto },
    };
  });
}

const estadoDe = async (id: string) =>
  (
    await admin.query<{ status: string; external_message_id: string | null; error: unknown }>(
      `SELECT status, external_message_id, error FROM messages WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

describe('entrega correcta', () => {
  it('marca sent, guarda el id del proveedor y registra la clave para los estados', async () => {
    const carga = await encolado();
    expect(await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga)).toBe(
      'enviado',
    );
    const m = await estadoDe(carga.messageId);
    expect(m.status).toBe('sent');
    expect(m.external_message_id).toMatch(/^sandbox\./);
    const k = await admin.query(`SELECT 1 FROM message_keys WHERE message_id = $1`, [
      carga.messageId,
    ]);
    expect(k.rows).toHaveLength(1);
    expect(sandbox.enviados).toHaveLength(1);
  });

  it('emite mensaje.enviado en el outbox', async () => {
    const carga = await encolado();
    await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga);
    const o = await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox`);
    expect(o.rows.map((r) => r.event_type)).toContain('mensaje.enviado');
  });
});

describe('idempotencia ante reintentos', () => {
  it('un segundo intento no vuelve a enviar', async () => {
    // BullMQ puede ejecutar el job dos veces. Sin la reserva condicional, el
    // cliente recibiría el mismo WhatsApp dos veces.
    const carga = await encolado();
    await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga);
    expect(await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga)).toBe(
      'ya_procesado',
    );
    expect(sandbox.enviados).toHaveLength(1);
  });

  it('dos intentos simultáneos producen un solo envío', async () => {
    const carga = await encolado();
    const r = await Promise.all([
      enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga),
      enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga),
    ]);
    expect(r.filter((x) => x === 'enviado')).toHaveLength(1);
    expect(sandbox.enviados).toHaveLength(1);
  });
});

describe('errores: reintentable decide el destino', () => {
  it('no reintentable → failed con motivo, sin relanzar', async () => {
    const carga = await encolado();
    sandbox.programarFallo({ tipo: 'token_invalido', reintentable: false });
    expect(await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga)).toBe(
      'fallido',
    );
    const m = await estadoDe(carga.messageId);
    expect(m.status).toBe('failed');
    expect((m.error as { tipo: string }).tipo).toBe('token_invalido');
    const o = await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox`);
    expect(o.rows.map((r) => r.event_type)).toContain('mensaje.fallido');
  });

  it('reintentable → vuelve a queued y relanza para el backoff de BullMQ', async () => {
    const carga = await encolado();
    sandbox.programarFallo({ tipo: 'limite_de_tasa', reintentable: true });
    await expect(
      enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga),
    ).rejects.toMatchObject({ reintentable: true });
    expect((await estadoDe(carga.messageId)).status).toBe('queued');
    // El siguiente intento pasa la reserva y envía.
    expect(await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga)).toBe(
      'enviado',
    );
  });
});

describe('medición', () => {
  it('lo entregado suma messages.outbound; lo fallido no; el reintento no duplica', async () => {
    const carga = await encolado();
    await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga);
    await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga);
    const fallido = await encolado('x');
    sandbox.programarFallo({ tipo: 'destinatario_invalido', reintentable: false });
    await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, fallido);
    const r = await admin.query<{ quantity: string }>(
      `SELECT quantity FROM usage_rollups WHERE tenant_id = $1 AND metric = 'messages.outbound'`,
      [tenantId],
    );
    expect(r.rows[0]!.quantity).toBe('1');
  });
});

describe('medio propio', () => {
  async function medio(status: 'stored' | 'pending') {
    return withTenant(app, tenantId, async (c) => {
      const id = (await c.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
      await c.query(
        `INSERT INTO media_assets (id, tenant_id, kind, status, storage_key, mime)
         VALUES ($1, $2, 'image', $3, $4, 'image/jpeg')`,
        [id, tenantId, status, `tenants/${tenantId}/media/${id}.jpg`],
      );
      return id;
    });
  }

  it('a WhatsApp le van los BYTES, no una URL: Meta no puede entrar en nuestro almacén', async () => {
    // El fallo real que esto arregla: se mandaba siempre una URL firmada. En
    // desarrollo apunta a MinIO en `localhost`, así que Meta aceptaba el
    // mensaje, devolvía su `wamid` y fallaba DESPUÉS al descargarla
    // («131053 Media upload error»). El cliente no recibía nada y el CRM
    // seguía diciendo «Enviado».
    const mediaAssetId = await medio('stored');
    const clave = `tenants/${tenantId}/media/${mediaAssetId}.jpg`;
    const base = await encolado();
    const carga: CargaDeEnvio = {
      ...base,
      peticion: { tipo: 'image', url: null, mediaAssetId, pieDeFoto: 'foto' },
    };
    const almacen = new AlmacenEnMemoria();
    await almacen.guardar(clave, Buffer.from('los bytes de la foto'), 'image/jpeg');
    const firmadas: string[] = [];
    almacen.urlDeLectura = async (c) => {
      firmadas.push(c);
      return 'no-deberia-usarse';
    };

    expect(
      await enviarMensajeSaliente({ pool: app, canales: canales(), almacen }, tenantId, carga),
    ).toBe('enviado');
    expect(sandbox.enviados[0]!.contenido).toMatchObject({ origen: 'buffer', pieDeFoto: 'foto' });
    // Y no se firma ninguna URL: el bucket no tiene por qué ser accesible.
    expect(firmadas).toEqual([]);
  });

  it('un canal que SÍ exige URL pública la sigue recibiendo firmada', async () => {
    // Instagram descarga el medio de una URL; ahí no hay alternativa, y por
    // eso la decisión es por capacidad del canal y no un `if` por nombre.
    const mediaAssetId = await medio('stored');
    const clave = `tenants/${tenantId}/media/${mediaAssetId}.jpg`;
    const base = await encolado();
    const ig = new AdaptadorSandbox({ canal: 'instagram' });
    const carga: CargaDeEnvio = {
      ...base,
      canal: 'instagram',
      peticion: { tipo: 'image', url: null, mediaAssetId },
    };
    const almacen = new AlmacenEnMemoria();
    await almacen.guardar(clave, Buffer.from('foto'), 'image/jpeg');
    const firmadas: string[] = [];
    const original = almacen.urlDeLectura.bind(almacen);
    almacen.urlDeLectura = async (c, ttl) => {
      firmadas.push(c);
      return original(c, ttl);
    };

    expect(
      await enviarMensajeSaliente(
        { pool: app, canales: new Map([['instagram', ig]]), almacen },
        tenantId,
        carga,
      ),
    ).toBe('enviado');
    expect(firmadas).toEqual([clave]);
    expect(ig.enviados[0]!.contenido).toMatchObject({ origen: 'url' });
  });

  it('medio no almacenado → failed, no reintentable', async () => {
    const mediaAssetId = await medio('pending');
    const base = await encolado();
    const carga: CargaDeEnvio = { ...base, peticion: { tipo: 'image', url: null, mediaAssetId } };
    expect(
      await enviarMensajeSaliente(
        { pool: app, canales: canales(), almacen: new AlmacenEnMemoria() },
        tenantId,
        carga,
      ),
    ).toBe('fallido');
    expect((await estadoDe(carga.messageId)).status).toBe('failed');
  });
});

describe('respuesta a comentario (Instagram)', () => {
  it('llega al canal por replyToComment con el modo pedido', async () => {
    const ig = new AdaptadorSandbox({ canal: 'instagram' });
    const base = await encolado('Gracias por escribir');
    const carga: CargaDeEnvio = {
      ...base,
      canal: 'instagram',
      peticion: {
        tipo: 'comment_reply',
        modo: 'privada',
        texto: 'Te escribo por privado',
        comentarioId: 'c.9',
      },
    };
    const r = await enviarMensajeSaliente(
      { pool: app, canales: new Map([['instagram', ig]]) },
      tenantId,
      carga,
    );
    expect(r).toBe('enviado');
    expect(ig.enviados[0]).toMatchObject({
      tipo: 'comentario',
      destino: 'c.9',
      contenido: { modo: 'privada', texto: 'Te escribo por privado' },
    });
  });

  it('en un canal sin comentarios el adaptador lo rechaza y el mensaje queda failed', async () => {
    const base = await encolado('x');
    const carga: CargaDeEnvio = {
      ...base,
      peticion: { tipo: 'comment_reply', modo: 'publica', texto: 'x', comentarioId: 'c.1' },
    };
    expect(await enviarMensajeSaliente({ pool: app, canales: canales() }, tenantId, carga)).toBe(
      'fallido',
    );
    expect((await estadoDe(carga.messageId)).status).toBe('failed');
  });
});
