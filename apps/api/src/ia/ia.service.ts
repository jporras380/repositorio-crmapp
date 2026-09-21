/**
 * IA asistida (P-11): la IA redacta, una persona revisa y envía.
 *
 * Tres reglas que no se negocian, y por eso viven aquí y no en la web:
 *
 * 1. **Nunca envía.** `sugerir` devuelve texto; el envío es el de siempre,
 *    por la puerta de `@crmapp/envio`, pulsado por un agente. El mensaje
 *    queda con `sent_by = 'human'` y `ai_generated = true`.
 * 2. **Con la clave del hotel.** Sin clave guardada y sin activar por un
 *    administrador, no sale nada hacia el proveedor.
 * 3. **Solo lo que el agente ya puede ver.** La conversación se lee con
 *    `BandejaService.mensajes`, que aplica la visibilidad entre agentes
 *    (ADR-008): la IA no amplía lo que alguien puede leer.
 *
 * El precio no se inventa: se le da el catálogo del hotel con sus tarifas
 * base y la instrucción de no prometer precio ni disponibilidad que no esté
 * ahí. Lo que diga igualmente lo revisa una persona antes de enviarlo.
 */
import type { Cifrador } from '@crmapp/crypto';
import {
  borrarSecretoDeInquilino,
  guardarSecretoDeInquilino,
  leerSecretoDeInquilino,
  registrarUso,
} from '@crmapp/db';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { BandejaService } from '../bandeja/bandeja.service.js';
import { MODELOS_DE_IA, type ClienteDeIa } from './cliente-de-ia.js';
import {
  catalogoDeProveedores,
  esProveedor,
  PROVEEDORES,
  PROVEEDORES_DE_IA,
  type Proveedor,
} from './proveedores.js';

export interface AjustesDeIa {
  activa: boolean;
  /** Quién redacta: Claude, Gemini, GPT o Grok. Cada uno con la clave del hotel. */
  proveedor: Proveedor;
  modelo: string;
  instrucciones: string;
  /** Si hay clave guardada PARA EL PROVEEDOR ACTUAL. La clave nunca sale. */
  tieneClave: boolean;
  /** Cuáles tienen clave ya guardada: cambiar de proveedor no obliga a repegarla. */
  proveedoresConClave: readonly Proveedor[];
  modelosDisponibles: readonly string[];
  /** Nombres, modelos sugeridos, dónde sacar la clave y qué advertir de cada uno. */
  proveedores: ReturnType<typeof catalogoDeProveedores>;
}

export interface CambiosDeAjustesDeIa {
  activa?: boolean | undefined;
  proveedor?: Proveedor | undefined;
  modelo?: string | undefined;
  instrucciones?: string | undefined;
  /** Clave nueva; se verifica contra el proveedor antes de guardarla. */
  clave?: string | undefined;
}

/** Cuántos mensajes recientes ve la IA. Más contexto cuesta más de la cuenta del hotel. */
const MENSAJES_DE_CONTEXTO = 30;

const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

export class IaService {
  readonly #db: BaseDeDatos;
  readonly #cifrador: Cifrador;
  /**
   * El cliente que toca según el proveedor, no uno fijo.
   *
   * Es una función y no un cliente porque cada inquilino elige el suyo: dos
   * hoteles de la misma instancia pueden estar en Claude y en Gemini.
   */
  readonly #clientePara: (proveedor: Proveedor) => ClienteDeIa;
  readonly #bandeja: BandejaService;

  constructor(o: {
    db: BaseDeDatos;
    cifrador: Cifrador;
    clientePara: (proveedor: Proveedor) => ClienteDeIa;
    bandeja: BandejaService;
  }) {
    this.#db = o.db;
    this.#cifrador = o.cifrador;
    this.#clientePara = o.clientePara;
    this.#bandeja = o.bandeja;
  }

