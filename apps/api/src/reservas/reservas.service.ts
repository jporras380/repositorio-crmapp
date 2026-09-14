/**
 * Reservas (migración 0022).
 *
 * Tres reglas que no se negocian y que explican casi todo este archivo:
 *
 * **El precio sale del cotizador, siempre.** La reserva no acepta un total
 * que le mande la pantalla: pide la cotización a `HotelService`, que usa la
 * misma función de `core` que el agente vio al cotizar, y copia sus líneas.
 * Si la web pudiera mandar el total, un número mal escrito sería una reserva
 * mal cobrada. Lo único que la persona pone a mano es un DESCUENTO, que queda
 * como línea propia con quién lo dio.
 *
 * **Una cotización incompleta no se reserva.** Si una noche no tiene precio
 * se devuelve 422 con los problemas. Los avisos que sí tienen cifra —mínimo de
 * noches, más personas de las que caben— se pueden aceptar a sabiendas
 * (`aceptarAvisos`), porque a veces el hotel hace excepciones; lo que no se
 * hace es pasarlos por alto sin enterarse.
 *
 * **Confirmar una reserva gana el lead.** En la misma transacción: una
 * reserva confirmada con su oportunidad todavía en «Cotización enviada» es un
 * embudo que miente sobre lo que se ha vendido.
 */
import type { PoolClient } from 'pg';
import {
  accionesPosibles,
  saldoDeReserva,
  seSolapan,
  transicionDeReserva,
  type AccionDeReserva,
  type EstadoDeReserva,
  type Saldo,
} from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { HotelService } from '../hotel/hotel.service.js';

export type MetodoDePago = 'efectivo' | 'transferencia' | 'yape' | 'plin' | 'tarjeta' | 'otro';

export interface ResumenDeReserva {
  id: string;
  estado: EstadoDeReserva;
  contacto: { id: string; nombre: string | null };
  tipo: string;
  habitacion: string | null;
  entrada: string;
  salida: string;
  noches: number;
  personas: number;
  total: number;
  pagado: number;
  moneda: string;
  conversacionId: string | null;
  creadaEn: Date;
}

export interface DetalleDeReserva extends ResumenDeReserva {
  tipoId: string;
  habitacionId: string | null;
  leadId: string | null;
  notas: string | null;
  lineas: {
    tipo: 'noche' | 'servicio' | 'descuento';
    descripcion: string;
    noche: string | null;
    cantidad: number;
    unitario: number;
    total: number;
  }[];
  pagos: {
    id: string;
    importe: number;
    metodo: MetodoDePago;
    referencia: string | null;
    pagadoEn: Date;
  }[];
  historial: {
    tipo: string;
    desde: string | null;
    hasta: string | null;
    en: Date;
    actor: string | null;
  }[];
  saldo: Saldo;
  /** Lo que se puede hacer ahora; la pantalla lo convierte en botones. */
  acciones: AccionDeReserva[];
  /** Otras reservas vivas en la misma habitación que comparten noche. */
  solapes: { id: string; contacto: string | null; entrada: string; salida: string }[];
}

export interface PeticionDeReserva {
  conversacionId?: string | undefined;
  contactoId?: string | undefined;
  tipoId: string;
  entrada: string;
  salida: string;
  personas: number;
  servicios?: string[] | undefined;
  habitacionId?: string | undefined;
  descuento?: { importe: number; motivo: string } | undefined;
  notas?: string | undefined;
  aceptarAvisos?: boolean | undefined;
}

export interface FiltrosDeReservas {
  estado?: string | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
  contactoId?: string | undefined;
  conversacionId?: string | undefined;
}

/** Avisos que tienen cifra y que un humano puede aceptar a sabiendas. */
const AVISOS_ACEPTABLES = new Set(['minimo_de_noches', 'excede_capacidad', 'entrada_pasada']);

export class ReservasService {
  readonly #db: BaseDeDatos;
  readonly #hotel: HotelService;

