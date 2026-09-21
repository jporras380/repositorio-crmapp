/**
 * Lo que hace el personal de la PLATAFORMA sobre la cuenta de un hotel.
 *
 * Hoy, una sola cosa: subir el comprobante de un pago. Es el único caso en
 * que alguien de fuera de un inquilino escribe dentro de él, y por eso vive
 * en su propio archivo en vez de esconderse como un método más del servicio
 * de uso — un cruce de inquilino tiene que verse en cualquier revisión.
 *
 * ## Qué protege esto
 *
 * El aislamiento entre inquilinos es la promesa sobre la que descansa el
 * producto entero. Aquí se atraviesa a propósito, así que hay tres cierres y
 * cada uno haría falta aunque fallaran los otros dos:
 *
 * 1. **`users.is_operator`**, que no se puede activar desde la aplicación: se
 *    pone por consola. Un botón de «hazme operador» es un botón de «dame
 *    todas las cuentas».
 * 2. **El contexto se fija al inquilino de destino** con el mismo mecanismo de
 *    siempre (`withTenant`), así que la RLS sigue aplicándose dentro. No se
 *    desactiva nada: se entra por la puerta del hotel, no por la ventana.
 * 3. **Todo queda en la auditoría del inquilino**, con el usuario de la
 *    plataforma que lo hizo. El hotel puede ver quién tocó su cuenta.
 *
 * ## Lo que NO puede hacer
 *
 * Leer conversaciones, mensajes, contactos ni reservas. El operador ve
 * facturación y consumo, que es lo que necesita para cobrar y para saber si
 * la cuenta va bien. Lo demás es correspondencia de huéspedes.
 */
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { inicioDePeriodo } from '@crmapp/db';
import { contextoActual, type BaseDeDatos } from '../db.js';

/** Una cuenta vista desde fuera: lo justo para cobrar y para saber si va bien. */
export interface CuentaEnLaConsola {
  tenantId: string;
  nombre: string;
  slug: string;
  altaEn: Date;
  plan: string | null;
  /** Declarado en la tabla; el efectivo lo calcula `core` al pintarlo. */
  estado: string;
  pruebaHasta: Date | null;
  periodoHasta: Date | null;
  diasDeGracia: number;
  asientos: number;
  importeMensualCentimos: number;
  moneda: string;
  /** Cuántos comprobantes le debemos. Lo primero que mira el operador. */
  comprobantesPendientes: number;
  /** El más viejo sin subir: si pasó de 48 h, vamos tarde con ESE. */
  comprobanteMasViejoEn: Date | null;
  /** Canales conectados y cuál fue el último evento que llegó de alguno. */
  canales: number;
  canalesConProblema: number;
  ultimoEventoEn: Date | null;
  /** Mensajes de este mes, para ver de un vistazo si la cuenta está viva. */
  mensajesDelMes: number;
}

export interface PagoDeOperador {
  tenantId: string;
  pagoId: string;
  mediaAssetId: string;
  numero?: string | undefined;
}

