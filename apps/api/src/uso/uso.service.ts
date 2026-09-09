/**
 * Uso del periodo frente a los límites del plan. Solo lectura: qué se cobra y
 * qué pasa al superar un límite es P-21 (lista de parada). Mientras tanto la
 * cuenta puede VER su consumo, que es lo que evita la sorpresa del día de
 * cobro.
 */
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
};

export interface ResumenDeUso {
  periodo: string;
  desde: Date;
  plan: string | null;
  uso: Record<MetricaDeUso, number>;
  limites: Record<string, { limite: number | null; usado: number | null }>;
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
}
