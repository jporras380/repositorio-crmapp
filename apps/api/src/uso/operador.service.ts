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
import { contextoActual, type BaseDeDatos } from '../db.js';

export interface PagoDeOperador {
  tenantId: string;
  pagoId: string;
  mediaAssetId: string;
  numero?: string | undefined;
}

export class OperadorService {
  readonly #db: BaseDeDatos;

  constructor(o: { db: BaseDeDatos }) {
    this.#db = o.db;
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
