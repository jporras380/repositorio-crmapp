/**
 * Tests del relay del outbox.
 *
 * Van contra PostgreSQL real porque lo que se prueba —`FOR UPDATE SKIP
 * LOCKED`, aislamiento transaccional, la política del rol del relay— no existe
 * fuera de la base. Con un doble de prueba, estos tests pasarían siempre y no
 * dirían nada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrar, reintentandoSiChocaElCatalogo } from '@crmapp/db';
import { escribirEnOutbox, procesarVuelta, type EventoDeOutbox } from '../src/outbox.js';

const HOST = process.env['TEST_PG_HOST'] ?? 'localhost';
const PORT = process.env['TEST_PG_PORT'] ?? '55432';
const SU = process.env['TEST_PG_SUPERUSER'] ?? 'crmapp';
const PASS = process.env['TEST_PG_SUPERPASS'] ?? 'crmapp_dev';
const DB = 'crmapp_test_outbox';
const CLAVE_APP = 'crmapp_dev';
const CLAVE_RELAY = 'crmapp_dev';

const url = (db: string, usuario = SU, clave = PASS) =>
  `postgres://${usuario}:${clave}@${HOST}:${PORT}/${db}`;

let admin: Pool;
let app: Pool;
let relay: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.query(`CREATE DATABASE ${DB}`);
  await su.end();

  await migrar(url(DB));

  const conf = new Client({ connectionString: url(DB) });
  await conf.connect();
  // `ALTER ROLE` toca un catálogo del CLÚSTER, no de esta base: en CI corren
  // varias suites a la vez y todas ponen las mismas contraseñas, así que dos
  // pueden pisarse. Reintentar es la respuesta correcta — poner dos veces la
  // misma contraseña deja lo mismo.
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${CLAVE_APP}'`),
  );
  await reintentandoSiChocaElCatalogo(() =>
    conf.query(`ALTER ROLE crmapp_relay LOGIN PASSWORD '${CLAVE_RELAY}'`),
  );
  await conf.query(`GRANT CONNECT ON DATABASE ${DB} TO crmapp_app, crmapp_relay`);
  const { rows } = await conf.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ('A', 'a'), ('B', 'b') RETURNING id`,
  );
  tenantA = rows[0]!.id;
  tenantB = rows[1]!.id;
  await conf.end();

  admin = new Pool({ connectionString: url(DB) });
  app = new Pool({ connectionString: url(DB, 'crmapp_app', CLAVE_APP) });
  relay = new Pool({ connectionString: url(DB, 'crmapp_relay', CLAVE_RELAY) });
});

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end(), relay?.end()]);
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await su.end();
});

beforeEach(async () => {
  await admin.query('TRUNCATE outbox');
});

/** Escribe un evento como lo haría la aplicación: dentro de su transacción. */
async function emitir(tenantId: string, eventType = 'usuario.invitado'): Promise<void> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await escribirEnOutbox(client, {
      tenantId,
      aggregateType: 'invitation',
      aggregateId: '00000000-0000-7000-8000-000000000001',
      eventType,
      payload: { para: 'ana@ejemplo.com' },
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

describe('el relay ve todos los inquilinos y la aplicación no', () => {
  it('la aplicación solo ve su propio outbox', async () => {
    await emitir(tenantA);
    await emitir(tenantB);

    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantA}'`);
      const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox');
      await client.query('COMMIT');
      expect(rows[0]!.n).toBe(1);
    } finally {
      client.release();
    }
  });

  it('el relay ve los dos', async () => {
    // Sin la política `relay_todo` de la migración 0006, esto devolvería 0. Y
    // lo peligroso es que no fallaría: el relay se quedaría publicando cero
    // eventos en silencio, que es el modo de fallo más caro de este sistema.
    await emitir(tenantA);
    await emitir(tenantB);
    const { rows } = await relay.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox');
    expect(rows[0]!.n).toBe(2);
  });

  it('el relay no puede insertar ni borrar', async () => {
    // Publica y marca; nunca crea ni destruye eventos. Quien escribe es la
    // transacción de negocio.
    await expect(
      relay.query(
        `INSERT INTO outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, 'x', $1, 'y', '{}')`,
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/i);

    await emitir(tenantA);
    await expect(relay.query('DELETE FROM outbox')).rejects.toThrow(/permission denied/i);
  });
});

describe('publicación', () => {
  it('publica lo pendiente y lo marca', async () => {
    await emitir(tenantA);
    await emitir(tenantB);

    const publicados: EventoDeOutbox[] = [];
    const r = await procesarVuelta({
      pool: relay,
      publicar: async (e) => {
        publicados.push(e);
      },
    });

    expect(r).toEqual({ publicados: 2, fallidos: 0 });
    expect(publicados.map((e) => e.tenantId).sort()).toEqual([tenantA, tenantB].sort());

    const { rows } = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('no republica lo ya publicado', async () => {
    await emitir(tenantA);
    let veces = 0;
    const publicar = async () => {
      veces += 1;
    };

    await procesarVuelta({ pool: relay, publicar });
    await procesarVuelta({ pool: relay, publicar });
    expect(veces).toBe(1);
  });

  it('respeta el orden de creación', async () => {
    // Los eventos de una misma entidad tienen que llegar en orden: "creada"
    // antes que "actualizada".
    for (const tipo of ['primero', 'segundo', 'tercero']) await emitir(tenantA, tipo);

    const vistos: string[] = [];
    await procesarVuelta({
      pool: relay,
      publicar: async (e) => {
        vistos.push(e.eventType);
      },
    });
    expect(vistos).toEqual(['primero', 'segundo', 'tercero']);
  });
});

describe('fallos', () => {
  it('un evento que falla no arrastra al resto del lote', async () => {
    await emitir(tenantA, 'malo');
    await emitir(tenantA, 'bueno');

    const r = await procesarVuelta({
      pool: relay,
      publicar: async (e) => {
        if (e.eventType === 'malo') throw new Error('la cola no responde');
      },
    });

    expect(r).toEqual({ publicados: 1, fallidos: 1 });

    const { rows } = await admin.query<{
      event_type: string;
      attempts: number;
      last_error: string | null;
      publicado: boolean;
    }>(`SELECT event_type, attempts, last_error, (published_at IS NOT NULL) AS publicado
          FROM outbox ORDER BY event_type`);

    expect(rows.find((r) => r.event_type === 'bueno')?.publicado).toBe(true);
    const malo = rows.find((r) => r.event_type === 'malo')!;
    expect(malo.publicado).toBe(false);
    expect(malo.attempts).toBe(1);
    expect(malo.last_error).toContain('la cola no responde');
  });

  it('deja de reintentar al llegar al máximo', async () => {
    // Un evento envenenado no puede bloquear la cola para siempre ni consumir
    // capacidad indefinidamente. Queda en la tabla para poder diagnosticarlo.
    await emitir(tenantA, 'envenenado');
    const publicar = async () => {
      throw new Error('siempre falla');
    };

    for (let i = 0; i < 4; i++) {
      await procesarVuelta({ pool: relay, publicar, intentosMaximos: 3 });
    }

    const { rows } = await admin.query<{ attempts: number }>(
      'SELECT attempts FROM outbox WHERE event_type = $1',
      ['envenenado'],
    );
    expect(rows[0]!.attempts).toBe(3);
  });
});

describe('varias instancias del relay a la vez', () => {
  it('SKIP LOCKED evita que dos relays publiquen el mismo evento', async () => {
    // Es la propiedad que permite escalar el relay horizontalmente. Sin
    // SKIP LOCKED, la segunda instancia se bloquearía esperando a la primera
    // y no aportaría nada.
    for (let i = 0; i < 20; i++) await emitir(tenantA, `evento-${i}`);

    const vistosPorA: string[] = [];
    const vistosPorB: string[] = [];
    const lento = async (destino: string[], e: EventoDeOutbox) => {
      await new Promise((r) => setTimeout(r, 5));
      destino.push(e.eventType);
    };

    await Promise.all([
      procesarVuelta({ pool: relay, lote: 10, publicar: (e) => lento(vistosPorA, e) }),
      procesarVuelta({ pool: relay, lote: 10, publicar: (e) => lento(vistosPorB, e) }),
    ]);

    const todos = [...vistosPorA, ...vistosPorB];
    // Ninguno se publicó dos veces...
    expect(new Set(todos).size).toBe(todos.length);
    // ...y entre las dos instancias se hizo todo el trabajo.
    expect(todos).toHaveLength(20);
  });
});

describe('la firma de escribirEnOutbox obliga a usar la transacción', () => {
  it('el evento no existe si la transacción hace rollback', async () => {
    // La razón de ser del patrón: el evento vive o muere con el cambio de
    // negocio. Si se publicara fuera de la transacción, un rollback dejaría un
    // evento anunciando algo que nunca ocurrió.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantA}'`);
      await escribirEnOutbox(client, {
        tenantId: tenantA,
        aggregateType: 'invitation',
        aggregateId: '00000000-0000-7000-8000-000000000002',
        eventType: 'nunca.ocurrio',
        payload: {},
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox');
    expect(rows[0]!.n).toBe(0);
  });
});
