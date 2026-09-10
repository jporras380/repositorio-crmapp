/**
 * Uso del periodo y estado de la suscripción, frente a los límites del plan.
 *
 * **Solo lectura, y no por comodidad.** El cobro es manual (ADR-011): quien
 * registra un pago es el operador con un script, nunca el inquilino desde su
 * propia sesión. Aquí solo se mira: cuánto se lleva consumido, cuánto toca
 * pagar y hasta cuándo está cubierto. Lo que evita la sorpresa del día de
 * cobro es justo esto.
 */
import type { PoolClient } from 'pg';
import {
  cabeUnoMas,
  estadoEfectivo,
  graciaHasta,
  importeMensualEnCentimos,
  nivelDeConsumo,
  type EstadoEfectivo,
  type NivelDeConsumo,
  type Suscripcion,
} from '@crmapp/core';
import {
  etiquetaDePeriodo,
  inicioDePeriodo,
  leerUsoDelPeriodo,
  type MetricaDeUso,
} from '@crmapp/db';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

/** Qué métrica alimenta cada límite del plan (`plans.limits`). */
const LIMITE_POR_METRICA: Partial<Record<MetricaDeUso, string>> = {
  'conversations.opened': 'conversaciones_mes',
  'bot.runs': 'bot_runs_mes',
};

export interface ResumenDeUso {
  periodo: string;
  desde: Date;
  plan: string | null;
  uso: Record<MetricaDeUso, number>;
  limites: Record<string, { limite: number | null; usado: number | null }>;
}

export interface PagoRegistrado {
  importeCentimos: number;
  moneda: string;
  cubreDesde: Date;
  cubreHasta: Date;
  metodo: string;
  referencia: string | null;
}

export interface AvisoDeLimite {
  limite: string;
  nivel: NivelDeConsumo;
  usado: number;
  tope: number;
}

export interface ResumenDeSuscripcion {
  plan: { codigo: string; nombre: string; precioPorAsientoCentimos: number; moneda: string } | null;
  estado: EstadoEfectivo;
  /** Asientos OCUPADOS: se cuentan de `memberships`, no se guardan (ADR-011). */
  asientos: number;
  importeMensualCentimos: number;
  pruebaHasta: Date | null;
  periodoHasta: Date | null;
  graciaHasta: Date | null;
  pagos: PagoRegistrado[];
  avisos: AvisoDeLimite[];
}

export class UsoService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  constructor(o: { db: BaseDeDatos; ahora?: () => Date }) {
    this.#db = o.db;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  async resumen(): Promise<ResumenDeUso> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    const ahora = this.#ahora();

    return this.#db.enTransaccion(async (c) => {
      const plan = await c.query<{ code: string; limits: Record<string, unknown> }>(
        `SELECT p.code, p.limits FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.tenant_id = $1`,
        [ctx.tenantId],
      );
      const uso = await leerUsoDelPeriodo(c, ctx.tenantId, ahora);

