/**
 * El catálogo del hotel (migración 0021): tipos, habitaciones, tarifas y
 * servicios, y el cotizador que el agente abre mientras chatea.
 *
 * Leer es de todos: un agente necesita los precios para contestar «¿cuánto
 * sale el familiar para el 28?». Cambiar el catálogo es de propietario o
 * administrador — una tarifa mal puesta la cobra todo el equipo.
 *
 * El cálculo del precio NO vive aquí: es `cotizarEstancia` de `@crmapp/core`.
 * Este servicio solo carga lo que ese cálculo necesita. Si la reserva
 * calculara por su cuenta, el precio que ve el agente al cotizar y el que se
 * guarda al reservar podrían no coincidir, y esa diferencia la descubre el
 * cliente en recepción.
 */
import type { PoolClient } from 'pg';
import {
  cotizarEstancia,
  type Cotizacion,
  type ServicioParaCotizar,
  type TarifaParaCotizar,
  type UnidadDeServicio,
} from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export type EstadoDeHabitacion = 'disponible' | 'mantenimiento' | 'fuera_de_servicio';

export interface Habitacion {
  id: string;
  tipoId: string;
  nombre: string;
  estado: EstadoDeHabitacion;
  notas: string | null;
}

export interface Tarifa {
  id: string;
  tipoId: string;
  nombre: string;
  desde: string;
  hasta: string;
  precio: number;
  minNoches: number;
  dias: number[] | null;
}

export interface TipoDeHabitacion {
  id: string;
  nombre: string;
  descripcion: string | null;
  capacidad: number;
  precioBase: number | null;
  moneda: string;
  activo: boolean;
  habitaciones: Habitacion[];
  tarifas: Tarifa[];
}

export interface ServicioDeHotel {
  id: string;
  nombre: string;
  precio: number;
  moneda: string;
  unidad: UnidadDeServicio;
  activo: boolean;
}

export interface Catalogo {
  tipos: TipoDeHabitacion[];
  servicios: ServicioDeHotel[];
}