export class OperadorService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  constructor(o: { db: BaseDeDatos; ahora?: () => Date }) {
    this.#db = o.db;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  /**
   * Adjunta el comprobante a un pago de la cuenta que se diga.
   *
   * El archivo tiene que estar ya subido y confirmado **dentro de esa cuenta**:
   * un medio de otro inquilino no se encuentra desde aquí, porque la consulta
   * corre bajo su RLS. Así no hace falta comprobar la pertenencia a mano, que
   * es la comprobación que alguien acaba olvidando.
   */
  async adjuntarComprobante(datos: PagoDeOperador): Promise<{ adjuntado: true }> {
    const operador = await this.#exigirOperador();

    return this.#db.paraInquilino(datos.tenantId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE subscription_payments
            SET receipt_media_id = $2, receipt_uploaded_at = now(), receipt_number = $3
          WHERE id = $1
            AND EXISTS (SELECT 1 FROM media_assets m
                         WHERE m.id = $2 AND m.status = 'stored')
        RETURNING id`,
        [datos.pagoId, datos.mediaAssetId, datos.numero ?? null],
      );
      if (rows.length === 0) {
        // Un solo mensaje para «no existe el pago», «no es de esta cuenta» y
        // «el archivo no está subido»: por separado le dirían a quien prueba
        // identificadores cuáles existen.
        throw new ErrorDeNegocio(
          'pago_o_medio_no_valido',
          'No se encontró ese pago en esa cuenta, o el archivo no está subido.',
          404,
        );
      }

      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'suscripcion.comprobante_subido', 'subscription_payment', $3, $4)`,
        [
          datos.tenantId,
          operador,
          datos.pagoId,
          JSON.stringify({ porElOperador: true, numero: datos.numero ?? null }),
        ],
      );
      return { adjuntado: true as const };
    });
  }

  /**
   * Todas las cuentas, con lo que hace falta para cobrar y para saber si van
   * bien.
   *
   * ## Por qué una sola consulta y no una por inquilino
   *
   * Recorrer inquilinos entrando en el contexto de cada uno habría mantenido
   * la RLS de siempre, pero son cinco consultas por cuenta: con cien cuentas,
   * quinientas idas y vueltas para pintar una tabla. El rol `crmapp_operador`
   * (0040) existe justo para esto, y lo que puede leer está escrito en su
   * migración: facturación y salud, nunca conversaciones.
   *
   * Ordenadas por lo que hay que atender antes: primero a quien le debemos un
   * comprobante, luego lo que vence antes.
   */
  async cuentas(): Promise<CuentaEnLaConsola[]> {
    await this.#exigirOperador();
    const periodo = inicioDePeriodo(this.#ahora());

    return this.#db.comoOperadorDeLaPlataforma(async (c) => {
      const { rows } = await c.query<{
        tenant_id: string;
        nombre: string;
        slug: string;
        alta_en: Date;
        plan: string | null;
        estado: string;
        prueba_hasta: Date | null;
        periodo_hasta: Date | null;
        dias_de_gracia: number;
        precio_centimos: number | null;
        moneda: string | null;
        asientos: string;
        comprobantes_pendientes: string;
        comprobante_mas_viejo_en: Date | null;
        canales: string;
        canales_con_problema: string;
        ultimo_evento_en: Date | null;
        mensajes_del_mes: string;
      }>(
        `SELECT t.id AS tenant_id, t.name AS nombre, t.slug, t.created_at AS alta_en,
                p.name AS plan, p.price_cents AS precio_centimos, p.currency AS moneda,
                COALESCE(s.status, 'trialing') AS estado,
                s.trial_ends_at AS prueba_hasta,
                s.current_period_ends_at AS periodo_hasta,
                COALESCE(s.grace_days, 0) AS dias_de_gracia,
                (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id) AS asientos,
                (SELECT count(*) FROM subscription_payments sp
                  WHERE sp.tenant_id = t.id AND sp.receipt_media_id IS NULL)
                  AS comprobantes_pendientes,
                (SELECT min(sp.created_at) FROM subscription_payments sp
                  WHERE sp.tenant_id = t.id AND sp.receipt_media_id IS NULL)
                  AS comprobante_mas_viejo_en,
                (SELECT count(*) FROM channel_accounts ca WHERE ca.tenant_id = t.id)
                  AS canales,
                (SELECT count(*) FROM channel_accounts ca
                  WHERE ca.tenant_id = t.id AND ca.status <> 'connected') AS canales_con_problema,
                (SELECT max(ca.last_event_at) FROM channel_accounts ca WHERE ca.tenant_id = t.id)
                  AS ultimo_evento_en,
                COALESCE((SELECT sum(r.quantity) FROM usage_rollups r
                           WHERE r.tenant_id = t.id AND r.period = $1
                             AND r.metric IN ('message.inbound', 'message.outbound')), 0)
                  AS mensajes_del_mes
           FROM tenants t
           LEFT JOIN subscriptions s ON s.tenant_id = t.id
           LEFT JOIN plans p ON p.id = s.plan_id
          ORDER BY comprobantes_pendientes DESC, periodo_hasta ASC NULLS LAST, t.name`,
        [periodo],
      );

      return rows.map((f) => {
        const asientos = Number(f.asientos);
        return {
          tenantId: f.tenant_id,
          nombre: f.nombre,
          slug: f.slug,
          altaEn: f.alta_en,
          plan: f.plan,
          estado: f.estado,
          pruebaHasta: f.prueba_hasta,
          periodoHasta: f.periodo_hasta,
          diasDeGracia: f.dias_de_gracia,
          asientos,
          // Mismo cálculo que ve el hotel en su pantalla: precio por asiento
          // ocupado. Si aquí saliera otro número, una de las dos miente.
          importeMensualCentimos: (f.precio_centimos ?? 0) * asientos,
          moneda: f.moneda ?? 'USD',
          comprobantesPendientes: Number(f.comprobantes_pendientes),
          comprobanteMasViejoEn: f.comprobante_mas_viejo_en,
          canales: Number(f.canales),
          canalesConProblema: Number(f.canales_con_problema),
          ultimoEventoEn: f.ultimo_evento_en,
          mensajesDelMes: Number(f.mensajes_del_mes),
        };
      });
    });
  }

  /** Quién es, si de verdad es personal de la plataforma. */
  async #exigirOperador(): Promise<string> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    const esOperador = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{ is_operator: boolean }>(
        `SELECT is_operator FROM users WHERE id = $1`,
        [ctx.userId],
      );
      return rows[0]?.is_operator === true;
    });
    if (!esOperador) {
      // 404 y no 403: quien no es operador no tiene por qué saber que este
      // camino existe.
      throw new ErrorDeNegocio('no_encontrado', 'No existe esa ruta.', 404);
    }
    return ctx.userId;
  }
}