  /** Cualquier miembro puede leerlos: el compositor necesita saber si enseñar el botón. */
  async ajustes(): Promise<AjustesDeIa> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        enabled: boolean;
        model: string;
        instructions: string;
        provider: string;
      }>(`SELECT enabled, model, instructions, provider FROM ai_settings`);
      const f = rows[0];
      const proveedor: Proveedor =
        f && esProveedor(f.provider) ? (f.provider as Proveedor) : 'anthropic';

      // Las claves guardadas de TODOS los proveedores, no solo la del actual:
      // la pantalla enseña cuáles están listos, y así cambiar de proveedor no
      // obliga a volver a pegar una clave que ya estaba.
      const claves = await c.query<{ kind: string }>(
        `SELECT kind FROM tenant_secrets WHERE kind = ANY($1::text[])`,
        [PROVEEDORES.map((p) => PROVEEDORES_DE_IA[p].claveKind)],
      );
      const conClave = PROVEEDORES.filter((p) =>
        claves.rows.some((r) => r.kind === PROVEEDORES_DE_IA[p].claveKind),
      );

      return {
        activa: f?.enabled ?? false,
        proveedor,
        modelo: f?.model ?? PROVEEDORES_DE_IA[proveedor].modelos[0]!,
        instrucciones: f?.instructions ?? '',
        tieneClave: conClave.includes(proveedor),
        proveedoresConClave: conClave,
        modelosDisponibles: PROVEEDORES_DE_IA[proveedor].modelos,
        proveedores: catalogoDeProveedores(),
      };
    });
  }

  async guardarAjustes(cambios: CambiosDeAjustesDeIa): Promise<AjustesDeIa> {
    const ctx = this.#exigirAdmin();
    const actuales = await this.ajustes();
    const proveedor = cambios.proveedor ?? actuales.proveedor;
    const cambiaProveedor = proveedor !== actuales.proveedor;

    // Al cambiar de proveedor, el modelo de antes no sirve: «claude-opus-5» no
    // existe en Google. Si no se pide uno, se toma el primero del nuevo, que es
    // mejor que guardar una pareja imposible y descubrirlo al primer borrador.
    const modelo =
      cambios.modelo ??
      (cambiaProveedor ? PROVEEDORES_DE_IA[proveedor].modelos[0]! : actuales.modelo);

    // La clave se comprueba ANTES de guardar, fuera de la transacción (red).
    // Se comprueba también si cambia el modelo o el proveedor y ya había clave
    // guardada: una pareja que no funciona deja el botón roto sin avisar.
    let claveAComprobar = cambios.clave;
    if (
      !claveAComprobar &&
      (cambiaProveedor || (cambios.modelo && cambios.modelo !== actuales.modelo))
    ) {
      claveAComprobar = (await this.#leerClave(proveedor)) ?? undefined;
    }
    if (claveAComprobar) {
      await this.#clientePara(proveedor).verificar({ apiKey: claveAComprobar, modelo });
    }

    const activa = cambios.activa ?? actuales.activa;
    const tendraClave = Boolean(cambios.clave) || actuales.proveedoresConClave.includes(proveedor);
    if (activa && !tendraClave) {
      throw new ErrorDeNegocio(
        'ia_sin_clave',
        `Guarda primero la clave de API de ${PROVEEDORES_DE_IA[proveedor].nombre} del hotel.`,
        422,
      );
    }

    await this.#db.enTransaccion(async (c) => {
      await c.query(
        `INSERT INTO ai_settings (tenant_id, enabled, model, instructions, provider, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE
            SET enabled = EXCLUDED.enabled, model = EXCLUDED.model,
                instructions = EXCLUDED.instructions, provider = EXCLUDED.provider,
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
          ctx.tenantId,
          activa,
          modelo,
          cambios.instrucciones ?? actuales.instrucciones,
          proveedor,
          ctx.userId,
        ],
      );
      if (cambios.clave) {
        // Cada proveedor guarda la suya: cambiar de uno a otro y volver no
        // obliga a ir a buscar la clave otra vez.
        await guardarSecretoDeInquilino(c, this.#cifrador, {
          tenantId: ctx.tenantId,
          kind: PROVEEDORES_DE_IA[proveedor].claveKind,
          valor: cambios.clave,
        });
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'ia.ajustes', 'tenant', $1, $3)`,
        [
          ctx.tenantId,
          ctx.userId,
          JSON.stringify({ activa, proveedor, modelo, claveNueva: Boolean(cambios.clave) }),
        ],
      );
    });
    return this.ajustes();
  }

  /**
   * Borra la clave del proveedor que se diga —o la del actual— y apaga la IA.
   *
   * Se apaga aunque se borre la de otro proveedor: es un gesto que se hace
   * cuando una clave se filtró o se rota, y dejar la IA encendida esperando a
   * que el agente descubra el fallo al primer borrador sería peor.
   */
  async borrarClave(cual?: Proveedor): Promise<AjustesDeIa> {
    const ctx = this.#exigirAdmin();
    const proveedor = cual ?? (await this.ajustes()).proveedor;
    await this.#db.enTransaccion(async (c) => {
      await borrarSecretoDeInquilino(c, PROVEEDORES_DE_IA[proveedor].claveKind);
      await c.query(`UPDATE ai_settings SET enabled = false, updated_at = now()`);
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'ia.clave_borrada', 'tenant', $1)`,
        [ctx.tenantId, ctx.userId],
      );
    });
    return this.ajustes();
  }

  /** Borrador de respuesta para una conversación. No envía nada. */
  async sugerir(conversationId: string): Promise<{ texto: string; modelo: string }> {
    const ctx = this.#exigirContexto();
    const ajustes = await this.ajustes();
    if (!ajustes.activa) {
      throw new ErrorDeNegocio(
        'ia_desactivada',
        'La IA está desactivada. Un administrador puede activarla en Ajustes → IA.',
        409,
      );
    }
    const apiKey = await this.#leerClave(ajustes.proveedor);
    if (!apiKey) {
      throw new ErrorDeNegocio(
        'ia_sin_clave',
        `Falta la clave de API de ${PROVEEDORES_DE_IA[ajustes.proveedor].nombre} del hotel.`,
        409,
      );
    }

    // Visibilidad (ADR-008): lanza 404 si este agente no puede ver la conversación.
    const { items } = await this.#bandeja.mensajes(conversationId, {
      limite: MENSAJES_DE_CONTEXTO,
    });
    const contexto = await this.#db.enTransaccion((c) => leerContexto(c, conversationId));
    if (!items.some((m) => m.direccion === 'inbound' && m.texto)) {
      throw new ErrorDeNegocio(
        'ia_sin_mensajes',
        'Todavía no hay mensajes del cliente a los que responder.',
        422,
      );
    }

    const transcripcion = [...items]
      .reverse()
      .filter((m) => m.texto)
      .map((m) => `${m.direccion === 'inbound' ? 'Cliente' : 'Hotel'}: ${m.texto}`)
      .join('\n');

    const texto = await this.#clientePara(ajustes.proveedor).sugerir({
      apiKey,
      modelo: ajustes.modelo,
      sistema: sistemaDelHotel(contexto, ajustes.instrucciones),
      mensaje:
        `Conversación por ${CANAL[contexto.canal] ?? contexto.canal} con ` +
        `${contexto.cliente ?? 'un cliente'}, del mensaje más antiguo al más reciente:\n\n` +
        `<conversacion>\n${transcripcion}\n</conversacion>\n\n` +
        'Redacta la siguiente respuesta del hotel. Devuelve solo el texto del mensaje.',
    });

    await this.#db.enTransaccion((c) =>
      registrarUso(c, {
        tenantId: ctx.tenantId,
        metric: 'ai.suggestions',
        // Cada petición es un hecho distinto; no hay reenvío que deduplicar.
        dedupKey: `ai:suggestion:${conversationId}:${Date.now()}:${Math.random()}`,
        meta: { modelo: ajustes.modelo },
      }),
    );
    return { texto, modelo: ajustes.modelo };
  }

  // -------------------------------------------------------------------------

  /** La clave del proveedor que se le pida. Cada uno guarda la suya. */
  async #leerClave(proveedor: Proveedor): Promise<string | null> {
    return this.#db.enTransaccion((c) =>
      leerSecretoDeInquilino(c, this.#cifrador, PROVEEDORES_DE_IA[proveedor].claveKind),
    );
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  #exigirAdmin() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden configurar la IA.',
        403,
      );
    }
    return ctx;
  }
}

interface ContextoDelHotel {
  negocio: string;
  canal: string;
  cliente: string | null;
  tipos: { nombre: string; capacidad: number; tarifaBase: number | null; moneda: string }[];
  servicios: { nombre: string; precio: number; moneda: string; unidad: string }[];
}

async function leerContexto(
  c: import('pg').PoolClient,
  conversationId: string,
): Promise<ContextoDelHotel> {
  const conv = await c.query<{ channel: string; display_name: string | null; negocio: string }>(
    `SELECT ca.channel, co.display_name, t.name AS negocio
       FROM conversations cv
       JOIN channel_accounts ca ON ca.id = cv.channel_account_id
       JOIN tenants t ON t.id = cv.tenant_id
       LEFT JOIN contacts co ON co.id = cv.contact_id
      WHERE cv.id = $1`,
    [conversationId],
  );
  const tipos = await c.query<{
    name: string;
    capacity: number;
    base_rate_cents: string | null;
    currency: string;
  }>(
    `SELECT name, capacity, base_rate_cents, currency FROM room_types
      WHERE active ORDER BY name`,
  );
  const servicios = await c.query<{
    name: string;
    price_cents: string;
    currency: string;
    unit: string;
  }>(`SELECT name, price_cents, currency, unit FROM hotel_services WHERE active ORDER BY name`);
  const f = conv.rows[0];
  return {
    negocio: f?.negocio ?? 'el hotel',
    canal: f?.channel ?? 'whatsapp',
    cliente: f?.display_name ?? null,
    tipos: tipos.rows.map((t) => ({
      nombre: t.name,
      capacidad: t.capacity,
      tarifaBase: t.base_rate_cents === null ? null : Number(t.base_rate_cents) / 100,
      moneda: t.currency,
    })),
    servicios: servicios.rows.map((s) => ({
      nombre: s.name,
      precio: Number(s.price_cents) / 100,
      moneda: s.currency,
      unidad: s.unit.replaceAll('_', ' '),
    })),
  };
}

/** Instrucciones estables: primero lo fijo, después lo que escribe el hotel. */
export function sistemaDelHotel(ctx: ContextoDelHotel, instrucciones: string): string {
  const catalogo =
    ctx.tipos.length === 0
      ? 'El hotel todavía no ha cargado su catálogo de habitaciones.'
      : ctx.tipos
          .map(
            (t) =>
              `- ${t.nombre}: hasta ${t.capacidad} personas` +
              (t.tarifaBase === null ? '' : `, tarifa base ${t.moneda} ${t.tarifaBase} por noche`),
          )
          .join('\n');
  const servicios = ctx.servicios
    .map((s) => `- ${s.nombre}: ${s.moneda} ${s.precio} ${s.unidad}`)
    .join('\n');

  return [
    `Redactas borradores de respuesta para el equipo de atención de ${ctx.negocio}. ` +
      'Una persona del equipo leerá tu borrador, lo corregirá si hace falta y lo enviará ella: ' +
      'no hablas directamente con el cliente.',
    'Escribe como escribe una persona del hotel por chat: breve, cordial, en el idioma del cliente ' +
      '(español por defecto) y sin formato de documento. No firmes con un nombre.',
    'No inventes precios, descuentos, disponibilidad ni políticas. Usa solo lo que aparece abajo o en la ' +
      'conversación. Si el cliente pregunta algo que no está, di que lo confirmas enseguida en vez de suponerlo. ' +
      'La tarifa base es orientativa: el precio final depende de las fechas y lo confirma el equipo.',
    `<catalogo>\n${catalogo}${servicios ? `\n\nServicios adicionales:\n${servicios}` : ''}\n</catalogo>`,
    instrucciones.trim()
      ? `<instrucciones_del_hotel>\n${instrucciones.trim()}\n</instrucciones_del_hotel>`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
