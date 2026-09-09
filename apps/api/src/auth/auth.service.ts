/**
 * Alta de cuenta, inicio de sesión e invitaciones.
 *
 * Es un servicio y no un montón de controladores con SQL dentro porque las
 * tres operaciones comparten una propiedad: **cada una tiene que ser atómica**.
 * Un alta que crea el inquilino pero falla al crear la suscripción deja una
 * cuenta que no puede enviar nada y nadie sabe por qué.
 */
import { randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import jwt from 'jsonwebtoken';
import { hashearContrasena, verificarContrasena, igualesEnTiempoConstante } from '@crmapp/crypto';
import { finDePrueba, estadoEfectivo, type Suscripcion } from '@crmapp/core';
import { escribirEnOutbox } from '@crmapp/queue';
import { contextoActual as contextoDePeticion, type BaseDeDatos } from '../db.js';

export type Rol = 'owner' | 'admin' | 'supervisor' | 'agent';

export class ErrorDeNegocio extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly httpStatus = 400,
  ) {
    super(mensaje);
    this.name = 'ErrorDeNegocio';
  }
}

export interface Sesion {
  token: string;
  tenantId: string;
  userId: string;
  rol: Rol;
  expiraEn: number;
}

interface PayloadJwt {
  sub: string;
  tid: string;
  rol: Rol;
}

export interface OpcionesDeAuth {
  db: BaseDeDatos;
  jwtSecret: string;
  ttlSegundos?: number;
  /** Reloj inyectable: probar el fin de la prueba exige controlarlo. */
  ahora?: () => Date;
}

export class AuthService {
  readonly #db: BaseDeDatos;
  readonly #secret: string;
  readonly #ttl: number;
  readonly #ahora: () => Date;

  constructor(opciones: OpcionesDeAuth) {
    this.#db = opciones.db;
    this.#secret = opciones.jwtSecret;
    this.#ttl = opciones.ttlSegundos ?? 60 * 60 * 8;
    this.#ahora = opciones.ahora ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Alta de cuenta
  // -------------------------------------------------------------------------

  /**
   * Crea inquilino, usuario propietario y suscripción en prueba.
   *
   * Todo en una transacción. Y **la suscripción se crea aquí, no después**: una
   * cuenta sin suscripción está suspendida según `@crmapp/core`, porque sin
   * fechas se falla cerrado. Dejarlo para un job posterior significaría que
   * toda cuenta nueva nace sin poder enviar hasta que ese job pase.
   */
  async registrar(datos: {
    nombreDeCuenta: string;
    slug: string;
    email: string;
    contrasena: string;
    nombreCompleto: string;
    // `| undefined` explicito por exactOptionalPropertyTypes.
    planCode?: string | undefined;
  }): Promise<Sesion> {
    if (datos.contrasena.length < 10) {
      throw new ErrorDeNegocio(
        'contrasena_debil',
        'La contraseña debe tener al menos 10 caracteres.',
      );
    }

    const hash = await hashearContrasena(datos.contrasena);
    const ahora = this.#ahora();

    return this.#db.creandoInquilino(async (c, tenantId) => {
      const { rows: planes } = await c.query<{
        id: string;
        trial_months: number;
        grace_days: number;
      }>(`SELECT id, trial_months, grace_days FROM plans WHERE code = $1`, [
        datos.planCode ?? 'starter',
      ]);
      const plan = planes[0];
      if (!plan) throw new ErrorDeNegocio('plan_desconocido', 'El plan indicado no existe.', 404);

      try {
        await c.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [
          tenantId,
          datos.nombreDeCuenta,
          datos.slug,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'slug_ocupado',
            'Ya existe una cuenta con ese identificador.',
            409,
          );
        }
        throw error;
      }

      // Sin RETURNING: ver BaseDeDatos.nuevoId().
      const userId = await this.#db.nuevoId(c);
      try {
        await c.query(
          `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)`,
          [userId, datos.email, hash, datos.nombreCompleto],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio('email_ocupado', 'Ya existe un usuario con ese correo.', 409);
        }
        throw error;
      }

      await c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [
        tenantId,
        userId,
      ]);

