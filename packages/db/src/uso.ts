/**
 * Medición de uso (ARCH §5.9). Se registran HECHOS; qué se cobra es P-21.
 *
 * `registrarUso` se llama dentro de la misma transacción que el hecho que
 * mide: si el mensaje no se guarda, el evento tampoco. Es idempotente por
 * `dedupKey` (ADR-006: clave aparte, sin particionar) y mantiene el agregado
 * mensual en la misma transacción, así la factura lee `usage_rollups` y
 * nunca cuenta filas de `messages`.
 */
import type { PoolClient } from 'pg';

export type MetricaDeUso =
  | 'messages.inbound'
  | 'messages.outbound'
  | 'templates.sent'
  | 'conversations.opened'
  | 'media.stored_bytes';

export const METRICAS_DE_USO: readonly MetricaDeUso[] = [
  'messages.inbound',
  'messages.outbound',
  'templates.sent',
  'conversations.opened',
  'media.stored_bytes',
];

export interface EventoDeUso {
  tenantId: string;
  metric: MetricaDeUso;
  /** Por defecto 1. En bytes para `media.stored_bytes`. */
  quantity?: number;
  /** Única en todo el sistema: `message:<id>:outbound`, `media:<id>:stored`… */
  dedupKey: string;
  occurredAt?: Date;
  meta?: Record<string, unknown>;
}

/** Primer instante del mes, en UTC. El periodo de facturación no depende del huso del servidor. */
export function inicioDePeriodo(fecha: Date): Date {
  return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), 1));
}

/** Etiqueta `YYYY-MM` de un periodo. */
export function etiquetaDePeriodo(fecha: Date): string {
  const p = inicioDePeriodo(fecha);
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Registra un evento de uso. Devuelve `false` si esa clave ya se había registrado. */
export async function registrarUso(c: PoolClient, e: EventoDeUso): Promise<boolean> {
  const cantidad = e.quantity ?? 1;
  const ocurridoEn = e.occurredAt ?? new Date();

  const clave = await c.query(
    `INSERT INTO usage_event_keys (dedup_key, tenant_id, occurred_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [e.dedupKey, e.tenantId, ocurridoEn],
  );
  if ((clave.rowCount ?? 0) === 0) return false;

  await c.query(
    `INSERT INTO usage_events (tenant_id, metric, quantity, occurred_at, dedup_key, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.tenantId, e.metric, cantidad, ocurridoEn, e.dedupKey, JSON.stringify(e.meta ?? {})],
  );
  await c.query(
    `INSERT INTO usage_rollups (tenant_id, metric, period, quantity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, metric, period)
       DO UPDATE SET quantity = usage_rollups.quantity + EXCLUDED.quantity, updated_at = now()`,
    [e.tenantId, e.metric, inicioDePeriodo(ocurridoEn), cantidad],
  );
  return true;
}

/** Uso acumulado del inquilino en el periodo, con todas las métricas presentes (0 si no hay). */
export async function leerUsoDelPeriodo(
  c: PoolClient,
  tenantId: string,
  periodo: Date,
): Promise<Record<MetricaDeUso, number>> {
  const { rows } = await c.query<{ metric: MetricaDeUso; quantity: string }>(
    `SELECT metric, quantity FROM usage_rollups WHERE tenant_id = $1 AND period = $2`,
    [tenantId, inicioDePeriodo(periodo)],
  );
  const uso = Object.fromEntries(METRICAS_DE_USO.map((m) => [m, 0])) as Record<
    MetricaDeUso,
    number
  >;
  for (const r of rows) uso[r.metric] = Number(r.quantity);
  return uso;
}