export class HotelService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  constructor(opciones: { db: BaseDeDatos; ahora?: (() => Date) | undefined }) {
    this.#db = opciones.db;
    this.#ahora = opciones.ahora ?? (() => new Date());
  }

  /**
   * «Hoy» a efectos de avisar de una entrada pasada: el día UTC de AYER.
   *
   * No se guarda la zona horaria de cada cuenta, y con el día UTC a secas un
   * hotel de Lima vería «ya pasó» entre las 19:00 y la medianoche. Ayer en UTC
   * es un día que ya terminó en cualquier sitio del planeta: el aviso puede
   * llegar un día tarde, pero nunca salta por error.
   */
  #hoyParaAvisar(): string {
    return new Date(this.#ahora().getTime() - 86_400_000).toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async catalogo(): Promise<Catalogo> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows: tipos } = await c.query<{
        id: string;
        name: string;
        description: string | null;
        capacity: number;
        base_rate_cents: string | null;
        currency: string;
        active: boolean;
      }>(
        `SELECT id, name, description, capacity, base_rate_cents, currency, active
           FROM room_types ORDER BY active DESC, position, name`,
      );
      const { rows: habitaciones } = await c.query<{
        id: string;
        room_type_id: string;
        name: string;
        status: EstadoDeHabitacion;
        notes: string | null;
      }>(`SELECT id, room_type_id, name, status, notes FROM rooms ORDER BY name`);
      const tarifas = await this.#tarifas(c);
      const { rows: servicios } = await c.query<{
        id: string;
        name: string;
        price_cents: string;
        currency: string;
        unit: UnidadDeServicio;
        active: boolean;
      }>(
        `SELECT id, name, price_cents, currency, unit, active
           FROM hotel_services ORDER BY active DESC, name`,
      );

      return {
        tipos: tipos.map((t) => ({
          id: t.id,
          nombre: t.name,
          descripcion: t.description,
          capacidad: t.capacity,
          precioBase: t.base_rate_cents === null ? null : Number(t.base_rate_cents),
          moneda: t.currency,
          activo: t.active,
          habitaciones: habitaciones
            .filter((h) => h.room_type_id === t.id)
            .map((h) => ({
              id: h.id,
              tipoId: h.room_type_id,
              nombre: h.name,
              estado: h.status,
              notas: h.notes,
            })),
          tarifas: tarifas.filter((r) => r.tipoId === t.id),
        })),
        servicios: servicios.map((s) => ({
          id: s.id,
          nombre: s.name,
          precio: Number(s.price_cents),
          moneda: s.currency,
          unidad: s.unit,
          activo: s.active,
        })),
      };
    });
  }

  /**
   * Cotiza una estancia con el catálogo de HOY. Lo usa el agente mientras
   * responde y lo usará la reserva al crearse; los dos pasan por aquí.
   */
  async cotizar(p: {
    tipoId: string;
    entrada: string;
    salida: string;
    personas: number;
    servicios?: string[] | undefined;
  }): Promise<Cotizacion & { tipo: string }> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        name: string;
        capacity: number;
        base_rate_cents: string | null;
        currency: string;
        active: boolean;
      }>(`SELECT name, capacity, base_rate_cents, currency, active FROM room_types WHERE id = $1`, [
        p.tipoId,
      ]);
      const tipo = rows[0];
      if (!tipo) {
        throw new ErrorDeNegocio('tipo_no_encontrado', 'Ese tipo de habitación no existe.', 404);
      }

      // Solo las tarifas que tocan el rango: traer todas las del año para
      // cotizar dos noches es trabajo que nadie necesita.
      const tarifas: TarifaParaCotizar[] = (
        await this.#tarifas(c, p.tipoId, p.entrada, p.salida)
      ).map((t) => ({
        id: t.id,
        nombre: t.nombre,
        desde: t.desde,
        hasta: t.hasta,
        precio: t.precio,
        minNoches: t.minNoches,
        dias: t.dias,
      }));

      let servicios: ServicioParaCotizar[] = [];
      if (p.servicios?.length) {
        const { rows: filas } = await c.query<{
          id: string;
          name: string;
          price_cents: string;
          unit: UnidadDeServicio;
        }>(
          `SELECT id, name, price_cents, unit FROM hotel_services
            WHERE id = ANY($1::uuid[]) AND active`,
          [p.servicios],
        );
        servicios = filas.map((s) => ({
          id: s.id,
          nombre: s.name,
          precio: Number(s.price_cents),
          unidad: s.unit,
        }));
      }

      const cotizacion = cotizarEstancia({
        entrada: p.entrada,
        salida: p.salida,
        personas: p.personas,
        capacidad: tipo.capacity,
        precioBase: tipo.base_rate_cents === null ? null : Number(tipo.base_rate_cents),
        moneda: tipo.currency,
        tarifas,
        servicios,
        hoy: this.#hoyParaAvisar(),
      });
      return { ...cotizacion, tipo: tipo.name };
    });
  }

  // -------------------------------------------------------------------------
  // Tipos
  // -------------------------------------------------------------------------

  async crearTipo(d: {
    nombre: string;
    descripcion?: string | null | undefined;
    capacidad: number;
    precioBase?: number | null | undefined;
  }): Promise<{ id: string }> {
    const ctx = this.#exigirAdmin();
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      await c
        .query(
          `INSERT INTO room_types (id, tenant_id, name, description, capacity, base_rate_cents, position)
           VALUES ($1, $2, $3, $4, $5, $6,
                   COALESCE((SELECT max(position) + 1 FROM room_types), 0))`,
          [
            id,
            ctx.tenantId,
            d.nombre.trim(),
            d.descripcion ?? null,
            d.capacidad,
            d.precioBase ?? null,
          ],
        )
        .catch(repetido('tipo_repetido', 'Ya hay un tipo de habitación con ese nombre.'));
      return { id };
    });
  }

  async editarTipo(
    id: string,
    d: Partial<{
      nombre: string;
      descripcion: string | null;
      capacidad: number;
      precioBase: number | null;
      activo: boolean;
    }>,
  ): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c
        .query(
          `UPDATE room_types SET
             name            = COALESCE($2, name),
             description     = CASE WHEN $3::boolean THEN $4 ELSE description END,
             capacity        = COALESCE($5, capacity),
             base_rate_cents = CASE WHEN $6::boolean THEN $7::bigint ELSE base_rate_cents END,
             active          = COALESCE($8, active),
             updated_at      = now()
           WHERE id = $1`,
          [
            id,
            d.nombre?.trim() ?? null,
            d.descripcion !== undefined,
            d.descripcion ?? null,
            d.capacidad ?? null,
            d.precioBase !== undefined,
            d.precioBase ?? null,
            d.activo ?? null,
          ],
        )
        .catch(repetido('tipo_repetido', 'Ya hay un tipo de habitación con ese nombre.'));
      if (rowCount === 0) {
        throw new ErrorDeNegocio('tipo_no_encontrado', 'Ese tipo de habitación no existe.', 404);
      }
    });
  }

  /**
   * Borrar un tipo que todavía tiene habitaciones no se puede, y el servidor
   * lo dice con el número. Para dejar de ofrecerlo sin perder nada está
   * `activo: false`.
   */
  async borrarTipo(id: string): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM rooms WHERE room_type_id = $1`,
        [id],
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        throw new ErrorDeNegocio(
          'tipo_con_habitaciones',
          `Este tipo tiene ${n} habitación(es). Muévelas o archiva el tipo en vez de borrarlo.`,
          409,
          { habitaciones: n },
        );
      }
      const { rowCount } = await c.query(`DELETE FROM room_types WHERE id = $1`, [id]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('tipo_no_encontrado', 'Ese tipo de habitación no existe.', 404);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Habitaciones
  // -------------------------------------------------------------------------

  async crearHabitacion(d: {
    tipoId: string;
    nombre: string;
    notas?: string | null | undefined;
  }): Promise<{ id: string }> {
    const ctx = this.#exigirAdmin();
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirTipo(c, d.tipoId);
      const id = await this.#db.nuevoId(c);
      await c
        .query(
          `INSERT INTO rooms (id, tenant_id, room_type_id, name, notes) VALUES ($1, $2, $3, $4, $5)`,
          [id, ctx.tenantId, d.tipoId, d.nombre.trim(), d.notas ?? null],
        )
        .catch(repetido('habitacion_repetida', 'Ya hay una habitación con ese nombre.'));
      return { id };
    });
  }

  async editarHabitacion(
    id: string,
    d: Partial<{
      tipoId: string;
      nombre: string;
      estado: EstadoDeHabitacion;
      notas: string | null;
    }>,
  ): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      if (d.tipoId) await this.#exigirTipo(c, d.tipoId);
      const { rowCount } = await c
        .query(
          `UPDATE rooms SET
             room_type_id = COALESCE($2, room_type_id),
             name         = COALESCE($3, name),
             status       = COALESCE($4, status),
             notes        = CASE WHEN $5::boolean THEN $6 ELSE notes END,
             updated_at   = now()
           WHERE id = $1`,
          [
            id,
            d.tipoId ?? null,
            d.nombre?.trim() ?? null,
            d.estado ?? null,
            d.notas !== undefined,
            d.notas ?? null,
          ],
        )
        .catch(repetido('habitacion_repetida', 'Ya hay una habitación con ese nombre.'));
      if (rowCount === 0) {
        throw new ErrorDeNegocio('habitacion_no_encontrada', 'Esa habitación no existe.', 404);
      }
    });
  }

  async borrarHabitacion(id: string): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM rooms WHERE id = $1`, [id]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('habitacion_no_encontrada', 'Esa habitación no existe.', 404);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Tarifas
  // -------------------------------------------------------------------------

  async crearTarifa(d: Omit<Tarifa, 'id'>): Promise<{ id: string }> {
    const ctx = this.#exigirAdmin();
    validarRango(d.desde, d.hasta);
    return this.#db.enTransaccion(async (c) => {
      await this.#exigirTipo(c, d.tipoId);
      const id = await this.#db.nuevoId(c);
      await c.query(
        `INSERT INTO rates (id, tenant_id, room_type_id, name, valid_from, valid_to,
                            price_cents, min_nights, weekdays)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          ctx.tenantId,
          d.tipoId,
          d.nombre.trim(),
          d.desde,
          d.hasta,
          d.precio,
          d.minNoches,
          d.dias && d.dias.length > 0 ? d.dias : null,
        ],
      );
      return { id };
    });
  }

  async editarTarifa(id: string, d: Partial<Omit<Tarifa, 'id' | 'tipoId'>>): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ valid_from: string; valid_to: string }>(
        `SELECT to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                to_char(valid_to, 'YYYY-MM-DD') AS valid_to
           FROM rates WHERE id = $1`,
        [id],
      );
      const actual = rows[0];
      if (!actual) throw new ErrorDeNegocio('tarifa_no_encontrada', 'Esa tarifa no existe.', 404);
      validarRango(d.desde ?? actual.valid_from, d.hasta ?? actual.valid_to);
      await c.query(
        `UPDATE rates SET
           name        = COALESCE($2, name),
           valid_from  = COALESCE($3::date, valid_from),
           valid_to    = COALESCE($4::date, valid_to),
           price_cents = COALESCE($5, price_cents),
           min_nights  = COALESCE($6, min_nights),
           weekdays    = CASE WHEN $7::boolean THEN $8::int[] ELSE weekdays END,
           updated_at  = now()
         WHERE id = $1`,
        [
          id,
          d.nombre?.trim() ?? null,
          d.desde ?? null,
          d.hasta ?? null,
          d.precio ?? null,
          d.minNoches ?? null,
          d.dias !== undefined,
          d.dias && d.dias.length > 0 ? d.dias : null,
        ],
      );
    });
  }

  async borrarTarifa(id: string): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM rates WHERE id = $1`, [id]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('tarifa_no_encontrada', 'Esa tarifa no existe.', 404);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Servicios
  // -------------------------------------------------------------------------

  async crearServicio(d: {
    nombre: string;
    precio: number;
    unidad: UnidadDeServicio;
  }): Promise<{ id: string }> {
    const ctx = this.#exigirAdmin();
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      await c
        .query(
          `INSERT INTO hotel_services (id, tenant_id, name, price_cents, unit)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, ctx.tenantId, d.nombre.trim(), d.precio, d.unidad],
        )
        .catch(repetido('servicio_repetido', 'Ya hay un servicio con ese nombre.'));
      return { id };
    });
  }

  async editarServicio(
    id: string,
    d: Partial<{ nombre: string; precio: number; unidad: UnidadDeServicio; activo: boolean }>,
  ): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c
        .query(
          `UPDATE hotel_services SET
             name        = COALESCE($2, name),
             price_cents = COALESCE($3, price_cents),
             unit        = COALESCE($4, unit),
             active      = COALESCE($5, active),
             updated_at  = now()
           WHERE id = $1`,
          [id, d.nombre?.trim() ?? null, d.precio ?? null, d.unidad ?? null, d.activo ?? null],
        )
        .catch(repetido('servicio_repetido', 'Ya hay un servicio con ese nombre.'));
      if (rowCount === 0) {
        throw new ErrorDeNegocio('servicio_no_encontrado', 'Ese servicio no existe.', 404);
      }
    });
  }

  async borrarServicio(id: string): Promise<void> {
    this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM hotel_services WHERE id = $1`, [id]);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('servicio_no_encontrado', 'Ese servicio no existe.', 404);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  /**
   * Tarifas en orden de creación —el desempate de `cotizarEstancia` depende de
   * ese orden— y, si se pide, solo las que tocan un rango de fechas.
   */
  async #tarifas(
    c: PoolClient,
    tipoId?: string,
    entrada?: string,
    salida?: string,
  ): Promise<Tarifa[]> {
    const condiciones: string[] = [];
    const params: unknown[] = [];
    if (tipoId) {
      params.push(tipoId);
      condiciones.push(`room_type_id = $${params.length}`);
    }
    if (entrada && salida) {
      params.push(entrada, salida);
      condiciones.push(
        `valid_from < $${params.length}::date AND valid_to >= $${params.length - 1}::date`,
      );
    }
    const { rows } = await c.query<{
      id: string;
      room_type_id: string;
      name: string;
      desde: string;
      hasta: string;
      price_cents: string;
      min_nights: number;
      weekdays: number[] | null;
    }>(
      `SELECT id, room_type_id, name,
              to_char(valid_from, 'YYYY-MM-DD') AS desde,
              to_char(valid_to, 'YYYY-MM-DD') AS hasta,
              price_cents, min_nights, weekdays
         FROM rates
        ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}
        ORDER BY created_at, id`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      tipoId: r.room_type_id,
      nombre: r.name,
      desde: r.desde,
      hasta: r.hasta,
      precio: Number(r.price_cents),
      minNoches: r.min_nights,
      dias: r.weekdays,
    }));
  }

  async #exigirTipo(c: PoolClient, tipoId: string): Promise<void> {
    const { rows } = await c.query(`SELECT 1 FROM room_types WHERE id = $1`, [tipoId]);
    if (rows.length === 0) {
      throw new ErrorDeNegocio('tipo_no_encontrado', 'Ese tipo de habitación no existe.', 404);
    }
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
        'permiso_insuficiente',
        'Solo el propietario o un administrador puede cambiar el catálogo del hotel.',
        403,
      );
    }
    return ctx;
  }
}

function validarRango(desde: string, hasta: string): void {
  if (hasta < desde) {
    throw new ErrorDeNegocio(
      'rango_invalido',
      'La tarifa termina antes de empezar: revisa las fechas.',
      422,
    );
  }
}

function repetido(codigo: string, mensaje: string) {
  return (e: { code?: string }): never => {
    if (e.code === '23505') throw new ErrorDeNegocio(codigo, mensaje, 409);
    throw e;
  };
}