  constructor(opciones: { db: BaseDeDatos; hotel: HotelService }) {
    this.#db = opciones.db;
    this.#hotel = opciones.hotel;
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async listar(f: FiltrosDeReservas = {}): Promise<ResumenDeReserva[]> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const params: unknown[] = [];
      const p = (v: unknown) => `$${params.push(v)}`;
      const donde: string[] = [];
      if (f.estado) donde.push(`r.status = ${p(f.estado)}`);
      // «Qué entra esta semana»: reservas cuya estancia toca el rango.
      if (f.desde) donde.push(`r.check_out > ${p(f.desde)}::date`);
      if (f.hasta) donde.push(`r.check_in < ${p(f.hasta)}::date`);
      if (f.contactoId) donde.push(`r.contact_id = ${p(f.contactoId)}`);
      if (f.conversacionId) donde.push(`r.conversation_id = ${p(f.conversacionId)}`);

      const { rows } = await c.query<FilaDeReserva>(
        `${SELECT_RESUMEN}
          ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''}
          ORDER BY r.check_in, r.created_at
          LIMIT 300`,
        params,
      );
      return rows.map(aResumen);
    });
  }

  async detalle(id: string): Promise<DetalleDeReserva> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => this.#detalle(c, id));
  }

  // -------------------------------------------------------------------------
  // Crear
  // -------------------------------------------------------------------------

  async crear(p: PeticionDeReserva): Promise<DetalleDeReserva> {
    const ctx = this.#exigirContexto();

    // Primero la cotización, con el catálogo de HOY y la misma función que
    // vio el agente. Si no cuadra, no hay reserva.
    const cotizacion = await this.#hotel.cotizar({
      tipoId: p.tipoId,
      entrada: p.entrada,
      salida: p.salida,
      personas: p.personas,
      servicios: p.servicios,
    });
    const bloqueantes = cotizacion.problemas.filter(
      (x) => !AVISOS_ACEPTABLES.has(x.codigo) || !p.aceptarAvisos,
    );
    if (bloqueantes.length > 0) {
      throw new ErrorDeNegocio(
        cotizacion.completa ? 'cotizacion_con_avisos' : 'cotizacion_incompleta',
        cotizacion.completa
          ? 'La cotización tiene avisos. Revísalos y acéptalos para reservar igualmente.'
          : 'Falta el precio de alguna noche: no se puede reservar con un total incompleto.',
        422,
        { problemas: cotizacion.problemas },
      );
    }

    const descuento = p.descuento?.importe ?? 0;
    if (descuento > cotizacion.total) {
      throw new ErrorDeNegocio(
        'descuento_excesivo',
        'El descuento no puede ser mayor que el total.',
        422,
      );
    }

    return this.#db.enTransaccion(async (c) => {
      const { contactId, conversationId } = await this.#quien(c, p);

      if (p.habitacionId) await this.#exigirHabitacionDelTipo(c, p.habitacionId, p.tipoId);

      // El lead abierto del contacto, si lo hay: la reserva se cuelga de su
      // oportunidad para que confirmar la pueda ganar.
      const { rows: leads } = await c.query<{ id: string; amount_cents: string }>(
        `SELECT id, amount_cents FROM leads
          WHERE contact_id = $1 AND status = 'abierto'
          ORDER BY created_at DESC LIMIT 1`,
        [contactId],
      );
      const lead = leads[0] ?? null;

      const id = await this.#db.nuevoId(c);
      const total = cotizacion.total - descuento;
      await c.query(
        `INSERT INTO reservations
           (id, tenant_id, contact_id, conversation_id, lead_id, room_type_id, room_id,
            room_type_name, check_in, check_out, guests, total_cents, currency, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          ctx.tenantId,
          contactId,
          conversationId,
          lead?.id ?? null,
          p.tipoId,
          p.habitacionId ?? null,
          cotizacion.tipo,
          p.entrada,
          p.salida,
          p.personas,
          total,
          cotizacion.moneda,
          p.notas?.trim() || null,
          ctx.userId,
        ],
      );

      // Las líneas tal como se cotizaron. Es lo que hace que la reserva siga
      // diciendo lo mismo el día que alguien cambie la tarifa.
      let posicion = 0;
      const linea = (
        kind: 'noche' | 'servicio' | 'descuento',
        descripcion: string,
        noche: string | null,
        cantidad: number,
        unitario: number,
        importe: number,
      ) =>
        c.query(
          `INSERT INTO reservation_lines
             (tenant_id, reservation_id, kind, description, night, quantity, unit_cents, total_cents, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ctx.tenantId, id, kind, descripcion, noche, cantidad, unitario, importe, posicion++],
        );
      for (const n of cotizacion.detalle) {
        await linea('noche', n.tarifa ?? 'Precio base', n.fecha, 1, n.precio, n.precio);
      }
      for (const s of cotizacion.servicios) {
        await linea('servicio', s.nombre, null, s.cantidad, s.precioUnitario, s.total);
      }
      if (descuento > 0) {
        await linea(
          'descuento',
          p.descuento!.motivo.trim() || 'Descuento',
          null,
          1,
          -descuento,
          -descuento,
        );
      }

      await this.#evento(c, id, 'creada', null, 'pendiente', {
        avisosAceptados: cotizacion.problemas.map((x) => x.codigo),
      });

      // El importe del lead se rellena si estaba vacío: el pronóstico del
      // embudo pasa a decir lo que de verdad se cotizó.
      if (lead && Number(lead.amount_cents) === 0) {
        await c.query(`UPDATE leads SET amount_cents = $2, updated_at = now() WHERE id = $1`, [
          lead.id,
          total,
        ]);
      }

      return this.#detalle(c, id);
    });
  }

  // -------------------------------------------------------------------------
  // Mover, asignar, pagar
  // -------------------------------------------------------------------------

  async mover(id: string, accion: AccionDeReserva): Promise<DetalleDeReserva> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        status: EstadoDeReserva;
        lead_id: string | null;
        contact_id: string;
        total_cents: string;
      }>(
        `SELECT status, lead_id, contact_id, total_cents FROM reservations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (!r) throw new ErrorDeNegocio('reserva_no_encontrada', 'Esa reserva no existe.', 404);

      const t = transicionDeReserva(r.status, accion);
      if (!t.permitida) {
        throw new ErrorDeNegocio('transicion_no_permitida', t.motivo ?? 'No se puede.', 409, {
          estado: r.status,
          acciones: accionesPosibles(r.status),
        });
      }

      await c.query(
        `UPDATE reservations
            SET status = $2,
                cancelled_at = CASE WHEN $2 = 'cancelada' THEN now() ELSE cancelled_at END,
                updated_at = now()
          WHERE id = $1`,
        [id, t.hasta],
      );
      await this.#evento(c, id, accion, r.status, t.hasta!, null);

      if (accion === 'confirmar' && r.lead_id) {
        await this.#ganarLead(c, ctx.tenantId, ctx.userId, r.lead_id, Number(r.total_cents));
      }
      return this.#detalle(c, id);
    });
  }

  async asignarHabitacion(id: string, habitacionId: string | null): Promise<DetalleDeReserva> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        room_type_id: string;
        status: EstadoDeReserva;
        room_id: string | null;
      }>(`SELECT room_type_id, status, room_id FROM reservations WHERE id = $1 FOR UPDATE`, [id]);
      const r = rows[0];
      if (!r) throw new ErrorDeNegocio('reserva_no_encontrada', 'Esa reserva no existe.', 404);
      if (habitacionId) await this.#exigirHabitacionDelTipo(c, habitacionId, r.room_type_id);
      await c.query(`UPDATE reservations SET room_id = $2, updated_at = now() WHERE id = $1`, [
        id,
        habitacionId,
      ]);
      await this.#evento(c, id, 'habitacion', null, null, { de: r.room_id, a: habitacionId });
      // El solape no bloquea: se devuelve en `solapes` y la pantalla lo pinta
      // en rojo. Decisión explícita de no tener motor de disponibilidad.
      return this.#detalle(c, id);
    });
  }

  async registrarPago(
    id: string,
    pago: { importe: number; metodo: MetodoDePago; referencia?: string | undefined },
  ): Promise<DetalleDeReserva> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ status: EstadoDeReserva }>(
        `SELECT status FROM reservations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (!r) throw new ErrorDeNegocio('reserva_no_encontrada', 'Esa reserva no existe.', 404);
      if (r.status === 'cancelada') {
        throw new ErrorDeNegocio(
          'reserva_cancelada',
          'No se registran pagos en una reserva cancelada. Si hay que devolver, anótalo en la reserva.',
          409,
        );
      }
      await c.query(
        `INSERT INTO reservation_payments (tenant_id, reservation_id, amount_cents, method, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.tenantId, id, pago.importe, pago.metodo, pago.referencia?.trim() || null, ctx.userId],
      );
      await this.#evento(c, id, 'pago', null, null, { importe: pago.importe, metodo: pago.metodo });
      return this.#detalle(c, id);
    });
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  async #quien(
    c: PoolClient,
    p: PeticionDeReserva,
  ): Promise<{ contactId: string; conversationId: string | null }> {
    if (p.conversacionId) {
      const { rows } = await c.query<{ contact_id: string }>(
        `SELECT contact_id FROM conversations WHERE id = $1`,
        [p.conversacionId],
      );
      if (!rows[0]) {
        throw new ErrorDeNegocio('conversacion_no_encontrada', 'La conversación no existe.', 404);
      }
      return { contactId: rows[0].contact_id, conversationId: p.conversacionId };
    }
    if (!p.contactoId) {
      throw new ErrorDeNegocio(
        'sin_huesped',
        'Una reserva necesita una conversación o un cliente.',
        422,
      );
    }
    const { rows } = await c.query(
      `SELECT 1 FROM contacts WHERE id = $1 AND anonymized_at IS NULL`,
      [p.contactoId],
    );
    if (!rows[0]) throw new ErrorDeNegocio('contacto_no_encontrado', 'Ese cliente no existe.', 404);
    return { contactId: p.contactoId, conversationId: null };
  }

  async #exigirHabitacionDelTipo(c: PoolClient, habitacionId: string, tipoId: string) {
    const { rows } = await c.query<{ room_type_id: string }>(
      `SELECT room_type_id FROM rooms WHERE id = $1`,
      [habitacionId],
    );
    if (!rows[0]) {
      throw new ErrorDeNegocio('habitacion_no_encontrada', 'Esa habitación no existe.', 404);
    }
    // Asignar un bungalow a una reserva de «Doble» es venderle al huésped una
    // cosa y darle otra: el precio copiado ya no correspondería.
    if (rows[0].room_type_id !== tipoId) {
      throw new ErrorDeNegocio(
        'habitacion_de_otro_tipo',
        'Esa habitación es de otro tipo que el reservado.',
        422,
      );
    }
  }

  async #ganarLead(c: PoolClient, tenantId: string, userId: string, leadId: string, total: number) {
    const { rows } = await c.query<{
      stage_id: string;
      pipeline_id: string;
      status: string;
      amount_cents: string;
    }>(`SELECT stage_id, pipeline_id, status, amount_cents FROM leads WHERE id = $1 FOR UPDATE`, [
      leadId,
    ]);
    const lead = rows[0];
    if (!lead || lead.status !== 'abierto') return;
    // La primera etapa GANADA del embudo. Por tipo, no por nombre: el hotel
    // puede llamarla «Confirmada» o «Pagada», y se busca igual.
    const { rows: etapas } = await c.query<{ id: string }>(
      `SELECT id FROM pipeline_stages
        WHERE pipeline_id = $1 AND kind = 'ganada'
        ORDER BY position LIMIT 1`,
      [lead.pipeline_id],
    );
    const ganada = etapas[0];
    if (!ganada) return; // Un embudo sin etapa ganada: no hay a dónde moverlo, y no se inventa.
    await c.query(
      `UPDATE leads
          SET stage_id = $2, status = 'ganado', closed_at = now(),
              amount_cents = CASE WHEN amount_cents = 0 THEN $3 ELSE amount_cents END,
              updated_at = now()
        WHERE id = $1`,
      [leadId, ganada.id, total],
    );
    await c.query(
      `INSERT INTO lead_events (tenant_id, lead_id, type, from_stage_id, to_stage_id, actor_user_id, meta)
       VALUES ($1, $2, 'movido', $3, $4, $5, $6)`,
      [
        tenantId,
        leadId,
        lead.stage_id,
        ganada.id,
        userId,
        JSON.stringify({ por: 'reserva_confirmada' }),
      ],
    );
  }

  async #evento(
    c: PoolClient,
    reservaId: string,
    tipo: string,
    desde: string | null,
    hasta: string | null,
    meta: unknown,
  ) {
    const ctx = this.#exigirContexto();
    await c.query(
      `INSERT INTO reservation_events (tenant_id, reservation_id, type, from_status, to_status, actor_user_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        ctx.tenantId,
        reservaId,
        tipo,
        desde,
        hasta,
        ctx.userId,
        meta === null ? null : JSON.stringify(meta),
      ],
    );
  }

  async #detalle(c: PoolClient, id: string): Promise<DetalleDeReserva> {
    const { rows } = await c.query<
      FilaDeReserva & {
        room_type_id: string;
        room_id: string | null;
        lead_id: string | null;
        notes: string | null;
      }
    >(`${SELECT_RESUMEN} WHERE r.id = $1`, [id]);
    const f = rows[0];
    if (!f) throw new ErrorDeNegocio('reserva_no_encontrada', 'Esa reserva no existe.', 404);

    const { rows: lineas } = await c.query<{
      kind: 'noche' | 'servicio' | 'descuento';
      description: string;
      night: string | null;
      quantity: number;
      unit_cents: string;
      total_cents: string;
    }>(
      `SELECT kind, description, to_char(night, 'YYYY-MM-DD') AS night, quantity, unit_cents, total_cents
         FROM reservation_lines WHERE reservation_id = $1 ORDER BY position`,
      [id],
    );
    const { rows: pagos } = await c.query<{
      id: string;
      amount_cents: string;
      method: MetodoDePago;
      reference: string | null;
      paid_at: Date;
    }>(
      `SELECT id, amount_cents, method, reference, paid_at
         FROM reservation_payments WHERE reservation_id = $1 ORDER BY paid_at`,
      [id],
    );
    const { rows: historial } = await c.query<{
      type: string;
      from_status: string | null;
      to_status: string | null;
      at: Date;
      actor: string | null;
    }>(
      `SELECT e.type, e.from_status, e.to_status, e.at, u.full_name AS actor
         FROM reservation_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.reservation_id = $1 ORDER BY e.at`,
      [id],
    );

    // Solapes en la MISMA habitación, solo entre reservas vivas.
    let solapes: DetalleDeReserva['solapes'] = [];
    if (
      f.room_id &&
      (f.status === 'pendiente' || f.status === 'confirmada' || f.status === 'en_casa')
    ) {
      const { rows: otras } = await c.query<{
        id: string;
        nombre: string | null;
        entrada: string;
        salida: string;
      }>(
        `SELECT r.id, ct.display_name AS nombre,
                to_char(r.check_in, 'YYYY-MM-DD') AS entrada,
                to_char(r.check_out, 'YYYY-MM-DD') AS salida
           FROM reservations r JOIN contacts ct ON ct.id = r.contact_id
          WHERE r.room_id = $1 AND r.id <> $2
            AND r.status IN ('pendiente', 'confirmada', 'en_casa')`,
        [f.room_id, id],
      );
      solapes = otras
        .filter((o) => seSolapan({ entrada: f.entrada, salida: f.salida }, o))
        .map((o) => ({ id: o.id, contacto: o.nombre, entrada: o.entrada, salida: o.salida }));
    }

    const resumen = aResumen(f);
    return {
      ...resumen,
      tipoId: f.room_type_id,
      habitacionId: f.room_id,
      leadId: f.lead_id,
      notas: f.notes,
      lineas: lineas.map((l) => ({
        tipo: l.kind,
        descripcion: l.description,
        noche: l.night,
        cantidad: l.quantity,
        unitario: Number(l.unit_cents),
        total: Number(l.total_cents),
      })),
      pagos: pagos.map((pg) => ({
        id: pg.id,
        importe: Number(pg.amount_cents),
        metodo: pg.method,
        referencia: pg.reference,
        pagadoEn: pg.paid_at,
      })),
      historial: historial.map((h) => ({
        tipo: h.type,
        desde: h.from_status,
        hasta: h.to_status,
        en: h.at,
        actor: h.actor,
      })),
      saldo: saldoDeReserva(
        resumen.total,
        pagos.map((pg) => Number(pg.amount_cents)),
      ),
      acciones: accionesPosibles(f.status),
      solapes,
    };
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}

