/**
 * Cuánto tiempo guarda el hotel sus mensajes (0052).
 *
 * Aquí solo se elige el plazo y se cuenta lo que caería con cada uno. Quien
 * borra es el worker, una vez al día, con una función de la base que decide
 * qué se borra y qué no —nunca un archivo que otra cosa use—.
 *
 * Lo cambia **solo el propietario**: borrar el historial no tiene vuelta, y
 * no es una decisión para un administrador ni un supervisor.
 */
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

/** `null` es «para siempre». El resto, en meses; el mínimo es un año. */
export const PLAZOS_DE_RETENCION = [12, 24, 36, 60] as const;
export type PlazoDeRetencion = (typeof PLAZOS_DE_RETENCION)[number];

export interface Privacidad {
  retencionMeses: PlazoDeRetencion | null;
  /**
   * Cuántos mensajes de hoy caerían con cada plazo. Es lo que el dueño tiene
   * que ver ANTES de elegir: «2 años» no dice nada, «se borran 3.412
   * mensajes» sí.
   */
  caerianConCadaPlazo: Record<PlazoDeRetencion, number>;
  /** Solo el propietario puede cambiarlo. */
  puedeCambiar: boolean;
}

export class PrivacidadService {
  readonly #db: BaseDeDatos;

  constructor(o: { db: BaseDeDatos }) {
    this.#db = o.db;
  }

  async leer(): Promise<Privacidad> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ meses: number | null }>(
        `SELECT message_retention_months AS meses FROM tenants WHERE id = $1`,
        [ctx.tenantId],
      );
      // Una sola pasada sobre los mensajes para los cuatro plazos.
      const { rows: cuentas } = await c.query<Record<string, string>>(
        `SELECT ${PLAZOS_DE_RETENCION.map(
          (m) => `count(*) FILTER (WHERE created_at < now() - interval '${m} months') AS "${m}"`,
        ).join(', ')}
           FROM messages WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      const fila = cuentas[0] ?? {};
      return {
        retencionMeses: (rows[0]?.meses ?? null) as PlazoDeRetencion | null,
        caerianConCadaPlazo: Object.fromEntries(
          PLAZOS_DE_RETENCION.map((m) => [m, Number(fila[String(m)] ?? 0)]),
        ) as Record<PlazoDeRetencion, number>,
        puedeCambiar: ctx.rol === 'owner',
      };
    });
  }

  async guardar(retencionMeses: PlazoDeRetencion | null): Promise<Privacidad> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo el propietario de la cuenta decide cuánto tiempo se guardan los mensajes.',
        403,
      );
    }
    await this.#db.enTransaccion(async (c) => {
      await c.query(
        `UPDATE tenants SET message_retention_months = $2, updated_at = now() WHERE id = $1`,
        [ctx.tenantId, retencionMeses],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'cuenta.retencion', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify({ retencionMeses })],
      );
    });
    return this.leer();
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}
