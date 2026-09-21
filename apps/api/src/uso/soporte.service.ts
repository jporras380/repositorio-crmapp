/**
 * Modo soporte: el cliente deja entrar, y solo un rato.
 *
 * La consola del operador (0040) ve cifras de todas las cuentas y ni una
 * conversación. Eso es lo que la hace defendible, y no se toca. Pero cuando un
 * cliente escribe «no me llegan los mensajes», mirar cifras no alcanza: hay
 * que ver su bandeja, y eso son conversaciones de huéspedes.
 *
 * ## Las cuatro condiciones
 *
 * 1. **Lo autoriza el cliente.** El operador pide y alguien de la cuenta
 *    aprueba. No hay forma de concederse acceso a uno mismo: la política de
 *    base de datos deja al rol del operador INSERTAR solicitudes sin aprobar,
 *    y nada más. Un permiso que uno se da solo es una llave maestra.
 * 2. **Caduca solo.** El plazo lo fija quien abre la puerta, no quien llama, y
 *    no hay forma de dejarlo abierto indefinidamente.
 * 3. **Solo lectura, garantizado por PostgreSQL.** El rol `crmapp_soporte` no
 *    tiene INSERT ni UPDATE ni DELETE. Un soporte que puede escribir puede
 *    romper, y entonces nadie sabe si el fallo era del cliente o de quien fue
 *    a ayudarle.
 * 4. **Queda en la auditoría del cliente**: quién pidió, quién aprobó, cuándo
 *    y por qué.
 *
 * ## Por qué se niega a funcionar sin su rol
 *
 * Si `DATABASE_SOPORTE_URL` no está puesta, el pool cae al de la aplicación,
 * que SÍ puede escribir. Antes que dar acceso de escritura sin querer, este
 * servicio se niega. Fallar cerrado.
 */
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { contextoActual, type BaseDeDatos } from '../db.js';

/** Tope de lo que puede durar un permiso. Un día es una jornada de soporte. */
export const HORAS_MAXIMAS = 24;

export interface PermisoDeSoporte {
  id: string;
  motivo: string;
  pedidoPor: string | null;
  pedidoEn: Date;
  aprobadoEn: Date | null;
  expiraEn: Date | null;
  revocadoEn: Date | null;
  /** Calculado al leer: pendiente, activo o terminado. */
  estado: 'pendiente' | 'activo' | 'terminado';
}

export class SoporteService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  constructor(o: { db: BaseDeDatos; ahora?: () => Date }) {
    this.#db = o.db;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Lado del operador
  // -------------------------------------------------------------------------

