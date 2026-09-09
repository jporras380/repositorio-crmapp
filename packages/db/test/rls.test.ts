/**
 * Los dos tests de RLS que el ARCH §6 exige como criterio de salida de fase 0.
 *
 * Sin ellos, ADR-005 es una promesa. Con ellos, es un mecanismo.
 *
 * Todas las comprobaciones de aislamiento se hacen con el rol `crmapp_app`,
 * que no es superusuario ni dueño de las tablas. No es un detalle: un
 * superusuario se salta RLS por completo, incluso con FORCE, así que un test
 * escrito con el rol de administrador pasaría siempre y no probaría nada.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { poolAdmin, poolApp, prepararBaseDeDatos, sembrarInquilino } from './setup.js';

// Base propia por archivo de test. Compartirla hacía que el DROP DATABASE
// ... WITH (FORCE) de un archivo matara las conexiones de otro.
const DB = 'crmapp_test_rls';
import { withTenant, withSystemTransaction, TenantIdInvalido } from '../src/client.js';

let admin: Pool;
let app: Pool;
let alfa: Awaited<ReturnType<typeof sembrarInquilino>>;
let beta: Awaited<ReturnType<typeof sembrarInquilino>>;

beforeAll(async () => {
  await prepararBaseDeDatos(DB);
  admin = poolAdmin(DB);
  app = poolApp(DB);
  alfa = await sembrarInquilino(admin, 'Alfa');
  beta = await sembrarInquilino(admin, 'Beta');
});

afterAll(async () => {
  await admin?.end();
  await app?.end();
});

/**
 * Test 1 · Catálogo.
 *
 * El que protege contra la tabla que alguien añade en el mes cuatro sin
 * acordarse de la política. Recorre pg_class en lugar de una lista escrita a
 * mano justamente porque una lista a mano también hay que acordarse de
 * actualizarla.
 */
describe('catálogo: toda tabla lleva RLS activada y forzada', () => {
  // Cada excepción necesita justificarse aquí. Añadir una es una decisión
  // consciente, que es el punto.
  const EXCEPCIONES = new Set([
    // Control del propio runner de migraciones. No contiene datos de
    // inquilinos y el rol de aplicación no tiene permisos sobre ella.
    'schema_migrations',
  ]);

  it('no hay tablas sin RLS', async () => {
    const { rows } = await admin.query<{
      tabla: string;
      habilitada: boolean;
      forzada: boolean;
      politicas: number;
    }>(`
      SELECT c.relname                              AS tabla,
             c.relrowsecurity                       AS habilitada,
             c.relforcerowsecurity                  AS forzada,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS politicas
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
       ORDER BY c.relname
    `);

    expect(rows.length).toBeGreaterThan(15);

    const incumplen = rows
      .filter((r) => !EXCEPCIONES.has(r.tabla))
      .filter((r) => !r.habilitada || !r.forzada || r.politicas === 0)
      .map(
        (r) =>
          `${r.tabla} (habilitada=${r.habilitada} forzada=${r.forzada} políticas=${r.politicas})`,
      );

    expect(incumplen).toEqual([]);
  });

  it('las particiones también, no solo el padre', async () => {
    // Consultar una partición directamente aplica solo SUS políticas, no las
    // del padre. Sin esto, `SELECT * FROM messages_2026_09` se saltaría el
    // aislamiento. Es la diferencia entre una garantía real y una nominal.
    const { rows } = await admin.query<{ tabla: string; habilitada: boolean; forzada: boolean }>(`
      SELECT c.relname AS tabla, c.relrowsecurity AS habilitada, c.relforcerowsecurity AS forzada
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relispartition
         -- Los indices de una tabla particionada tambien llevan
         -- relispartition = true, y un indice no tiene relrowsecurity.
         -- Sin este filtro el test cuenta indices y falla siempre.
         AND c.relkind IN ('r', 'p')
    `);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.habilitada || !r.forzada)).toEqual([]);
  });
});

/**
 * Test 2 · Aislamiento efectivo.
 */
