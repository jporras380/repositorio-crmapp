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
