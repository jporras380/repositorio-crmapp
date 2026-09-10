/**
 * Registra un pago de suscripción y extiende el periodo cubierto (ADR-011).
 *
 *   pnpm suscripcion:pago --cuenta=<slug> --meses=3 --importe=7500
 *   pnpm suscripcion:pago --cuenta=acme --meses=1 --referencia="OP 4471" --metodo=transferencia
 *
 * **Es un script y no una pantalla, a propósito.** El cobro es manual: quien
 * registra un pago es el operador, nunca el inquilino desde su sesión. Una
 * pantalla para esto significaría un backoffice con su propia autenticación y
 * su propio riesgo de escalada de privilegios; un script que corre con el rol
 * de migración no añade superficie ninguna. Por eso `subscription_payments`
 * es de solo lectura para el rol de la aplicación (migración 0016).
 *
 * El importe es informativo —lo que de verdad manda es hasta cuándo queda
 * cubierta la cuenta— pero se guarda porque es lo que se concilia con el banco.
 */
import { Pool } from 'pg';

function argumento(nombre: string): string | undefined {
  const prefijo = `--${nombre}=`;
  return process.argv.find((a) => a.startsWith(prefijo))?.slice(prefijo.length);
}

const slug = argumento('cuenta');
const meses = Number(argumento('meses') ?? '1');
const importe = Number(argumento('importe') ?? '0');
const metodo = argumento('metodo') ?? 'transferencia';
const referencia = argumento('referencia') ?? null;
const nota = argumento('nota') ?? null;

if (!slug || !Number.isInteger(meses) || meses < 1) {
  console.error(
    'Uso: pnpm suscripcion:pago --cuenta=<slug> --meses=<n> [--importe=<centimos>] ' +
      '[--metodo=transferencia|efectivo|tarjeta|otro] [--referencia=…] [--nota=…]',
  );
  process.exit(1);
}

const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) {
  console.error('Falta DATABASE_MIGRATION_URL en .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const c = await pool.connect();
try {
  await c.query('BEGIN');

  const { rows: cuentas } = await c.query<{ id: string; nombre: string }>(
    `SELECT id, name AS nombre FROM tenants WHERE slug = $1`,
    [slug],
  );
  const cuenta = cuentas[0];
  if (!cuenta) {
    console.error(`No existe la cuenta "${slug}".`);
    process.exit(1);
  }
  // RLS está FORZADA también para el dueño de las tablas: sin inquilino en la
  // transacción, este script no vería ni escribiría nada (ADR-005).
  await c.query(`SET LOCAL app.tenant_id = '${cuenta.id}'`);

  const { rows: subs } = await c.query<{
    current_period_ends_at: Date | null;
    trial_ends_at: Date | null;
    price_cents: number;
    currency: string;
  }>(
    `SELECT s.current_period_ends_at, s.trial_ends_at, p.price_cents, p.currency
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1
      FOR UPDATE OF s`,
    [cuenta.id],
  );
  const sub = subs[0];
  if (!sub) {
    console.error(`La cuenta "${slug}" no tiene suscripción.`);
    process.exit(1);
  }

  const { rows: asientos } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM memberships WHERE tenant_id = $1`,
    [cuenta.id],
  );
  const ocupados = Number(asientos[0]!.n);
  const importeFinal = importe > 0 ? importe : sub.price_cents * ocupados * meses;

  // Se extiende desde lo que ya estaba cubierto, no desde hoy: pagar con dos
  // días de adelanto no debe regalar ni quitar tiempo.
  const ahora = new Date();
  const base = [sub.current_period_ends_at, sub.trial_ends_at, ahora]
    .filter((d): d is Date => d instanceof Date)
    .reduce((a, b) => (a > b ? a : b), ahora);
  const hasta = new Date(base);
  hasta.setUTCMonth(hasta.getUTCMonth() + meses);

  await c.query(
    `INSERT INTO subscription_payments
       (tenant_id, amount_cents, currency, covers_from, covers_to, method, reference, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [cuenta.id, importeFinal, sub.currency, base, hasta, metodo, referencia, nota],
  );
  await c.query(
    `UPDATE subscriptions
        SET current_period_ends_at = $2, status = 'active',
            cached_state = 'activa', cached_state_at = now(), updated_at = now()
      WHERE tenant_id = $1`,
    [cuenta.id, hasta],
  );
  await c.query(
    `INSERT INTO audit_log (tenant_id, action, entity_type, meta)
     VALUES ($1, 'suscripcion.pago_registrado', 'subscription', $2)`,
    [cuenta.id, JSON.stringify({ meses, importeFinal, metodo, referencia })],
  );

  await c.query('COMMIT');
  console.log(
    `Pago registrado para "${cuenta.nombre}": ${(importeFinal / 100).toFixed(2)} ${sub.currency}, ` +
      `${ocupados} asiento(s), ${meses} mes(es). Cubierta hasta ${hasta.toISOString().slice(0, 10)}.`,
  );
} catch (error) {
  await c.query('ROLLBACK').catch(() => undefined);
  console.error('No se pudo registrar el pago:', error);
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
