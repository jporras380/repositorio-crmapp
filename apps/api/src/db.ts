/**
 * Acceso a base de datos con contexto de inquilino.
 *
 * ADR-005 dice que el aislamiento lo hace PostgreSQL con RLS, y que RLS
 * necesita `SET LOCAL app.tenant_id` en la misma transacción que la consulta.
 * Este archivo es lo que hace que eso ocurra **sin que ningún servicio tenga
 * que acordarse**.
 *
 * El inquilino viaja en un `AsyncLocalStorage` que establece el guard de
 * autenticación al validar el token. Los servicios llaman a `enTransaccion()`
 * y no reciben nunca el `tenantId` como parámetro: un parámetro se puede
 * olvidar, se puede pasar mal, y sobre todo se puede pasar el de otro.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { withTenant, withSystemTransaction } from '@crmapp/db';

export interface ContextoDePeticion {
  tenantId: string;
  userId: string;
  rol: 'owner' | 'admin' | 'supervisor' | 'agent';
  correlationId: string;
}

const almacen = new AsyncLocalStorage<ContextoDePeticion>();

export function ejecutarConContexto<T>(ctx: ContextoDePeticion, fn: () => T): T {
  return almacen.run(ctx, fn);
}

export function contextoActual(): ContextoDePeticion | undefined {
  return almacen.getStore();
}

export class SinContextoDeInquilino extends Error {
  constructor() {
    super(
      'No hay inquilino en el contexto. Toda consulta de datos de inquilino ' +
        'debe ejecutarse dentro de enTransaccion(), y el contexto lo establece ' +
        'el guard de autenticación.',
    );
    this.name = 'SinContextoDeInquilino';
  }
}

export class BaseDeDatos implements OnModuleDestroy {
  /**
   * @param pool        rol de aplicacion, sujeto a RLS por inquilino.
   * @param poolAuth    rol `crmapp_auth`, SOLO LECTURA sobre tablas de
   *                    identidad (migracion 0008). Para iniciar sesion y
   *                    aceptar invitaciones, que no pueden saber el inquilino
   *                    antes de consultar. Si no se pasa, se usa el de
   *                    aplicacion: en ese caso esas operaciones no veran nada,
   *                    que es preferible a verlo todo.
   */
  readonly poolAuth: Pool;

  constructor(
    readonly pool: Pool,
    poolAuth?: Pool,
  ) {
    this.poolAuth = poolAuth ?? pool;
  }

  /**
   * Transacción con el inquilino del contexto ya establecido.
   *
   * Lanza si no hay contexto en vez de consultar sin él. Sin RLS eso sería una
   * fuga; con RLS devolvería cero filas, que es un bug más difícil de
   * diagnosticar que una excepción clara.
   */
  async enTransaccion<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = contextoActual();
    if (!ctx) throw new SinContextoDeInquilino();
    return withTenant(this.pool, ctx.tenantId, fn);
  }

  /** Transacción para un inquilino concreto, sin depender del contexto. */
  async paraInquilino<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenant(this.pool, tenantId, fn);
  }

  /**
   * Lectura de identidad sin inquilino, con el rol `crmapp_auth`.
   *
   * Solo para iniciar sesion y aceptar invitaciones. El rol no puede escribir,
   * asi que aunque este camino se use mal, el dano posible es enumerar
   * usuarios, no modificarlos.
   */
  async deAutenticacion<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withSystemTransaction(this.poolAuth, fn);
  }

  /**
   * Crea un inquilino nuevo dentro de su propio contexto.
   *
   * El truco que evita un escape: se pide el identificador a la base ANTES de
   * abrir la transaccion de negocio, se pone en `app.tenant_id`, y a partir de
   * ahi el alta corre bajo RLS como cualquier otra operacion. La politica de
   * `tenants` compara `id` con el inquilino actual, asi que la insercion pasa.
   */
  async creandoInquilino<T>(fn: (client: PoolClient, tenantId: string) => Promise<T>): Promise<T> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT uuidv7() AS id');
    const tenantId = rows[0]!.id;
    return withTenant(this.pool, tenantId, (c) => fn(c, tenantId));
  }

  /**
   * Identificador nuevo pedido a la base.
   *
   * Existe por un comportamiento de PostgreSQL que sorprende: `INSERT ...
   * RETURNING` aplica la politica de SELECT a la fila devuelta, y si esa fila
   * todavia no cumple la politica —un usuario recien creado no tiene aun
   * membresia— la insercion falla. Peor: el error que da es el de WITH CHECK,
   * "new row violates row-level security policy", que apunta al sitio
   * equivocado.
   *
   * La salida limpia es pedir el identificador antes e insertar sin RETURNING,
   * en vez de ensanchar la politica de lectura para que un usuario se vea a si
   * mismo desde cualquier inquilino.
   */
  async nuevoId(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ id: string }>('SELECT uuidv7() AS id');
    return rows[0]!.id;
  }

  async cerrar(): Promise<void> {
    await this.pool.end();
    if (this.poolAuth !== this.pool) await this.poolAuth.end();
  }

  /**
   * Cierre ordenado. Sin este hook, NestJS nunca cierra los pools: el proceso
   * se queda con conexiones abiertas al apagarse, y PostgreSQL las mantiene
   * hasta que caducan. En los tests se nota enseguida —el DROP DATABASE mata
   * conexiones vivas y el runner reporta el error—, en produccion se nota
   * cuando se acaban las conexiones tras varios despliegues.
   */
  async onModuleDestroy(): Promise<void> {
    await this.cerrar();
  }
}
