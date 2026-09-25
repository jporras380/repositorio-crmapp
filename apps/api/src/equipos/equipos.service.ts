/**
 * Equipos: Recepción, Reservas, Mantenimiento.
 *
 * ## Por qué esto llega ahora y no en la fase 0
 *
 * Las tablas `teams` y `team_members` existen desde la migración 0002, con su
 * RLS y su unicidad por cuenta, y **no las escribía nadie**. No era un olvido
 * de una tarde: llevaban ahí desde el principio, y se quedaron sin API ni
 * pantalla mientras el producto crecía alrededor.
 *
 * Lo que las sacó de ahí fue PR-96: la visibilidad de la bandeja admite un
 * modo «por equipos» que **no se podía ofrecer**, porque sin equipos se
 * comporta como «solo las mías». Ofrecer una opción que no hace lo que dice
 * es peor que no ofrecerla, así que el modo se quedó fuera y esto es lo que
 * lo desbloquea.
 *
 * ## Las tres piezas, y por qué hacen falta las tres
 *
 * 1. **El equipo** existe y tiene nombre.
 * 2. **Las personas** pertenecen a él. Sin esto, la cláusula de visibilidad
 *    no encuentra los equipos de nadie.
 * 3. **La conversación** pertenece a uno. `conversations.team_id` también
 *    llevaba desde 0004 leyéndose y sin que nadie la escribiera: con equipos
 *    y miembros pero sin esto, el modo seguiría sin hacer nada.
 *
 * Con una sola de las tres, la funcionalidad es decorativa. Es la misma
 * familia de fallo que persigue `check-puertas.mjs`.
 *
 * ## Lo que NO hace
 *
 * Repartir solo por equipo. El reparto automático (0026) sigue mirando a la
 * persona con menos conversaciones abiertas, sin filtrar por equipo. Meterlo
 * aquí sería cambiar cómo se reparte el trabajo de un día para otro sin que
 * nadie lo haya pedido; cuando haga falta, el dato ya está.
 */
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface Equipo {
  id: string;
  nombre: string;
  miembros: { userId: string; nombre: string; rol: string }[];
  /** Conversaciones sin cerrar que lleva el equipo. Lo que dice si está vivo. */
  abiertas: number;
}

/** Un nombre corto y distinto: es lo que se elige en un desplegable. */
const LARGO_MAXIMO = 60;

export class EquiposService {
  readonly #db: BaseDeDatos;

  constructor(o: { db: BaseDeDatos }) {
    this.#db = o.db;
  }

  /**
   * Los equipos de la cuenta, con quién está en cada uno.
   *
   * Lo lee cualquiera del equipo: un agente necesita saber a qué equipo
   * mandar una conversación, y a cuál pertenece él.
   */
  async listar(): Promise<Equipo[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        name: string;
        abiertas: string;
      }>(
        `SELECT t.id, t.name,
                (SELECT count(*) FROM conversations cv
                  WHERE cv.team_id = t.id AND cv.status <> 'closed') AS abiertas
           FROM teams t
          ORDER BY t.name`,
      );

      // Una sola consulta para los miembros de todos los equipos: con cinco
      // equipos, una por equipo son cinco idas y vueltas para pintar una
      // pantalla que cabe en media página.
      const { rows: miembros } = await c.query<{
        team_id: string;
        user_id: string;
        full_name: string;
        role: string;
      }>(
        `SELECT tm.team_id, m.user_id, u.full_name, m.role
           FROM team_members tm
           JOIN memberships m ON m.id = tm.membership_id
           JOIN users u ON u.id = m.user_id
          ORDER BY u.full_name`,
      );

