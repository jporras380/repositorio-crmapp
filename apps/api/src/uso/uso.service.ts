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
  venceElComprobante,
  problemasDeFacturacion,
  type TipoDeComprobante,
} from '@crmapp/core';
import {
  etiquetaDePeriodo,
  inicioDePeriodo,
  leerUsoDelPeriodo,
  type MetricaDeUso,
} from '@crmapp/db';
import type { Almacen } from '@crmapp/storage';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

/** Qué métrica alimenta cada límite del plan (`plans.limits`). */
const LIMITE_POR_METRICA: Partial<Record<MetricaDeUso, string>> = {
  'conversations.opened': 'conversaciones_mes',
  'bot.runs': 'bot_runs_mes',
  // Los créditos de IA son las sugerencias: el plan los llama de una forma y
  // la métrica de otra, y por eso la pantalla decía «sin medir» sobre un
  // número que se estaba contando desde 0038.
  'ai.suggestions': 'creditos_ia_mes',
};

/**
 * Topes que no son un contador del mes sino un estado de ahora mismo.
 *
 * `agentes` y `canales` no se acumulan: son cuántos hay **hoy**. No podían
 * salir de `usage_events`, y por eso la pantalla de lo que se paga decía «sin
 * medir» justo en la línea por la que se cobra (ADR-011, cobro por asiento).
 *
 * El de agentes se cuenta igual que al invitar —miembros más invitaciones
 * vivas— y con la misma consulta, para que la pantalla no diga 2 mientras el
 * tope rechaza al tercero.
 */
const CUENTAS_DEL_MOMENTO: Record<string, string> = {
  // El alias importa: sin él, una suma de subconsultas sale como `?column?`,
  // leerla por nombre da `undefined` y la pantalla enseña un 0 tranquilizador.
  // Es peor que «sin medir», porque parece un dato.
  agentes: `SELECT (SELECT count(*) FROM memberships WHERE tenant_id = $1)
                 + (SELECT count(*) FROM invitations
                     WHERE tenant_id = $1 AND accepted_at IS NULL AND expires_at > now())
                 AS cuenta`,
  canales: `SELECT count(*) AS cuenta FROM channel_accounts WHERE tenant_id = $1`,
};

export interface ResumenDeUso {
  periodo: string;
  desde: Date;
  plan: string | null;
  uso: Record<MetricaDeUso, number>;
  limites: Record<string, { limite: number | null; usado: number | null }>;
}

export interface PagoRegistrado {
  id: string;
  importeCentimos: number;
  moneda: string;
  cubreDesde: Date;
  cubreHasta: Date;
  metodo: string;
  referencia: string | null;
  /**
   * El comprobante de este pago (0039).
   *
   * `pendiente` mientras no esté subido y no haya vencido el plazo;
   * `retrasado` cuando pasaron las 48 horas y sigue sin subirse. Distinguirlo
   * importa: lo primero es normal y lo segundo es un incumplimiento nuestro
   * que el hotel tiene derecho a ver sin preguntar.
   */
  comprobante: {
    estado: 'pendiente' | 'retrasado' | 'disponible';
    /** Para descargarlo; `null` mientras no esté. */
    medioId: string | null;
    numero: string | null;
    venceEn: Date;
    subidoEn: Date | null;
  };
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
  /** A nombre de quién y con qué documento se emiten los comprobantes (0039). */
  facturacion: DatosDeFacturacionDelHotel;
  /** A dónde pagar (0048). Antes esto no se decía en ningún sitio. */
  comoPagar: ComoPagar;
  /** Lo que este cliente ya declaró haber pagado, y en qué quedó. */
  declaraciones: DeclaracionDePago[];
}

/**
 * A dónde transferir, con las palabras del operador.
 *
 * Todo opcional: mientras no lo rellene, la pantalla del cliente no promete un
 * método que no existe en vez de enseñar campos vacíos.
 */
export interface ComoPagar {
  banco: string | null;
  tipoDeCuenta: string | null;
  numeroDeCuenta: string | null;
  cci: string | null;
  titular: string | null;
  documentoTitular: string | null;
  numeroBilletera: string | null;
  titularBilletera: string | null;
  /** `true` si hay QR subido. La URL se firma aparte y caduca. */
  hayQr: boolean;
  /** Lo que toca pagar en soles, si el operador lo fijó para este plan. */
  solesCentimos: number | null;
  nota: string | null;
}

export interface DeclaracionDePago {
  id: string;
  importeCentimos: number;
  moneda: string;
  metodo: string;
  referencia: string | null;
  pagadoEl: Date;
  medioId: string | null;
  estado: 'pendiente' | 'confirmado' | 'rechazado';
  revisadoEn: Date | null;
  notaDeRevision: string | null;
  creadoEn: Date;
}

export interface DatosDeFacturacionDelHotel {
  tipo: TipoDeComprobante;
  /** RUC si es factura, DNI si es boleta. */
  documento: string | null;
  nombre: string | null;
  direccion: string | null;
}