      // Los días de gracia se COPIAN del plan, no se leen de él al evaluar:
      // cambiar el plan después no debe alterar el trato de quien ya firmó.
      await c.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, trial_ends_at, grace_days, cached_state, cached_state_at)
         VALUES ($1, $2, 'trialing', $3, $4, 'prueba', now())`,
        [tenantId, plan.id, finDePrueba(ahora, plan.trial_months), plan.grace_days],
      );

      await this.#auditar(c, tenantId, userId, 'cuenta.creada', 'tenant', tenantId);

      await escribirEnOutbox(c, {
        tenantId,
        aggregateType: 'tenant',
        aggregateId: tenantId,
        eventType: 'cuenta.creada',
        payload: { email: datos.email, plan: datos.planCode ?? 'starter' },
      });

      return this.#emitirSesion(tenantId, userId, 'owner');
    });
  }

  // -------------------------------------------------------------------------
  // Inicio de sesión
  // -------------------------------------------------------------------------

  async iniciarSesion(email: string, contrasena: string, tenantSlug?: string): Promise<Sesion> {
    const fila = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        password_hash: string | null;
        tenant_id: string;
        role: Rol;
        membership_status: string;
      }>(
        `SELECT u.id, u.password_hash, m.tenant_id, m.role, m.status AS membership_status
           FROM users u
           JOIN memberships m ON m.user_id = u.id
           JOIN tenants t ON t.id = m.tenant_id
          WHERE u.email = $1
            AND ($2::citext IS NULL OR t.slug = $2)
          ORDER BY m.created_at
          LIMIT 1`,
        [email, tenantSlug ?? null],
      );

      return rows[0];
    });

    // Se verifica un hash aunque el usuario no exista. Si no, el tiempo de
    // respuesta delata qué correos están registrados, que es media
    // enumeración de clientes.
    const correcta = await verificarContrasena(contrasena, fila?.password_hash ?? HASH_SENUELO);

    if (!fila || !correcta || fila.membership_status !== 'active') {
      throw new ErrorDeNegocio('credenciales_invalidas', 'Correo o contraseña incorrectos.', 401);
    }

    // La escritura ya sabe el inquilino, asi que vuelve al rol de aplicacion:
    // el rol de autenticacion no puede escribir, a proposito.
    await this.#db.paraInquilino(fila.tenant_id, async (c) => {
      await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [fila.id]);
    });

    return this.#emitirSesion(fila.tenant_id, fila.id, fila.role);
  }

  verificarToken(token: string): PayloadJwt {
    try {
      return jwt.verify(token, this.#secret) as PayloadJwt;
    } catch {
      throw new ErrorDeNegocio('token_invalido', 'Sesión inválida o caducada.', 401);
    }
  }

  // -------------------------------------------------------------------------
  // Estado de la suscripción
  // -------------------------------------------------------------------------

  /** Estado efectivo derivado de las fechas, nunca de la columna cacheada. */
  async estadoDeSuscripcion(tenantId: string) {
    return this.#db.paraInquilino(tenantId, async (c) => {
      const { rows } = await c.query<{
        status: 'trialing' | 'active' | 'cancelled';
        trial_ends_at: Date | null;
        current_period_ends_at: Date | null;
        grace_days: number;
      }>(
        `SELECT status, trial_ends_at, current_period_ends_at, grace_days
           FROM subscriptions WHERE tenant_id = $1`,
        [tenantId],
      );
      const s = rows[0];
      if (!s) throw new ErrorDeNegocio('sin_suscripcion', 'La cuenta no tiene suscripción.', 404);

      const suscripcion: Suscripcion = {
        estadoDeclarado: s.status,
        pruebaHasta: s.trial_ends_at,
        periodoHasta: s.current_period_ends_at,
        diasDeGracia: s.grace_days,
      };
      return { suscripcion, estado: estadoEfectivo(suscripcion, this.#ahora()) };
    });
  }

  // -------------------------------------------------------------------------
  // Invitaciones
  // -------------------------------------------------------------------------

  /**
   * Crea una invitación y devuelve el token EN CLARO, una sola vez.
   *
   * En la base solo queda el hash: quien lea la tabla no debe poder aceptar
   * invitaciones ajenas. El correo sale por el outbox, en la misma transacción,
   * para que no exista una invitación cuyo correo nunca se envió ni un correo
   * de una invitación que no se llegó a crear.
   */
  async invitar(datos: { email: string; rol: Rol }): Promise<{ id: string; token: string }> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden invitar.',
        403,
      );
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const caduca = new Date(this.#ahora().getTime() + 7 * 24 * 60 * 60 * 1000);

    return this.#db.enTransaccion(async (c) => {
      const { rows: existentes } = await c.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND u.email = $2`,
        [ctx.tenantId, datos.email],
      );
      if (existentes.length > 0) {
        throw new ErrorDeNegocio('ya_es_miembro', 'Ese correo ya pertenece a la cuenta.', 409);
      }

      let id: string;
      try {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [ctx.tenantId, datos.email, datos.rol, tokenHash, ctx.userId, caduca],
        );
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'invitacion_pendiente',
            'Ya hay una invitación pendiente para ese correo.',
            409,
          );
        }
        throw error;
      }

      await this.#auditar(c, ctx.tenantId, ctx.userId, 'invitacion.creada', 'invitation', id);

      await escribirEnOutbox(c, {
        tenantId: ctx.tenantId,
        aggregateType: 'invitation',
        aggregateId: id,
        eventType: 'invitacion.creada',
        // El token va en el evento porque el correo lo necesita. Es la única
        // copia en claro que sobrevive a esta función, y vive en una tabla que
        // el relay purga al publicar.
        payload: { para: datos.email, rol: datos.rol, token },
      });

      return { id, token };
    });
  }

  /** Acepta una invitación: crea el usuario si no existe y lo da de alta. */
  async aceptarInvitacion(datos: {
    token: string;
    contrasena: string;
    nombreCompleto: string;
  }): Promise<Sesion> {
    const tokenHash = createHash('sha256').update(datos.token).digest('hex');

    const inv = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        tenant_id: string;
        email: string;
        role: Rol;
        token_hash: string;
        expires_at: Date;
        accepted_at: Date | null;
      }>(
        `SELECT id, tenant_id, email, role, token_hash, expires_at, accepted_at
           FROM invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      return rows[0];
    });

    if (!inv || !igualesEnTiempoConstante(inv.token_hash, tokenHash)) {
      throw new ErrorDeNegocio('invitacion_invalida', 'La invitación no existe.', 404);
    }
    if (inv.accepted_at) {
      throw new ErrorDeNegocio('invitacion_usada', 'Esa invitación ya se usó.', 409);
    }
    if (inv.expires_at <= this.#ahora()) {
      throw new ErrorDeNegocio('invitacion_caducada', 'La invitación ha caducado.', 410);
    }

    // Ya se conoce el inquilino, asi que las escrituras vuelven al rol de
    // aplicacion y a su RLS.
    return this.#db.paraInquilino(inv.tenant_id, async (c) => {
      const { rows: usuarios } = await c.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [inv.email],
      );

      let userId = usuarios[0]?.id;
      if (!userId) {
        if (datos.contrasena.length < 10) {
          throw new ErrorDeNegocio(
            'contrasena_debil',
            'La contraseña debe tener al menos 10 caracteres.',
          );
        }
        userId = await this.#db.nuevoId(c);
        await c.query(
          `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)`,
          [userId, inv.email, await hashearContrasena(datos.contrasena), datos.nombreCompleto],
        );
      }

      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [inv.tenant_id, userId, inv.role],
      );

      // Marcar aceptada con la condicion `accepted_at IS NULL` y comprobar
      // cuantas filas cambiaron: dos peticiones simultaneas con el mismo token
      // llegan aqui las dos, y solo una debe ganar. Sin la condicion, ambas
      // creerian haber aceptado.
      const marcada = await c.query(
        `UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL`,
        [inv.id],
      );
      if (marcada.rowCount === 0) {
        throw new ErrorDeNegocio('invitacion_usada', 'Esa invitación ya se usó.', 409);
      }

      await this.#auditar(c, inv.tenant_id, userId, 'invitacion.aceptada', 'invitation', inv.id);

      return this.#emitirSesion(inv.tenant_id, userId, inv.role);
    });
  }

  // -------------------------------------------------------------------------

  #emitirSesion(tenantId: string, userId: string, rol: Rol): Sesion {
    const payload: PayloadJwt = { sub: userId, tid: tenantId, rol };
    const token = jwt.sign(payload, this.#secret, { expiresIn: this.#ttl });
    return { token, tenantId, userId, rol, expiraEn: this.#ttl };
  }

  #exigirContexto() {
    const ctx = contextoDePeticion();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  async #auditar(
    c: PoolClient,
    tenantId: string,
    userId: string,
    accion: string,
    entidad: string,
    entidadId: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, userId, accion, entidad, entidadId],
    );
  }
}

/**
 * Hash señuelo con los parámetros de producción.
 *
 * Se verifica contra él cuando el correo no existe, para que un intento
 * fallido cueste lo mismo que uno con correo válido. Sin esto, medir el tiempo
 * de respuesta enumera qué correos están registrados.
 */
const HASH_SENUELO =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