// ---------------------------------------------------------------------------

const SELECT_RESUMEN = `
  SELECT r.id, r.status, r.contact_id, ct.display_name AS contact_name,
         r.room_type_name, rm.name AS room_name,
         to_char(r.check_in, 'YYYY-MM-DD') AS entrada,
         to_char(r.check_out, 'YYYY-MM-DD') AS salida,
         (r.check_out - r.check_in) AS noches,
         r.guests, r.total_cents, r.currency, r.conversation_id, r.created_at,
         r.room_type_id, r.room_id, r.lead_id, r.notes,
         COALESCE((SELECT sum(amount_cents) FROM reservation_payments p
                    WHERE p.reservation_id = r.id), 0) AS pagado
    FROM reservations r
    JOIN contacts ct ON ct.id = r.contact_id
    LEFT JOIN rooms rm ON rm.id = r.room_id`;

interface FilaDeReserva {
  id: string;
  status: EstadoDeReserva;
  contact_id: string;
  contact_name: string | null;
  room_type_name: string;
  room_name: string | null;
  entrada: string;
  salida: string;
  noches: number;
  guests: number;
  total_cents: string;
  currency: string;
  conversation_id: string | null;
  created_at: Date;
  room_id: string | null;
  pagado: string;
}

function aResumen(f: FilaDeReserva): ResumenDeReserva {
  return {
    id: f.id,
    estado: f.status,
    contacto: { id: f.contact_id, nombre: f.contact_name },
    tipo: f.room_type_name,
    habitacion: f.room_name,
    entrada: f.entrada,
    salida: f.salida,
    noches: Number(f.noches),
    personas: f.guests,
    total: Number(f.total_cents),
    pagado: Number(f.pagado),
    moneda: f.currency,
    conversacionId: f.conversation_id,
    creadaEn: f.created_at,
  };
}
