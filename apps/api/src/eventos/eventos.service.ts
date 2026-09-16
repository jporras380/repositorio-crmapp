/**
 * Eventos en vivo: la bandeja se entera de un mensaje nuevo en el momento, sin
 * preguntar cada diez segundos.
 *
 * Cómo funciona, de abajo arriba:
 *
 * 1. `escribirEnOutbox` hace `pg_notify('crmapp_eventos', …)` en la misma
 *    transacción del hecho. PostgreSQL lo entrega **al confirmar**.
 * 2. Esta clase mantiene **UNA** conexión con `LISTEN` para todo el proceso y
 *    reparte lo que llega a las pantallas abiertas, filtrando por inquilino.
 *    Una conexión por pantalla agotaría el pool en cuanto haya veinte
 *    agentes; el reparto en memoria no cuesta nada.
 * 3. El controlador lo sirve como SSE (`text/event-stream`).
 *
 * **Es un aviso, no una entrega garantizada.** Quien no esté conectado en ese
 * instante se lo pierde, y no pasa nada: la pantalla recarga igual al abrir y
 * conserva su recarga periódica de respaldo. Lo que no se puede perder viaja
 * por el outbox, que sí garantiza entrega.
 */
import { Client } from 'pg';
import type { Logger } from '@crmapp/observability';

export interface EventoEnVivo {
  /** Tipo del outbox: `mensaje.recibido`, `mensaje.enviado`, `media.lista`… */
  tipo: string;
  /** Agregado al que se refiere (id del mensaje, del medio…). */
  id: string;
  /** Conversación afectada, cuando el evento la lleva. */
  conversacionId: string | null;
}

type Escucha = (evento: EventoEnVivo) => void;

const CANAL = 'crmapp_eventos';
/** Al perder la conexión con PostgreSQL, se reintenta con esta pausa. */
const REINTENTO_MS = 2000;

export class EventosService {
  readonly #url: string;
  readonly #log: Pick<Logger, 'warn' | 'info'> | undefined;
  readonly #porInquilino = new Map<string, Set<Escucha>>();
  #cliente: Client | null = null;
  #cerrado = false;

  constructor(o: { databaseUrl: string; log?: Pick<Logger, 'warn' | 'info'> }) {
    this.#url = o.databaseUrl;
    if (o.log) this.#log = o.log;
  }

  /**
   * Suscribe una pantalla. Devuelve la función para darse de baja, que hay que
   * llamar SIEMPRE al cerrarse la conexión: sin eso, cada recarga del
   * navegador dejaría una escucha muerta acumulándose.
   */
  suscribir(tenantId: string, escucha: Escucha): () => void {
    const actuales = this.#porInquilino.get(tenantId) ?? new Set<Escucha>();
    actuales.add(escucha);
    this.#porInquilino.set(tenantId, actuales);
    void this.#conectar();
    return () => {
      const set = this.#porInquilino.get(tenantId);
      if (!set) return;
      set.delete(escucha);
      if (set.size === 0) this.#porInquilino.delete(tenantId);
    };
  }

  /** Cuántas pantallas hay escuchando. Para tests y diagnóstico. */
  get suscritos(): number {
    let n = 0;
    for (const set of this.#porInquilino.values()) n += set.size;
    return n;
  }

  async cerrar(): Promise<void> {
    this.#cerrado = true;
    const c = this.#cliente;
    this.#cliente = null;
    await c?.end().catch(() => undefined);
  }

  async #conectar(): Promise<void> {
    if (this.#cliente || this.#cerrado) return;
    const cliente = new Client({ connectionString: this.#url });
    this.#cliente = cliente;
    cliente.on('notification', (n) => this.#repartir(n.payload));
    cliente.on('error', (e) => this.#reconectar(e));
    try {
      await cliente.connect();
      await cliente.query(`LISTEN ${CANAL}`);
    } catch (e) {
      this.#reconectar(e);
    }
  }

  #reconectar(error: unknown): void {
    if (this.#cerrado) return;
    this.#log?.warn('escucha de eventos caída; se reintenta', {
      error: (error as Error)?.message,
    });
    void this.#cliente?.end().catch(() => undefined);
    this.#cliente = null;
    // Sin reintento, un corte de red dejaría las pantallas mudas hasta el
    // siguiente despliegue. La recarga periódica de la web es el segundo
    // paracaídas, no el primero.
    const t = setTimeout(() => void this.#conectar(), REINTENTO_MS);
    t.unref?.();
  }

  #repartir(payload: string | undefined): void {
    if (!payload) return;
    let datos: { t?: string; e?: string; a?: string; c?: string | null };
    try {
      datos = JSON.parse(payload) as typeof datos;
    } catch {
      return; // un aviso ilegible se ignora: no puede tumbar el proceso
    }
    if (!datos.t || !datos.e) return;
    const escuchas = this.#porInquilino.get(datos.t);
    if (!escuchas) return;
    const evento: EventoEnVivo = {
      tipo: datos.e,
      id: datos.a ?? '',
      conversacionId: datos.c ?? null,
    };
    for (const escucha of escuchas) {
      try {
        escucha(evento);
      } catch {
        // Una pantalla que falla al recibir no puede afectar a las demás.
      }
    }
  }
}
