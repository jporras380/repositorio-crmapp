/**
 * Retención: las dos tablas que crecían para siempre (0047).
 *
 * `message_keys` tenía su política escrita desde 0004 y su índice creado para
 * aplicarla; `outbox` ni eso, y ahí es donde el token de invitación en claro
 * (0046) pasó días esperando a que alguien limpiara.
 *
 * Lo que más importa aquí no es que borre, sino **lo que NO borra**: un evento
 * sin publicar es trabajo sin entregar, y uno que agotó sus intentos es la
 * única pista de qué falló. Esos dos tests son la razón de que la condición
 * viva en una función de la base y no en el worker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { poolAdmin, prepararBaseDeDatos, sembrarInquilino } from './setup.js';

const DB = 'crmapp_test_retencion';

let admin: Pool;
let inquilino: Awaited<ReturnType<typeof sembrarInquilino>>;

beforeAll(async () => {
  await prepararBaseDeDatos(DB);
  admin = poolAdmin(DB);
  inquilino = await sembrarInquilino(admin, 'Retención');
});

afterAll(async () => {
  await admin?.end();
});

/** Un evento del outbox con la edad y el estado que se quiera. */
async function evento(o: {
  tipo: string;
  diasDeEdad: number;
  publicado: boolean;
  intentos?: number;
}): Promise<void> {
  await admin.query(
    `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type,
                         payload, attempts, published_at, created_at)
     VALUES ($1, 'prueba', $1, $2, '{}'::jsonb, $3,
             CASE WHEN $4 THEN now() - ($5 || ' days')::interval END,
             now() - ($5 || ' days')::interval)`,
    [inquilino.tenantId, o.tipo, o.intentos ?? 0, o.publicado, String(o.diasDeEdad)],
  );
}

const tipos = async (): Promise<string[]> =>
  (
    await admin.query<{ event_type: string }>(`SELECT event_type FROM outbox ORDER BY event_type`)
  ).rows.map((r) => r.event_type);

describe('purga del outbox', () => {
  it('borra lo publicado y viejo, y deja lo reciente', async () => {
    await evento({ tipo: 'vieja.publicada', diasDeEdad: 60, publicado: true });
    await evento({ tipo: 'reciente.publicada', diasDeEdad: 2, publicado: true });

    const { rows } = await admin.query<{ purgar_outbox: string }>('SELECT app.purgar_outbox(30)');
    expect(Number(rows[0]!.purgar_outbox)).toBe(1);
    expect(await tipos()).toEqual(['reciente.publicada']);

    await admin.query('DELETE FROM outbox');
  });

  it('NUNCA borra un evento sin publicar, por viejo que sea', async () => {
    // Es trabajo sin entregar: un mensaje que un cliente cree enviado.
    await evento({ tipo: 'vieja.pendiente', diasDeEdad: 400, publicado: false });

    const { rows } = await admin.query<{ purgar_outbox: string }>('SELECT app.purgar_outbox(30)');
    expect(Number(rows[0]!.purgar_outbox)).toBe(0);
    expect(await tipos()).toEqual(['vieja.pendiente']);

    await admin.query('DELETE FROM outbox');
  });

  it('NUNCA borra una carta muerta: es lo único que dice qué falló', async () => {
    // Agotó los intentos y nunca se publicó. Borrarla es tapar el fallo.
    await evento({ tipo: 'carta.muerta', diasDeEdad: 400, publicado: false, intentos: 10 });

    await admin.query('SELECT app.purgar_outbox(30)');
    expect(await tipos()).toEqual(['carta.muerta']);

    await admin.query('DELETE FROM outbox');
  });

  it('se niega a una retención por debajo de 7 días', async () => {
    // El suelo vive en la función y no en quien la llama: así no se baja
    // cambiando un número en el worker.
    await expect(admin.query('SELECT app.purgar_outbox(3)')).rejects.toThrow(/no baja de 7/);
  });

  it('el lote acota la primera pasada sobre una tabla atrasada', async () => {
    for (let i = 0; i < 5; i++) {
      await evento({ tipo: `lote.${i}`, diasDeEdad: 60, publicado: true });
    }
    const { rows } = await admin.query<{ purgar_outbox: string }>(
      'SELECT app.purgar_outbox(30, 2)',
    );
    // Lo que no cabe hoy lo termina mañana, sin bloquear la ingesta.
    expect(Number(rows[0]!.purgar_outbox)).toBe(2);
    expect(await tipos()).toHaveLength(3);

    await admin.query('DELETE FROM outbox');
  });
});

