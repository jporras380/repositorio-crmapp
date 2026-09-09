/**
 * Cliente de base de datos y el único camino legítimo para consultar datos de
 * un inquilino.
 *
 * ADR-005: el aislamiento lo hace PostgreSQL con RLS, y RLS necesita saber de
 * quién es la transacción. Ese dato viaja en un GUC de sesión que se establece
 * con SET LOCAL, y `SET LOCAL` solo dura lo que dura la transacción.
 *
 * De ahí la forma de `withTenant`: no hay manera de establecer el inquilino
 * sin abrir una transacción, porque hacerlo fuera de una sería exactamente el
 * bug que buscamos evitar — con pooler en modo transacción, un `SET` a secas
 * se filtra a la siguiente petición que reciba esa conexión.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export interface OpcionesDePool extends PoolConfig {
  connectionString: string;
}

export function crearPool(opciones: OpcionesDePool): Pool {
  return new Pool(opciones);
}

/** Error que se lanza cuando el identificador de inquilino no es un UUID. */
export class TenantIdInvalido extends Error {
  constructor(valor: string) {
    super(`tenant_id no es un UUID válido: ${JSON.stringify(valor)}`);
    this.name = 'TenantIdInvalido';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ejecuta `fn` dentro de una transacción con `app.tenant_id` establecido.
 *
 * El identificador se valida antes de interpolarlo. No es paranoia decorativa:
 * `SET LOCAL` no admite parámetros vinculados ($1), así que el valor tiene que
 * ir en el texto de la sentencia. Validar contra el formato UUID es lo que
 * impide que ese hueco sea una inyección.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new TenantIdInvalido(tenantId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* la conexión ya puede estar rota; el error original importa más */
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transacción SIN inquilino, para trabajo de sistema: el relay del outbox, la
 * ingesta antes de resolver a qué cuenta pertenece un webhook, los jobs de
 * mantenimiento.
 *
 * Existe con nombre explícito y feo a propósito. Si el escape para saltarse el
 * aislamiento no tiene nombre, alguien lo improvisa con `pool.query` directo y
 * nadie se entera; con nombre, sale en cualquier búsqueda y en cualquier
 * revisión.
 *
 * Requiere un rol con BYPASSRLS o dueño de las tablas. El rol de aplicación no
 * lo es, así que llamarla con el pool de la aplicación no salta el aislamiento:
 * simplemente no ve nada.
 */
export async function withSystemTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
