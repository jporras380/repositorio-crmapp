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
import {
  cabeUnoMas,
  ErrorDeNegocio,
  finDePrueba,
  estadoEfectivo,
  type Suscripcion,
} from '@crmapp/core';
import { escribirEnOutbox } from '@crmapp/queue';
import { contextoActual as contextoDePeticion, type BaseDeDatos } from '../db.js';

export type Rol = 'owner' | 'admin' | 'supervisor' | 'agent';

// La clase vive en `@crmapp/core` desde que la puerta de envío es un paquete
// compartido: la lanzan la API, la puerta y el worker, y tienen que ser la
// MISMA clase o el filtro de errores dejaría de reconocer la mitad. Se
// reexporta aquí para no tocar a los quince archivos que la importaban.
export { ErrorDeNegocio };

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
  /** Sesión a la que pertenece el token (0033). Es lo que se puede cerrar. */
  sid?: string;
}

/** De dónde viene quien entra. Lo que el dueño de la cuenta reconoce o no. */
export interface DatosDeAcceso {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface SesionAbierta {
  id: string;
  ip: string | null;
  dispositivo: string | null;
  ultimaVezEn: Date;
  creadaEn: Date;
  /** La del token con el que se está preguntando: no se ofrece cerrarla igual. */
  esLaActual: boolean;
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
  async registrar(
    datos: {
      nombreDeCuenta: string;
      slug: string;
      email: string;
      contrasena: string;
      nombreCompleto: string;
      // `| undefined` explicito por exactOptionalPropertyTypes.
      planCode?: string | undefined;
    },
    acceso: DatosDeAcceso = {},
  ): Promise<Sesion> {
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

      // El embudo por defecto entra con la cuenta: un tablero sin columnas no
      // es una pantalla vacía, es una pantalla rota. La definición vive en
      // `app.sembrar_embudo` (migración 0018) para que la migración y esto no
      // se separen nunca.
      await c.query(`SELECT app.sembrar_embudo($1)`, [tenantId]);

      await this.#auditar(c, tenantId, userId, 'cuenta.creada', 'tenant', tenantId);

      await escribirEnOutbox(c, {
        tenantId,
        aggregateType: 'tenant',
        aggregateId: tenantId,
        eventType: 'cuenta.creada',
        payload: { email: datos.email, plan: datos.planCode ?? 'starter' },
      });

      return this.#emitirSesion(tenantId, userId, 'owner', acceso, c);
    });
  }

  // -------------------------------------------------------------------------
  // Inicio de sesión
  // -------------------------------------------------------------------------

  async iniciarSesion(
    email: string,
    contrasena: string,
    tenantSlug?: string,
    acceso: DatosDeAcceso = {},
  ): Promise<Sesion> {
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

    return this.#emitirSesion(fila.tenant_id, fila.id, fila.role, acceso);
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

      // Límite de asientos del plan (ADR-011). Se cuentan también las
      // invitaciones pendientes: tres enviadas a la vez meterían tres
      // asientos por encima del tope, y el aviso llegaría cuando ya no se
      // puede deshacer.
      const { rows: cupo } = await c.query<{ ocupados: string; tope: number | null }>(
        `SELECT (SELECT count(*) FROM memberships m WHERE m.tenant_id = $1)
              + (SELECT count(*) FROM invitations i
                  WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now())
                AS ocupados,
               (p.limits ->> 'agentes')::int AS tope
          FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.tenant_id = $1`,
        [ctx.tenantId],
      );
      const c0 = cupo[0];
      if (c0 && !cabeUnoMas(Number(c0.ocupados), c0.tope)) {
        throw new ErrorDeNegocio(
          'limite_de_asientos',
          `Tu plan incluye ${c0.tope} asientos y ya están ocupados. Sube de plan para invitar a alguien más.`,
          402,
          { tope: c0.tope, ocupados: Number(c0.ocupados) },
        );
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
  async aceptarInvitacion(
    datos: { token: string; contrasena: string; nombreCompleto: string },
    acceso: DatosDeAcceso = {},
  ): Promise<Sesion> {
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

      return this.#emitirSesion(inv.tenant_id, userId, inv.role, acceso, c);
    });
  }

  /**
   * Quién trabaja en esta cuenta. Lo pide el constructor de flujos —un paso
   * «asignar» necesita a quién— y lo pedirá la bandeja cuando un agente pueda
   * pasarle una conversación a otro.
   *
   * Sin correo: para elegir a quién asignar basta el nombre, y la lista de
   * correos del equipo es justo lo que no hace falta repartir por el frontend.
   */
  async miembros(): Promise<{ id: string; nombre: string; rol: Rol }[]> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string; nombre: string; rol: Rol }>(
        `SELECT u.id, u.full_name AS nombre, m.role AS rol
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1
          ORDER BY u.full_name`,
        [ctx.tenantId],
      );
      return rows;
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Firma el token Y deja constancia de la sesión.
   *
   * El `sid` dentro del token es lo que permite cerrarla: sin él, revocar
   * exigiría una lista negra de tokens enteros, que crece sin parar y hay que
   * limpiar. Con el identificador, cerrar es marcar una fila.
   */
  async #emitirSesion(
    tenantId: string,
    userId: string,
    rol: Rol,
    acceso: DatosDeAcceso = {},
    /**
     * Cliente de una transacción en curso, si la hay.
     *
     * El alta de cuenta crea el inquilino y emite la sesión en la MISMA
     * transacción: abrir otra conexión aquí veía un inquilino que todavía no
     * existe y la clave foránea saltaba. Lo cazó el test del alta.
     */
    enCurso?: PoolClient,
  ): Promise<Sesion> {
    const insertar = async (c: PoolClient) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO sessions (tenant_id, user_id, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         RETURNING id`,
        [tenantId, userId, acceso.ip ?? null, acceso.userAgent ?? null, this.#ttl],
      );
      return rows[0]!.id;
    };
    const sid = enCurso
      ? await insertar(enCurso)
      : await this.#db.paraInquilino(tenantId, insertar);
    const payload: PayloadJwt = { sub: userId, tid: tenantId, rol, sid };
    const token = jwt.sign(payload, this.#secret, { expiresIn: this.#ttl });
    return { token, tenantId, userId, rol, expiraEn: this.#ttl };
  }

  /**
   * ¿Sigue viva esta sesión? La llama la guarda en cada petición.
   *
   * Un token con firma válida pero sesión cerrada **no vale**: es justo el caso
   * que hace útil esta tabla. Un token antiguo sin `sid` —emitido antes de
   * 0033— se acepta hasta que caduque: invalidarlos de golpe echaría a todo el
   * mundo en el despliegue, y caducan solos.
   */
  async sesionViva(payload: { tid: string; sid?: string }): Promise<void> {
    if (!payload.sid) return;
    const viva = await this.#db.paraInquilino(payload.tid, async (c) => {
      const { rows } = await c.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM sessions WHERE id = $1`,
        [payload.sid],
      );
      if (!rows[0] || rows[0].revoked_at) return false;
      // Una escritura por minuto como mucho: la fila la lee cada petición.
      await c.query(
        `UPDATE sessions SET last_seen_at = now()
          WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
        [payload.sid],
      );
      return true;
    });
    if (!viva) {
      throw new ErrorDeNegocio('sesion_cerrada', 'Esta sesión se cerró. Entra otra vez.', 401);
    }
  }

  // -------------------------------------------------------------------------
  // Perfil de quien ha entrado
  // -------------------------------------------------------------------------

  /** Los datos que el propio usuario puede ver y cambiar de sí mismo. */
  async perfil(): Promise<{
    userId: string;
    nombre: string;
    email: string;
    fotoId: string | null;
    dobleFactor: boolean;
  }> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        full_name: string;
        email: string;
        avatar_media_id: string | null;
        mfa_secret_id: string | null;
      }>(
        `SELECT full_name, email::text AS email, avatar_media_id, mfa_secret_id
           FROM users WHERE id = $1`,
        [ctx.userId],
      );
      const u = rows[0];
      if (!u) throw new ErrorDeNegocio('usuario_no_encontrado', 'No existe ese usuario.', 404);
      return {
        userId: ctx.userId,
        nombre: u.full_name,
        email: u.email,
        fotoId: u.avatar_media_id,
        dobleFactor: u.mfa_secret_id !== null,
      };
    });
  }

  /**
   * Cambia nombre o foto. El correo NO: es la llave de entrada y va aparte.
   */
  async editarPerfil(datos: {
    nombre?: string | undefined;
    fotoId?: string | null | undefined;
  }): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      if (datos.nombre !== undefined) {
        await c.query(`UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1`, [
          ctx.userId,
          datos.nombre,
        ]);
      }
      if (datos.fotoId !== undefined) {
        // Se comprueba que el medio es de esta cuenta: RLS ya lo filtra, pero
        // un id ajeno debe dar «no existe», no guardarse en silencio.
        if (datos.fotoId !== null) {
          const { rows } = await c.query(`SELECT 1 FROM media_assets WHERE id = $1`, [
            datos.fotoId,
          ]);
          if (!rows[0]) {
            throw new ErrorDeNegocio('medio_no_encontrado', 'Esa imagen no existe.', 404);
          }
        }
        await c.query(`UPDATE users SET avatar_media_id = $2, updated_at = now() WHERE id = $1`, [
          ctx.userId,
          datos.fotoId,
        ]);
      }
    });
  }

  /**
   * Cambia el correo o la contraseña, pidiendo la contraseña actual.
   *
   * **Las dos cosas exigen la contraseña de ahora**, y no es burocracia: son
   * las dos llaves de la cuenta. Quien se deje la sesión abierta en el
   * ordenador de recepción no debería poder quedarse con ella para siempre.
   *
   * **Cambiar la contraseña cierra las demás sesiones.** Es lo que la gente
   * espera de ese botón, y hasta 0033 era imposible de cumplir.
   */
  async cambiarAcceso(datos: {
    contrasenaActual: string;
    email?: string | undefined;
    contrasenaNueva?: string | undefined;
  }): Promise<{ sesionesCerradas: number }> {
    const ctx = this.#exigirContexto();
    const actual = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [ctx.userId],
      );
      return rows[0]?.password_hash ?? HASH_SENUELO;
    });
    if (!(await verificarContrasena(datos.contrasenaActual, actual))) {
      throw new ErrorDeNegocio('contrasena_incorrecta', 'La contraseña actual no es esa.', 403);
    }

    await this.#db.enTransaccion(async (c) => {
      if (datos.email) {
        try {
          await c.query(`UPDATE users SET email = $2, updated_at = now() WHERE id = $1`, [
            ctx.userId,
            datos.email,
          ]);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') {
            throw new ErrorDeNegocio('email_en_uso', 'Ese correo ya está en uso.', 409);
          }
          throw e;
        }
      }
      if (datos.contrasenaNueva) {
        await c.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
          ctx.userId,
          await hashearContrasena(datos.contrasenaNueva),
        ]);
      }
    });

    // Solo al cambiar la contraseña: cambiar el correo no echa a nadie, y
    // hacerlo sorprendería a quien solo corrigió una letra.
    const sesionesCerradas = datos.contrasenaNueva
      ? await this.cerrarSesion('otras', 'cambio de contraseña')
      : 0;
    return { sesionesCerradas };
  }

  /** Las sesiones abiertas de quien pregunta. */
  async sesiones(): Promise<SesionAbierta[]> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        ip: string | null;
        user_agent: string | null;
        last_seen_at: Date;
        created_at: Date;
      }>(
        `SELECT id, ip, user_agent, last_seen_at, created_at
           FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC`,
        [ctx.userId],
      );
      return rows.map((r) => ({
        id: r.id,
        ip: r.ip,
        dispositivo: r.user_agent,
        ultimaVezEn: r.last_seen_at,
        creadaEn: r.created_at,
        esLaActual: r.id === ctx.sessionId,
      }));
    });
  }

  /**
   * Cierra una sesión, o todas menos la actual.
   *
   * No se borra la fila: el historial de accesos es lo que deja ver «alguien
   * entró desde otra ciudad el martes», y borrarlo esconde justo lo que se
   * estaba mirando.
   */
  async cerrarSesion(id: string | 'otras', motivo = 'cerrada por el usuario'): Promise<number> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(
        id === 'otras'
          ? `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
              WHERE user_id = $1 AND revoked_at IS NULL AND id <> $3::uuid`
          : `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
              WHERE user_id = $1 AND revoked_at IS NULL AND id = $3::uuid`,
        [ctx.userId, motivo, id === 'otras' ? (ctx.sessionId ?? null) : id],
      );
      return rowCount ?? 0;
    });
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