describe('aislamiento entre inquilinos', () => {
  it('sin app.tenant_id no se ve absolutamente nada', async () => {
    // El caso que más importa: una consulta que se escapó del interceptor no
    // devuelve datos de todos, devuelve cero. Fallar cerrado.
    const client = await app.connect();
    try {
      for (const tabla of ['conversations', 'messages', 'contacts', 'channel_accounts']) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${tabla}`);
        expect(rows[0].n, `${tabla} filtró filas sin GUC`).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it('cada inquilino ve lo suyo y solo lo suyo', async () => {
    const deAlfa = await withTenant(app, alfa.tenantId, async (c) => {
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM conversations');
      return rows[0]!.n;
    });
    expect(deAlfa).toBe(1);

    const conversacionesVisibles = await withTenant(app, alfa.tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM conversations');
      return rows.map((r) => r.id);
    });
    expect(conversacionesVisibles).toEqual([alfa.conversationId]);
    expect(conversacionesVisibles).not.toContain(beta.conversationId);
  });

  it('el id ajeno tampoco funciona pidiéndolo directamente', async () => {
    const encontrado = await withTenant(app, alfa.tenantId, async (c) => {
      const { rows } = await c.query('SELECT id FROM conversations WHERE id = $1', [
        beta.conversationId,
      ]);
      return rows.length;
    });
    expect(encontrado).toBe(0);
  });

  it('WITH CHECK impide escribir con el tenant_id de otro', async () => {
    // Sin WITH CHECK, USING solo filtra lecturas y un inquilino podría
    // insertar filas a nombre de otro. Es el error clásico de RLS.
    await expect(
      withTenant(app, alfa.tenantId, async (c) => {
        await c.query(`INSERT INTO contacts (tenant_id, display_name) VALUES ($1, 'intruso')`, [
          beta.tenantId,
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('consultar la partición directamente tampoco se salta el aislamiento', async () => {
    const { rows: particiones } = await admin.query<{ nombre: string }>(`
      SELECT c.relname AS nombre
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'messages'
       LIMIT 1
    `);
    const particion = particiones[0]!.nombre;

    const visibles = await withTenant(app, alfa.tenantId, async (c) => {
      const { rows } = await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${particion}`);
      return rows.map((r) => r.tenant_id);
    });

    expect(visibles.every((t) => t === alfa.tenantId)).toBe(true);
    expect(visibles).not.toContain(beta.tenantId);
  });

  it('el GUC no sobrevive a la transacción', async () => {
    // SET LOCAL y no SET. Con pooler en modo transacción, un SET a secas se
    // filtraría a la siguiente petición que reciba esta conexión.
    await withTenant(app, alfa.tenantId, async (c) => {
      const { rows } = await c.query<{ v: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS v`,
      );
      expect(rows[0]!.v).toBe(alfa.tenantId);
    });

    const despues = await withSystemTransaction(app, async (c) => {
      const { rows } = await c.query<{ v: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS v`,
      );
      return rows[0]!.v;
    });
    expect(despues === null || despues === '').toBe(true);
  });

  it('un tenant_id que no es UUID se rechaza antes de llegar a la base', async () => {
    // SET LOCAL no admite parámetros vinculados, así que el valor va en el
    // texto de la sentencia. La validación es lo que impide que ese hueco sea
    // una inyección.
    await expect(
      withTenant(app, "' ; DROP TABLE tenants; --", async () => undefined),
    ).rejects.toBeInstanceOf(TenantIdInvalido);

    const { rows } = await admin.query(`SELECT to_regclass('public.tenants') AS t`);
    expect(rows[0].t).toBe('tenants');
  });
});

describe('auditoría', () => {
  it('la aplicación puede insertar pero no reescribir', async () => {
    // Un registro de auditoría que la aplicación puede modificar no es
    // auditoría. Se resuelve por permisos, no por política.
    await withTenant(app, alfa.tenantId, async (c) => {
      await c.query(
        `INSERT INTO audit_log (tenant_id, action, entity_type) VALUES ($1, 'test', 'conversation')`,
        [alfa.tenantId],
      );
    });

    await expect(
      withTenant(app, alfa.tenantId, async (c) => {
        await c.query(`UPDATE audit_log SET action = 'falsificado'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(app, alfa.tenantId, async (c) => {
        await c.query(`DELETE FROM audit_log`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