describe('purga de las claves de idempotencia', () => {
  async function clave(externalId: string, diasDeEdad: number): Promise<void> {
    await admin.query(
      `INSERT INTO message_keys (tenant_id, channel_account_id, external_message_id,
                                 message_id, message_created_at, created_at)
       VALUES ($1, $2, $3, gen_random_uuid(), now(), now() - ($4 || ' days')::interval)`,
      [inquilino.tenantId, inquilino.channelAccountId, externalId, String(diasDeEdad)],
    );
  }

  it('aplica por fin la política que 0004 dejó escrita', async () => {
    await clave('vieja', 120);
    await clave('reciente', 10);

    const { rows } = await admin.query<{ purgar_message_keys: string }>(
      'SELECT app.purgar_message_keys(90)',
    );
    expect(Number(rows[0]!.purgar_message_keys)).toBe(1);

    const quedan = await admin.query<{ external_message_id: string }>(
      'SELECT external_message_id FROM message_keys',
    );
    expect(quedan.rows.map((r) => r.external_message_id)).toEqual(['reciente']);
  });

  it('se niega a bajar de 90 días: un reenvío tardío sería un mensaje duplicado', async () => {
    // Es la consecuencia que justifica el suelo: no es una preferencia de
    // almacenamiento, es un huésped recibiendo dos veces lo mismo.
    await expect(admin.query('SELECT app.purgar_message_keys(30)')).rejects.toThrow(
      /no baja de 90/,
    );
  });
});

/**
 * Cuánto tiempo guarda el hotel sus mensajes (0052).
 *
 * Igual que arriba, lo que más importa es lo que NO borra: nada si el hotel
 * no lo pidió, y ningún archivo que otra cosa siga usando —una boleta, una
 * foto de perfil, otro mensaje—. Esas referencias son `ON DELETE SET NULL` o
 * blandas: si se escaparan, el fallo no daría error, dejaría la boleta en
 * blanco.
 */
