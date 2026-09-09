/**
 * Recepción de webhooks (ARCH §7, requisito 8.3).
 *
 * El camino completo es: validar firma → persistir el crudo → encolar →
 * responder 200 en menos de un segundo. **Aquí no se procesa nada.**
 *
 * La razón no es de estilo. Meta reintenta si no recibe un 200 rápido, y si
 * el procesamiento vive en esta ruta, una consulta lenta o un pico de tráfico
 * convierten cada mensaje en varios reintentos que multiplican la carga justo
 * cuando el sistema ya va mal. Persistir y encolar es siempre rápido y
 * siempre igual de rápido.
 */
import type { PoolClient } from 'pg';
import { escribirEnOutbox } from '@crmapp/queue';
import { type AdaptadorDeIngesta, type PeticionDeWebhook } from '@crmapp/channels';
import type { BaseDeDatos } from '../db.js';

export class FirmaInvalida extends Error {
  constructor() {
    super('Firma del webhook inválida.');
    this.name = 'FirmaInvalida';
  }
}

export interface CuentaResuelta {
  channelAccountId: string;
  tenantId: string;
  secreto: string;
}

/**
 * Resuelve a qué cuenta pertenece un webhook y devuelve su secreto.
 *
 * Se inyecta para que el servicio se pueda probar sin descifrar secretos
 * reales, y porque en producción la resolución implica leer `channel_secrets`
 * y descifrar con `@crmapp/crypto`.
 */
export type ResolverCuenta = (
  canal: string,
  externalAccountId: string | null,
) => Promise<CuentaResuelta | null>;

export interface OpcionesDeIngesta {
  db: BaseDeDatos;
  adaptadores: Map<string, AdaptadorDeIngesta>;
  resolverCuenta: ResolverCuenta;
  /** Token del reto de alta del webhook. */
  verifyToken: string;
  onAviso?: (mensaje: string, datos: Record<string, unknown>) => void;
}

export interface ResultadoDeIngesta {
  inboundEventId: string;
  eventos: number;
  /** Milisegundos que tardó. Se mide para vigilar el presupuesto de 1 s. */
  duracionMs: number;
}

export class IngestaService {
  readonly #db: BaseDeDatos;
  readonly #adaptadores: Map<string, AdaptadorDeIngesta>;
  readonly #resolverCuenta: ResolverCuenta;
  readonly #verifyToken: string;
  readonly #aviso: (m: string, d: Record<string, unknown>) => void;

  constructor(opciones: OpcionesDeIngesta) {
    this.#db = opciones.db;
    this.#adaptadores = opciones.adaptadores;
    this.#resolverCuenta = opciones.resolverCuenta;
    this.#verifyToken = opciones.verifyToken;
    this.#aviso = opciones.onAviso ?? (() => {});
  }

  adaptador(canal: string): AdaptadorDeIngesta | undefined {
    return this.#adaptadores.get(canal);
  }