      const limites: ResumenDeUso['limites'] = {};
      const lim = plan.rows[0]?.limits ?? {};
      for (const [clave, valor] of Object.entries(lim)) {
        const metrica = (Object.keys(LIMITE_POR_METRICA) as MetricaDeUso[]).find(
          (m) => LIMITE_POR_METRICA[m] === clave,
        );
        limites[clave] = {
          limite: typeof valor === 'number' ? valor : null,
          usado: metrica ? uso[metrica] : null,
        };
      }
      return {
        periodo: etiquetaDePeriodo(ahora),
        desde: inicioDePeriodo(ahora),
        plan: plan.rows[0]?.code ?? null,
        uso,
        limites,
      };
    });
  }

  /**
   * Qué se paga, por qué y hasta cuándo está cubierto.
   *
   * El importe se calcula al mirarlo —precio del plan por asientos ocupados—
   * en vez de leerse de una columna: una columna `seats` hay que mantenerla
   * sincronizada con cada alta y baja de usuario, y el día que se
   * desincronice le cobra de más a un cliente, que es el error que sí se nota.
   */
  async suscripcion(): Promise<ResumenDeSuscripcion> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    const ahora = this.#ahora();

    return this.#db.enTransaccion(async (c) => {
      const { rows: filas } = await c.query<{
        code: string;
        name: string;
        price_cents: number;
        currency: string;
        limits: Record<string, unknown>;
        status: Suscripcion['estadoDeclarado'];
        trial_ends_at: Date | null;
        current_period_ends_at: Date | null;
        grace_days: number;
      }>(
        `SELECT p.code, p.name, p.price_cents, p.currency, p.limits,
                s.status, s.trial_ends_at, s.current_period_ends_at, s.grace_days
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.tenant_id = $1`,
        [ctx.tenantId],
      );
      const f = filas[0];
      const suscripcion: Suscripcion = {
        estadoDeclarado: f?.status ?? 'trialing',
        pruebaHasta: f?.trial_ends_at ?? null,
        periodoHasta: f?.current_period_ends_at ?? null,
        diasDeGracia: f?.grace_days ?? 0,
      };

      const { rows: asientos } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM memberships WHERE tenant_id = $1`,
        [ctx.tenantId],
      );
      const ocupados = Number(asientos[0]?.n ?? 0);

      const { rows: pagos } = await c.query<{
        amount_cents: number;
        currency: string;
        covers_from: Date;
        covers_to: Date;
        method: string;
        reference: string | null;
      }>(
        `SELECT amount_cents, currency, covers_from, covers_to, method, reference
           FROM subscription_payments
          WHERE tenant_id = $1
          ORDER BY covers_to DESC
          LIMIT 12`,
        [ctx.tenantId],
      );

      const uso = await leerUsoDelPeriodo(c, ctx.tenantId, ahora);
      const limites = f?.limits ?? {};
      const avisos: AvisoDeLimite[] = [];
      const anotar = (clave: string, usado: number) => {
        const tope = limites[clave];
        if (typeof tope !== 'number') return;
        const nivel = nivelDeConsumo(usado, tope);
        if (nivel !== 'holgado') avisos.push({ limite: clave, nivel, usado, tope });
      };
      anotar('agentes', ocupados);
      anotar('conversaciones_mes', uso['conversations.opened']);
      anotar('bot_runs_mes', uso['bot.runs']);

      return {
        plan: f
          ? {
              codigo: f.code,
              nombre: f.name,
              precioPorAsientoCentimos: f.price_cents,
              moneda: f.currency,
            }
          : null,
        estado: estadoEfectivo(suscripcion, ahora),
        asientos: ocupados,
        importeMensualCentimos: importeMensualEnCentimos(f?.price_cents ?? 0, ocupados),
        pruebaHasta: suscripcion.pruebaHasta,
        periodoHasta: suscripcion.periodoHasta,
        graciaHasta: graciaHasta(suscripcion),
        pagos: pagos.map((p) => ({
          importeCentimos: p.amount_cents,
          moneda: p.currency,
          cubreDesde: p.covers_from,
          cubreHasta: p.covers_to,
          metodo: p.method,
          referencia: p.reference,
        })),
        avisos,
      };
    });
  }

  /**
   * ¿Cabe un asiento más en el plan? Lo pregunta la invitación.
   *
   * Cuenta los miembros y las invitaciones pendientes: si no contara las
   * pendientes, tres invitaciones enviadas a la vez meterían tres asientos por
   * encima del tope y el aviso llegaría cuando ya no se puede deshacer.
   */
  async cabeOtroAsiento(c: PoolClient, tenantId: string): Promise<boolean> {
    const { rows } = await c.query<{ ocupados: string; tope: number | null }>(
      `SELECT (SELECT count(*) FROM memberships m WHERE m.tenant_id = $1)
            + (SELECT count(*) FROM invitations i
                WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now())
              AS ocupados,
             (p.limits ->> 'agentes')::int AS tope
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1`,
      [tenantId],
    );
    const fila = rows[0];
    if (!fila) return true;
    return cabeUnoMas(Number(fila.ocupados), fila.tope);
  }
}