  /**
   * Pide entrar a una cuenta, diciendo por qué.
   *
   * El motivo es obligatorio y largo: «necesito entrar» no es algo que el
   * cliente pueda valorar, y es lo único que tiene para decidir.
   */
  async pedirAcceso(datos: { tenantId: string; motivo: string }): Promise<{ id: string }> {
    const operador = await this.#exigirOperador();
    const motivo = datos.motivo.trim();
    if (motivo.length < 10) {
      throw new ErrorDeNegocio(
        'motivo_corto',
        'Explica para qué necesitas entrar: es lo único que el cliente tiene para decidir.',
        422,
      );
    }

    return this.#db.paraInquilino(datos.tenantId, async (c) => {
      try {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO support_grants (tenant_id, requested_by, reason)
           VALUES ($1, $2, $3) RETURNING id`,
          [datos.tenantId, operador, motivo],
        );
        await c.query(
          `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
           VALUES ($1, $2, 'soporte.solicitado', 'support_grant', $3, $4)`,
          [datos.tenantId, operador, rows[0]!.id, JSON.stringify({ motivo })],
        );
        return { id: rows[0]!.id };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'ya_hay_solicitud',
            'Esa cuenta ya tiene una solicitud pendiente de responder.',
            409,
          );
        }
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Lado del cliente
  // -------------------------------------------------------------------------

  /**
   * Lo que el cliente ve de los accesos de soporte a su cuenta.
   *
   * Incluye los terminados: el valor del registro está en poder mirar quién
   * entró el mes pasado sin preguntarle a nadie.
   */
  async permisos(): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirContexto();
    const ahora = this.#ahora();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        reason: string;
        pedido_por: string | null;
        requested_at: Date;
        approved_at: Date | null;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT g.id, g.reason, u.full_name AS pedido_por, g.requested_at,
                g.approved_at, g.expires_at, g.revoked_at
           FROM support_grants g
           LEFT JOIN users u ON u.id = g.requested_by
          WHERE g.tenant_id = $1
          ORDER BY g.requested_at DESC
          LIMIT 20`,
        [ctx.tenantId],
      );
      return rows.map((f) => ({
        id: f.id,
        motivo: f.reason,
        pedidoPor: f.pedido_por,
        pedidoEn: f.requested_at,
        aprobadoEn: f.approved_at,
        expiraEn: f.expires_at,
        revocadoEn: f.revoked_at,
        estado: estadoDe(f, ahora),
      }));
    });
  }

  /**
   * El cliente abre la puerta, y dice por cuánto tiempo.
   *
   * Solo owner o admin: dejar entrar a la correspondencia de los huéspedes no
   * es una decisión que deba poder tomar cualquiera del equipo.
   */
  async aprobar(id: string, horas: number): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirGestor();
    if (!Number.isFinite(horas) || horas < 1 || horas > HORAS_MAXIMAS) {
      throw new ErrorDeNegocio(
        'plazo_invalido',
        `El acceso puede durar entre 1 y ${HORAS_MAXIMAS} horas.`,
        422,
      );
    }

    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE support_grants
            SET approved_by = $2, approved_at = now(), expires_at = now() + ($3 || ' hours')::interval
          WHERE id = $1 AND approved_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
        [id, ctx.userId, String(horas)],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio(
          'solicitud_no_pendiente',
          'Esa solicitud ya no está pendiente.',
          409,
        );
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'soporte.aprobado', 'support_grant', $3, $4)`,
        [ctx.tenantId, ctx.userId, id, JSON.stringify({ horas })],
      );
    });
    return this.permisos();
  }

  /** Cortar antes de tiempo. Sirve igual para rechazar que para echar a alguien. */
  async revocar(id: string): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE support_grants SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio('nada_que_revocar', 'Ese acceso ya estaba cerrado.', 409);
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'soporte.revocado', 'support_grant', $3)`,
        [ctx.tenantId, ctx.userId, id],
      );
    });
    return this.permisos();
  }

  // -------------------------------------------------------------------------
  // Mirar la cuenta, con el permiso en la mano
  // -------------------------------------------------------------------------

  /**
   * Las conversaciones del cliente, con lo que hace falta para diagnosticar.
   *
   * No es la bandeja: es la lista de lo que está fallando. Lo que se devuelve
   * de cada hilo es el estado del último mensaje y su error, porque «no me
   * llega» y «no se envía» se contestan con eso y no leyendo lo que la gente
   * se dice.
   */
  async conversacionesDe(tenantId: string): Promise<
    {
      id: string;
      canal: string;
      estado: string;
      ultimoEntranteEn: Date | null;
      ultimoSalienteEn: Date | null;
      mensajesFallidos: number;
      ultimoError: { tipo?: string; mensaje?: string } | null;
    }[]
  > {
    await this.#exigirPermisoVivo(tenantId);

    return this.#db.comoSoporteEn(tenantId, async (c) => {
      const { rows } = await c.query<{
        id: string;
        channel: string | null;
        status: string;
        last_inbound_at: Date | null;
        last_outbound_at: Date | null;
        fallidos: string;
        ultimo_error: { tipo?: string; mensaje?: string } | null;
      }>(
        // El canal cuelga de la cuenta de canal, no de la conversación.
        `SELECT c.id, ca.channel, c.status, c.last_inbound_at, c.last_outbound_at,
                (SELECT count(*) FROM messages m
                  WHERE m.conversation_id = c.id AND m.status = 'failed') AS fallidos,
                (SELECT m.error FROM messages m
                  WHERE m.conversation_id = c.id AND m.error IS NOT NULL
                  ORDER BY m.created_at DESC LIMIT 1) AS ultimo_error
           FROM conversations c
           LEFT JOIN channel_accounts ca ON ca.id = c.channel_account_id
          ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC
          LIMIT 50`,
      );
      return rows.map((f) => ({
        id: f.id,
        canal: f.channel ?? 'desconocido',
        estado: f.status,
        ultimoEntranteEn: f.last_inbound_at,
        ultimoSalienteEn: f.last_outbound_at,
        mensajesFallidos: Number(f.fallidos),
        ultimoError: f.ultimo_error,
      }));
    });
  }

  // -------------------------------------------------------------------------

  /** Que haya un permiso aprobado, sin caducar y sin revocar. Y que sea suyo. */
  async #exigirPermisoVivo(tenantId: string): Promise<void> {
    const operador = await this.#exigirOperador();

    // Sin el rol de soporte de verdad, el pool cae al de la aplicación, que
    // puede escribir. Antes que eso, no se entra.
    if (!this.#db.soporteAislado) {
      throw new ErrorDeNegocio(
        'soporte_no_configurado',
        'El modo soporte no está configurado en este servidor.',
        503,
      );
    }

    const vivo = await this.#db.paraInquilino(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT 1 FROM support_grants
          WHERE tenant_id = $1 AND requested_by = $2
            AND approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`,
        [tenantId, operador],
      );
      return rows.length > 0;
    });
    if (!vivo) {
      throw new ErrorDeNegocio(
        'sin_permiso_de_soporte',
        'No hay un acceso de soporte vivo para esa cuenta.',
        403,
      );
    }
  }

  async #exigirOperador(): Promise<string> {
    const ctx = this.#exigirContexto();
    const esOperador = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{ is_operator: boolean }>(
        `SELECT is_operator FROM users WHERE id = $1`,
        [ctx.userId],
      );
      return rows[0]?.is_operator === true;
    });
    // 404 y no 403: quien no es operador no tiene por qué saber que esto existe.
    if (!esOperador) throw new ErrorDeNegocio('no_encontrado', 'No existe esa ruta.', 404);
    return ctx.userId;
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  #exigirGestor() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo el dueño o un administrador deja entrar a soporte.',
        403,
      );
    }
    return ctx;
  }
}

/** Pendiente, activo o terminado. Se calcula al leer: un estado guardado caduca solo mal. */
function estadoDe(
  f: { approved_at: Date | null; expires_at: Date | null; revoked_at: Date | null },
  ahora: Date,
): PermisoDeSoporte['estado'] {
  if (f.revoked_at) return 'terminado';
  if (!f.approved_at) return 'pendiente';
  if (f.expires_at && f.expires_at.getTime() <= ahora.getTime()) return 'terminado';
  return 'activo';
}