export class UsoService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  /** `null` si el almacenamiento no está configurado: el QR responde 503. */
  readonly #almacen: Almacen | null;

  constructor(o: { db: BaseDeDatos; almacen?: Almacen | null; ahora?: () => Date }) {
    this.#db = o.db;
    this.#almacen = o.almacen ?? null;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  /**
   * El QR de Yape o Plin de la plataforma, firmado.
   *
   * Lo pide cualquier usuario con sesión, de cualquier cuenta: es justo el
   * dato que hay que enseñar para cobrar. La clave sale de la fila global de
   * ajustes, no de `media_assets`, así que la RLS de esa tabla no estorba.
   */
  async qrDeCobro(): Promise<{ url: string; expiraEnSegundos: number }> {
    if (!contextoActual()) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    if (!this.#almacen) {
      throw new ErrorDeNegocio(
        'almacenamiento_no_configurado',
        'El almacenamiento no está configurado.',
        503,
      );
    }
    const almacen = this.#almacen;
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ qr_storage_key: string | null }>(
        `SELECT qr_storage_key FROM platform_payment_settings WHERE id = 1`,
      );
      const clave = rows[0]?.qr_storage_key;
      if (!clave) throw new ErrorDeNegocio('sin_qr', 'No hay ningún QR publicado.', 404);
      return { url: await almacen.urlDeLectura(clave, 300), expiraEnSegundos: 300 };
    });
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
        let usado: number | null = metrica ? uso[metrica] : null;
        // Lo que no es un contador del mes se cuenta ahora. «Sin medir» solo
        // debe quedar para lo que de verdad no se sabe.
        const consulta = CUENTAS_DEL_MOMENTO[clave];
        if (usado === null && consulta) {
          const { rows } = await c.query<{ cuenta: string }>(consulta, [ctx.tenantId]);
          usado = Number(rows[0]?.cuenta ?? 0);
        }
        limites[clave] = { limite: typeof valor === 'number' ? valor : null, usado };
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
        billing_doc_type: string;
        billing_tax_id: string | null;
        billing_name: string | null;
        billing_address: string | null;
      }>(
        `SELECT p.code, p.name, p.price_cents, p.currency, p.limits,
                s.status, s.trial_ends_at, s.current_period_ends_at, s.grace_days,
                s.billing_doc_type, s.billing_tax_id, s.billing_name, s.billing_address
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
        id: string;
        created_at: Date;
        receipt_media_id: string | null;
        receipt_uploaded_at: Date | null;
        receipt_number: string | null;
      }>(
        `SELECT id, amount_cents, currency, covers_from, covers_to, method, reference,
                created_at, receipt_media_id, receipt_uploaded_at, receipt_number
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

      // A dónde pagar (0048). Una sola fila global; la lee cualquiera porque es
      // justo lo que hay que enseñar para cobrar.
      const { rows: cobro } = await c.query<{
        banco: string | null;
        tipo_de_cuenta: string | null;
        numero_de_cuenta: string | null;
        cci: string | null;
        titular: string | null;
        documento_titular: string | null;
        numero_billetera: string | null;
        titular_billetera: string | null;
        qr_storage_key: string | null;
        soles_por_plan: Record<string, number>;
        nota: string | null;
      }>(`SELECT * FROM platform_payment_settings WHERE id = 1`);
      const p = cobro[0];
      const comoPagar: ComoPagar = {
        banco: p?.banco ?? null,
        tipoDeCuenta: p?.tipo_de_cuenta ?? null,
        numeroDeCuenta: p?.numero_de_cuenta ?? null,
        cci: p?.cci ?? null,
        titular: p?.titular ?? null,
        documentoTitular: p?.documento_titular ?? null,
        numeroBilletera: p?.numero_billetera ?? null,
        titularBilletera: p?.titular_billetera ?? null,
        hayQr: Boolean(p?.qr_storage_key),
        // El importe en soles es POR PLAN: si el operador no lo fijó para el
        // de este cliente, no se inventa una conversión.
        solesCentimos: f?.code ? (p?.soles_por_plan?.[f.code] ?? null) : null,
        nota: p?.nota ?? null,
      };

      const { rows: decl } = await c.query<{
        id: string;
        amount_cents: number;
        currency: string;
        method: string;
        reference: string | null;
        paid_at: Date;
        media_asset_id: string | null;
        status: DeclaracionDePago['estado'];
        reviewed_at: Date | null;
        review_note: string | null;
        created_at: Date;
      }>(
        `SELECT id, amount_cents, currency, method, reference, paid_at, media_asset_id,
                status, reviewed_at, review_note, created_at
           FROM payment_claims
          WHERE tenant_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [ctx.tenantId],
      );
      const declaraciones: DeclaracionDePago[] = decl.map((d) => ({
        id: d.id,
        importeCentimos: d.amount_cents,
        moneda: d.currency,
        metodo: d.method,
        referencia: d.reference,
        pagadoEl: d.paid_at,
        medioId: d.media_asset_id,
        estado: d.status,
        revisadoEn: d.reviewed_at,
        notaDeRevision: d.review_note,
        creadoEn: d.created_at,
      }));

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
        facturacion: {
          tipo: (f?.billing_doc_type ?? 'boleta') as TipoDeComprobante,
          documento: f?.billing_tax_id ?? null,
          nombre: f?.billing_name ?? null,
          direccion: f?.billing_address ?? null,
        },
        comoPagar,
        declaraciones,
        pruebaHasta: suscripcion.pruebaHasta,
        periodoHasta: suscripcion.periodoHasta,
        graciaHasta: graciaHasta(suscripcion),
        pagos: pagos.map((p) => {
          // El plazo se cuenta desde que se REGISTRA el pago, no desde lo que
          // cubre: un pago de enero registrado en marzo no nace vencido.
          const venceEn = venceElComprobante(p.created_at);
          return {
            id: p.id,
            importeCentimos: p.amount_cents,
            moneda: p.currency,
            cubreDesde: p.covers_from,
            cubreHasta: p.covers_to,
            metodo: p.method,
            referencia: p.reference,
            comprobante: {
              estado: p.receipt_media_id
                ? ('disponible' as const)
                : venceEn.getTime() < ahora.getTime()
                  ? ('retrasado' as const)
                  : ('pendiente' as const),
              medioId: p.receipt_media_id,
              numero: p.receipt_number,
              venceEn,
              subidoEn: p.receipt_uploaded_at,
            },
          };
        }),
        avisos,
      };
    });
  }

  /**
   * Guarda a nombre de quién se emiten los comprobantes.
   *
   * Lo comprueba `problemasDeFacturacion` (core) ANTES de tocar la base: una
   * factura sin RUC la rechaza SUNAT semanas después, con el crédito fiscal ya
   * perdido, y para entonces nadie se acuerda de qué se escribió aquí.
   *
   * Solo owner o admin: es un dato fiscal de la empresa, no una preferencia.
   */
  /**
   * El cliente declara que ya pagó, y adjunta su voucher.
   *
   * **No es un pago.** Es una declaración: entra en `payment_claims` y no en
   * `subscription_payments`, que es el libro que decide si la cuenta sigue
   * viva. Escribir ahí dejaría que cualquiera se diera por pagado; aquí
   * declara, y el operador confirma.
   *
   * El comprobante se valida en el mismo INSERT, como los adjuntos del chat
   * de soporte (0044): si el archivo no es de esta cuenta o no está subido, la
   * fila no entra.
   */
  async declararPago(datos: {
    importeCentimos: number;
    moneda: string;
    metodo: 'transferencia' | 'yape' | 'plin' | 'otro';
    referencia?: string | undefined;
    pagadoEl: string;
    mediaAssetId?: string | undefined;
  }): Promise<ResumenDeSuscripcion> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo el dueño o un administrador declara un pago.',
        403,
      );
    }

    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO payment_claims (tenant_id, declared_by, amount_cents, currency,
                                     method, reference, paid_at, media_asset_id)
         SELECT $1, $2, $3, $4, $5, $6, $7::date, $8::uuid
          WHERE $8::uuid IS NULL
             OR EXISTS (SELECT 1 FROM media_assets a
                         WHERE a.id = $8::uuid AND a.tenant_id = $1 AND a.status = 'stored')
        RETURNING id`,
        [
          ctx.tenantId,
          ctx.userId,
          datos.importeCentimos,
          datos.moneda,
          datos.metodo,
          datos.referencia ?? null,
          datos.pagadoEl,
          datos.mediaAssetId ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio(
          'comprobante_no_valido',
          'Ese archivo no está subido o no es de esta cuenta.',
          409,
        );
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'suscripcion.pago_declarado', 'payment_claim', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          rows[0]!.id,
          JSON.stringify({ importeCentimos: datos.importeCentimos, metodo: datos.metodo }),
        ],
      );
    });
    return this.suscripcion();
  }

  async guardarFacturacion(datos: DatosDeFacturacionDelHotel): Promise<ResumenDeSuscripcion> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio('sin_permiso', 'Solo el dueño o un administrador.', 403);
    }

    const problemas = problemasDeFacturacion(datos);
    if (problemas.length > 0) {
      throw new ErrorDeNegocio('facturacion_incompleta', problemas.join(' '), 422);
    }

    await this.#db.enTransaccion(async (c) => {
      const limpio = (v: string | null) => v?.trim() || null;
      await c.query(
        `UPDATE subscriptions
            SET billing_doc_type = $2, billing_tax_id = $3,
                billing_name = $4, billing_address = $5, updated_at = now()
          WHERE tenant_id = $1`,
        [
          ctx.tenantId,
          datos.tipo,
          limpio(datos.documento),
          limpio(datos.nombre),
          limpio(datos.direccion),
        ],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'suscripcion.facturacion', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify({ tipo: datos.tipo })],
      );
    });
    return this.suscripcion();
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