  /** Reto de alta del webhook. */
  desafio(canal: string, parametros: Record<string, string | undefined>): string | null {
    return this.adaptador(canal)?.responderAlDesafio(parametros, this.#verifyToken) ?? null;
  }

  /**
   * Recibe un webhook. Lanza `FirmaInvalida` si no está firmado correctamente.
   *
   * Una firma inválida **también se registra**, con `signature_ok = false`. Sin
   * ese rastro, un secreto rotado a medias se manifiesta como "los mensajes no
   * llegan" y no hay forma de distinguirlo de un problema de red.
   */
  async recibir(canal: string, peticion: PeticionDeWebhook): Promise<ResultadoDeIngesta> {
    const t0 = Date.now();

    const adaptador = this.adaptador(canal);
    if (!adaptador) throw new FirmaInvalida();

    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(peticion.cuerpoCrudo.toString('utf8'));
    } catch {
      cuerpo = null;
    }

    const externalAccountId = extraerCuenta(cuerpo);
    const cuenta = await this.#resolverCuenta(canal, externalAccountId);

    // Sin cuenta no hay secreto con el que verificar. Se registra igualmente:
    // un webhook de una cuenta que no conocemos puede ser una desconexión a
    // medias, y sin rastro no se diagnostica.
    const firmaOk = cuenta ? adaptador.verificarFirma(peticion, cuenta.secreto) : false;

    const eventos = firmaOk ? adaptador.parsearEventos(cuerpo) : [];

    const inboundEventId = await this.#persistir({
      canal,
      cuenta,
      firmaOk,
      crudo: cuerpo ?? { _sinParsear: peticion.cuerpoCrudo.toString('base64') },
      eventos: eventos.length,
    });

    if (!firmaOk) {
      this.#aviso('webhook con firma inválida', {
        canal,
        externalAccountId,
        cuentaConocida: cuenta !== null,
        inboundEventId,
      });
      throw new FirmaInvalida();
    }

    return { inboundEventId, eventos: eventos.length, duracionMs: Date.now() - t0 };
  }

  async #persistir(datos: {
    canal: string;
    cuenta: CuentaResuelta | null;
    firmaOk: boolean;
    crudo: unknown;
    eventos: number;
  }): Promise<string> {
    const insertar = async (c: PoolClient): Promise<string> => {
      // Identificador pedido antes, e INSERT sin RETURNING. No es manía: con
      // una cuenta desconocida la fila lleva `tenant_id` nulo, y la politica de
      // lectura —`tenant_id = app.current_tenant_id()`— no la ve. `RETURNING`
      // aplica esa politica a la fila devuelta y la insercion falla, con el
      // mensaje de WITH CHECK, que apunta al sitio equivocado. Documentado en
      // docs/vault/aprendizajes/.
      const id = await this.#db.nuevoId(c);

      await c.query(
        `INSERT INTO inbound_events
           (id, tenant_id, channel, channel_account_id, signature_ok, raw, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          datos.cuenta?.tenantId ?? null,
          datos.canal,
          datos.cuenta?.channelAccountId ?? null,
          datos.firmaOk,
          JSON.stringify(datos.crudo),
          datos.firmaOk ? 'pending' : 'failed',
        ],
      );

      // El evento para la cola se escribe en la MISMA transacción que la fila
      // cruda (requisito 8.2). Encolar aquí directamente dejaría el hueco que
      // el patrón outbox existe para cerrar: si el proceso muere entre el
      // commit y el publish, el webhook queda guardado y nunca se procesa.
      if (datos.firmaOk && datos.cuenta && datos.eventos > 0) {
        await escribirEnOutbox(c, {
          tenantId: datos.cuenta.tenantId,
          aggregateType: 'inbound_event',
          aggregateId: id,
          eventType: 'webhook.recibido',
          payload: { canal: datos.canal, eventos: datos.eventos },
        });
      }

      return id;
    };

    // Con cuenta resuelta se escribe bajo el inquilino, para que RLS valga
    // también aquí. Sin cuenta no hay inquilino: la fila queda con tenant_id
    // nulo y no la ve nadie a través de RLS, que es lo correcto — es un
    // registro para diagnóstico, no dato de cliente.
    return datos.cuenta
      ? this.#db.paraInquilino(datos.cuenta.tenantId, insertar)
      : this.#db.sinInquilino(insertar);
  }
}

/**
 * Saca el identificador de cuenta del payload sin conocer el formato exacto.
 *
 * Busca en las formas conocidas de Meta y en la del sandbox. Devuelve `null`
 * si no lo encuentra, y eso NO es un error: se registra igual y se diagnostica
 * después. Fallar aquí convertiría un formato nuevo de Meta en una caída.
 */
function extraerCuenta(cuerpo: unknown): string | null {
  if (typeof cuerpo !== 'object' || cuerpo === null) return null;
  const raiz = cuerpo as Record<string, unknown>;

  if (typeof raiz['cuenta'] === 'string') return raiz['cuenta'];

  // Forma de Meta: entry[].changes[].value.metadata.phone_number_id
  const entry = raiz['entry'];
  if (Array.isArray(entry) && entry.length > 0) {
    const primera = entry[0] as Record<string, unknown> | undefined;
    const changes = primera?.['changes'];
    if (Array.isArray(changes) && changes.length > 0) {
      const valor = (changes[0] as Record<string, unknown>)?.['value'] as
        Record<string, unknown> | undefined;
      const metadata = valor?.['metadata'] as Record<string, unknown> | undefined;
      if (typeof metadata?.['phone_number_id'] === 'string') {
        return metadata['phone_number_id'];
      }
    }
    if (typeof primera?.['id'] === 'string') return primera['id'];
  }

  return null;
}