describe('retención de mensajes', () => {
  let otra: Awaited<ReturnType<typeof sembrarInquilino>>;

  beforeAll(async () => {
    otra = await sembrarInquilino(admin, 'SinAjuste');
  });

  /** Un mensaje de hace `meses`, con su partición creada si hace falta. */
  async function mensaje(
    i: Awaited<ReturnType<typeof sembrarInquilino>>,
    meses: number,
    texto: string,
    medio: string | null = null,
  ): Promise<void> {
    await admin.query(
      `SELECT app.ensure_partition('public.messages',
                                   date_trunc('month', now() - make_interval(months => $1))::date)`,
      [meses],
    );
    await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type,
                             body, media_asset_id, created_at)
       VALUES ($1, $2, $3, 'inbound', 'text', $4, $5,
               now() - make_interval(months => $6) - interval '1 day')`,
      [i.tenantId, i.conversationId, i.channelAccountId, texto, medio, meses],
    );
  }

  async function medio(clave: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO media_assets (tenant_id, kind, status, mime, storage_key, thumb_key)
       VALUES ($1, 'image', 'stored', 'image/jpeg', $2, $3) RETURNING id`,
      [inquilino.tenantId, clave, `${clave}.thumb`],
    );
    return rows[0]!.id;
  }

  const textos = async (tenantId: string): Promise<string[]> =>
    (
      await admin.query<{ body: string }>(
        `SELECT body FROM messages WHERE tenant_id = $1 ORDER BY body`,
        [tenantId],
      )
    ).rows.map((r) => r.body);

  const purgar = async () =>
    (
      await admin.query<{ inquilino: string; mensajes: string; claves: string[] }>(
        'SELECT * FROM app.purgar_mensajes_antiguos(5000)',
      )
    ).rows;

  it('sin ajuste —lo de siempre— no borra nada, por viejo que sea', async () => {
    await mensaje(inquilino, 30, 'de hace 30 meses');
    expect(await purgar()).toEqual([]);
    expect(await textos(inquilino.tenantId)).toContain('de hace 30 meses');
  });

  it('el plazo no baja de un año', async () => {
    await expect(
      admin.query(`UPDATE tenants SET message_retention_months = 6 WHERE id = $1`, [
        inquilino.tenantId,
      ]),
    ).rejects.toThrow(/check/i);
  });

  it('borra lo viejo y sus archivos, y NUNCA un archivo que otra cosa usa', async () => {
    const soloSuyo = await medio('solo-suyo.jpg');
    const compartido = await medio('compartido.jpg');
    const boleta = await medio('boleta.pdf');
    const avatar = await medio('avatar.jpg');

    await mensaje(inquilino, 30, 'viejo con foto suya', soloSuyo);
    await mensaje(inquilino, 30, 'viejo con foto compartida', compartido);
    await mensaje(inquilino, 1, 'reciente con la misma foto', compartido);
    await mensaje(inquilino, 30, 'viejo con la boleta', boleta);
    await mensaje(inquilino, 30, 'viejo con el avatar', avatar);
    await admin.query(
      `INSERT INTO subscription_payments (tenant_id, amount_cents, currency, covers_from, covers_to,
                                          method, receipt_media_id)
       VALUES ($1, 2500, 'USD', now() - interval '1 month', now(), 'transferencia', $2)`,
      [inquilino.tenantId, boleta],
    );
    await admin.query(
      `INSERT INTO users (email, full_name, avatar_media_id) VALUES ('foto@test', 'Foto', $1)`,
      [avatar],
    );
    await mensaje(otra, 30, 'de otra cuenta, sin ajuste');

    await admin.query(`UPDATE tenants SET message_retention_months = 24 WHERE id = $1`, [
      inquilino.tenantId,
    ]);
    const r = await purgar();

    // Solo la cuenta que lo pidió.
    expect(r.map((x) => x.inquilino)).toEqual([inquilino.tenantId]);
    expect(await textos(otra.tenantId)).toContain('de otra cuenta, sin ajuste');

    // Lo de hace 30 meses se va; lo del mes pasado, y lo que sembró
    // `sembrarInquilino` hoy, se queda.
    const quedan = await textos(inquilino.tenantId);
    expect(quedan).toContain('reciente con la misma foto');
    expect(quedan.some((t) => t.startsWith('viejo'))).toBe(false);
    expect(quedan).not.toContain('de hace 30 meses');

    // Del almacén, solo el archivo que nada más usaba, con su miniatura.
    expect(r[0]!.claves.sort()).toEqual(['solo-suyo.jpg', 'solo-suyo.jpg.thumb']);
    const { rows: siguen } = await admin.query<{ id: string }>(
      `SELECT id FROM media_assets WHERE id = ANY($1)`,
      [[soloSuyo, compartido, boleta, avatar]],
    );
    expect(siguen.map((x) => x.id).sort()).toEqual([compartido, boleta, avatar].sort());

    // Y la boleta del cliente sigue enganchada a su pago.
    const { rows: pago } = await admin.query<{ receipt_media_id: string | null }>(
      `SELECT receipt_media_id FROM subscription_payments WHERE tenant_id = $1`,
      [inquilino.tenantId],
    );
    expect(pago[0]!.receipt_media_id).toBe(boleta);
  });

  it('deja rastro: cuántos mensajes y archivos, y con qué plazo', async () => {
    const { rows } = await admin.query<{
      meta: { mensajes: number; archivos: number; meses: number };
    }>(
      `SELECT meta FROM audit_log
        WHERE tenant_id = $1 AND action = 'retencion.mensajes_borrados'`,
      [inquilino.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ mensajes: 5, archivos: 2, meses: 24 });
  });

  it('toda columna que apunta a un archivo la tiene en cuenta la función', async () => {
    // Una tabla nueva con archivos no puede entrar sin que alguien decida qué
    // hace la retención con ella. La lista sale del catálogo, no de memoria.
    const { rows: columnas } = await admin.query<{ tabla: string; columna: string }>(
      `SELECT c.relname AS tabla, a.attname AS columna
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped
          AND a.attname ILIKE '%media%' AND c.relname <> 'media_assets'`,
    );
    const { rows: def } = await admin.query<{ d: string }>(
      `SELECT pg_get_functiondef('app.purgar_mensajes_antiguos(int)'::regprocedure) AS d`,
    );
    expect(columnas.length).toBeGreaterThanOrEqual(6);
    const faltan = columnas.filter(
      (x) => !def[0]!.d.includes(`FROM ${x.tabla} x WHERE x.${x.columna} = a.id`),
    );
    expect(faltan).toEqual([]);
  });
});