      return rows.map((t) => ({
        id: t.id,
        nombre: t.name,
        abiertas: Number(t.abiertas),
        miembros: miembros
          .filter((m) => m.team_id === t.id)
          .map((m) => ({ userId: m.user_id, nombre: m.full_name, rol: m.role })),
      }));
    });
  }

  async crear(nombre: string): Promise<Equipo[]> {
    const ctx = this.#exigirGestor();
    const limpio = this.#exigirNombre(nombre);
    await this.#db.enTransaccion(async (c) => {
      try {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id`,
          [ctx.tenantId, limpio],
        );
        await this.#auditar(c, ctx, 'equipo.creado', rows[0]!.id, { nombre: limpio });
      } catch (error) {
        throw this.#siYaExiste(error);
      }
    });
    return this.listar();
  }

  async renombrar(id: string, nombre: string): Promise<Equipo[]> {
    const ctx = this.#exigirGestor();
    const limpio = this.#exigirNombre(nombre);
    await this.#db.enTransaccion(async (c) => {
      try {
        const { rows } = await c.query<{ id: string }>(
          `UPDATE teams SET name = $2, updated_at = now() WHERE id = $1 RETURNING id`,
          [id, limpio],
        );
        if (rows.length === 0) {
          throw new ErrorDeNegocio('equipo_no_encontrado', 'Ese equipo no existe.', 404);
        }
        await this.#auditar(c, ctx, 'equipo.renombrado', id, { nombre: limpio });
      } catch (error) {
        throw this.#siYaExiste(error);
      }
    });
    return this.listar();
  }

  /**
   * Borra el equipo.
   *
   * Las conversaciones que llevaba **no se borran ni se cierran**: su
   * `team_id` queda a NULL por el `ON DELETE SET NULL` de 0004, así que pasan
   * a estar sin equipo y las sigue viendo todo el mundo. Perder trabajo en
   * curso por reorganizar el organigrama sería el peor cambio posible.
   */
  async borrar(id: string): Promise<Equipo[]> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ name: string }>(
        `DELETE FROM teams WHERE id = $1 RETURNING name`,
        [id],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio('equipo_no_encontrado', 'Ese equipo no existe.', 404);
      }
      await this.#auditar(c, ctx, 'equipo.borrado', id, { nombre: rows[0]!.name });
    });
    return this.listar();
  }

  /**
   * Mete o saca a una persona de un equipo.
   *
   * Un mismo agente puede estar en varios: en un hotel pequeño, quien atiende
   * recepción también lleva las reservas por la tarde. La cláusula de
   * visibilidad ya contempla varios equipos por persona.
   */
  async cambiarMiembro(equipoId: string, userId: string, dentro: boolean): Promise<Equipo[]> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      // La membresía, no el usuario: `team_members` cuelga de `memberships`
      // porque una persona puede estar en varias cuentas, y su pertenencia a
      // un equipo es de ESTA.
      const { rows: membresia } = await c.query<{ id: string }>(
        `SELECT id FROM memberships WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );
      if (membresia.length === 0) {
        throw new ErrorDeNegocio('persona_no_encontrada', 'Esa persona no está en la cuenta.', 404);
      }

      if (dentro) {
        // Idempotente: marcar dos veces la misma casilla no es un error que
        // merezca enseñarse a nadie.
        await c.query(
          `INSERT INTO team_members (tenant_id, team_id, membership_id)
           VALUES ($1, $2, $3) ON CONFLICT (team_id, membership_id) DO NOTHING`,
          [ctx.tenantId, equipoId, membresia[0]!.id],
        );
      } else {
        await c.query(`DELETE FROM team_members WHERE team_id = $1 AND membership_id = $2`, [
          equipoId,
          membresia[0]!.id,
        ]);
      }
      await this.#auditar(c, ctx, 'equipo.miembro', equipoId, { userId, dentro });
    });
    return this.listar();
  }

  #exigirNombre(nombre: string): string {
    const limpio = nombre.trim();
    if (!limpio || limpio.length > LARGO_MAXIMO) {
      throw new ErrorDeNegocio(
        'nombre_invalido',
        `El nombre del equipo va entre 1 y ${LARGO_MAXIMO} caracteres.`,
        422,
      );
    }
    return limpio;
  }

  /** El UNIQUE (tenant_id, name) de 0002, traducido a algo que se entienda. */
  #siYaExiste(error: unknown): unknown {
    if ((error as { code?: string }).code === '23505') {
      return new ErrorDeNegocio('equipo_repetido', 'Ya hay un equipo con ese nombre.', 409);
    }
    return error;
  }

  async #auditar(
    c: { query: (t: string, v: unknown[]) => Promise<unknown> },
    ctx: { tenantId: string; userId: string },
    accion: string,
    entidadId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, 'team', $4, $5)`,
      [ctx.tenantId, ctx.userId, accion, entidadId, JSON.stringify(meta)],
    );
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  /** Montar el organigrama es de quien responde por la cuenta. */
  #exigirGestor() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo el propietario o un administrador cambia los equipos.',
        403,
      );
    }
    return ctx;
  }
}
