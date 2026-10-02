/**
 * Horario de atención del hotel y aviso fuera de horario (0027).
 *
 * Aquí solo se guarda y se lee. Quién decide si está abierto es
 * `packages/core/src/horario.ts`, y quien envía el aviso es el worker cuando
 * entra un mensaje: la API nunca escribe sola a un cliente.
 *
 * El horario se valida con la MISMA función que usa el resto del sistema: un
 * tramo al revés o dos que se pisan se rechazan al guardar, no cuando alguien
 * se queda sin aviso un domingo.
 *
 * ## Por equipo (PR-110)
 *
 * Un equipo puede tener horario propio —«Reservas» de 9 a 18 mientras
 * «Recepción» atiende siempre—. Sin el suyo, usa el general. Rige las
 * conversaciones que ya pertenecen a ese equipo: el primer mensaje de alguien
 * nuevo aún no tiene equipo, y le aplica el general.
 */
import type { PoolClient } from 'pg';
import { validarHorario, type Horario } from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

export interface HorarioDeAtencion {
  zonaHoraria: string;
  horario: Horario;
  avisoActivo: boolean;
  avisoTexto: string;
  /** Si el horario está configurado. Sin él no hay aviso posible. */
  configurado: boolean;
  /** De qué equipo es; `null` es el general. */
  equipoId: string | null;
  /**
   * Si el equipo tiene horario propio. Si no, lo que se devuelve es el
   * general, que es el que de verdad le aplica. En el general, = configurado.
   */
  propio: boolean;
  /** Los equipos con horario propio, para que la pantalla lo marque. */
  equiposConHorario: string[];
}

/** Zona horaria por defecto: el cliente es peruano (P-04). */
const ZONA_POR_DEFECTO = 'America/Lima';

export class HorarioService {
  readonly #db: BaseDeDatos;

  constructor(o: { db: BaseDeDatos }) {
    this.#db = o.db;
  }

  async leer(equipoId: string | null = null): Promise<HorarioDeAtencion> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      if (equipoId) await exigirEquipo(c, equipoId);
      const { rows } = await c.query<{
        team_id: string | null;
        timezone: string;
        schedule: Horario;
        auto_reply_enabled: boolean;
        auto_reply_text: string;
      }>(
        `SELECT team_id, timezone, schedule, auto_reply_enabled, auto_reply_text
           FROM business_hours WHERE team_id IS NULL OR team_id = $1`,
        [equipoId],
      );
      const general = rows.find((r) => r.team_id === null);
      const suyo = equipoId ? rows.find((r) => r.team_id === equipoId) : general;
      // Sin horario propio, el equipo usa el general: eso es lo que se enseña,
      // porque es lo que de verdad le aplica.
      const f = suyo ?? general;
      const { rows: conHorario } = await c.query<{ team_id: string }>(
        `SELECT team_id FROM business_hours WHERE team_id IS NOT NULL`,
      );
      return {
        zonaHoraria: f?.timezone ?? ZONA_POR_DEFECTO,
        horario: f?.schedule ?? {},
        avisoActivo: f?.auto_reply_enabled ?? false,
        avisoTexto: f?.auto_reply_text ?? '',
        configurado: Boolean(f),
        equipoId,
        propio: Boolean(suyo),
        equiposConHorario: conHorario.map((r) => r.team_id),
      };
    });
  }

  async guardar(
    cambios: {
      zonaHoraria?: string | undefined;
      horario?: Horario | undefined;
      avisoActivo?: boolean | undefined;
      avisoTexto?: string | undefined;
    },
    equipoId: string | null = null,
  ): Promise<HorarioDeAtencion> {
    const ctx = this.#exigirAdmin();
    // Para un equipo sin horario propio, `leer` devuelve el general: guardar
    // parte de él, que es lo que el administrador estaba viendo.
    const actual = await this.leer(equipoId);
    const horario = cambios.horario ?? actual.horario;
    const zonaHoraria = cambios.zonaHoraria ?? actual.zonaHoraria;
    const avisoTexto = cambios.avisoTexto ?? actual.avisoTexto;
    const avisoActivo = cambios.avisoActivo ?? actual.avisoActivo;

    const errores = validarHorario(horario);
    if (errores.length > 0) {
      throw new ErrorDeNegocio('horario_invalido', explicar(errores[0]!), 422, { errores });
    }
    if (!zonaValida(zonaHoraria)) {
      throw new ErrorDeNegocio(
        'zona_horaria_invalida',
        `«${zonaHoraria}» no es una zona horaria conocida.`,
        422,
      );
    }
    // Un aviso encendido sin texto no avisa de nada: se dice ahora y no
    // cuando un cliente escriba de madrugada y no reciba nada.
    if (avisoActivo && !avisoTexto.trim()) {
      throw new ErrorDeNegocio(
        'aviso_sin_texto',
        'Escribe el mensaje que se enviará fuera de horario.',
        422,
      );
    }

    await this.#db.enTransaccion(async (c) => {
      await c.query(
        `INSERT INTO business_hours (tenant_id, team_id, timezone, schedule,
                                     auto_reply_enabled, auto_reply_text)
         VALUES ($1, $6, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, team_id) DO UPDATE
            SET timezone = EXCLUDED.timezone,
                schedule = EXCLUDED.schedule,
                auto_reply_enabled = EXCLUDED.auto_reply_enabled,
                auto_reply_text = EXCLUDED.auto_reply_text,
                updated_at = now()`,
        [
          ctx.tenantId,
          zonaHoraria,
          JSON.stringify(horario),
          avisoActivo,
          avisoTexto.trim(),
          equipoId,
        ],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'cuenta.horario', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify({ zonaHoraria, avisoActivo, equipoId })],
      );
    });
    return this.leer(equipoId);
  }

  /** El equipo deja su horario propio y vuelve a usar el general. */
  async quitarDeEquipo(equipoId: string): Promise<HorarioDeAtencion> {
    const ctx = this.#exigirAdmin();
    await this.#db.enTransaccion(async (c) => {
      await exigirEquipo(c, equipoId);
      await c.query(`DELETE FROM business_hours WHERE team_id = $1`, [equipoId]);
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'cuenta.horario_quitado', 'team', $3)`,
        [ctx.tenantId, ctx.userId, equipoId],
      );
    });
    return this.leer(equipoId);
  }

  #exigirAdmin() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden cambiar el horario.',
        403,
      );
    }
    return ctx;
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}

/** Bajo la RLS de la cuenta: un equipo de otra no existe, y da 404 igual. */
async function exigirEquipo(c: PoolClient, equipoId: string): Promise<void> {
  const { rowCount } = await c.query(`SELECT 1 FROM teams WHERE id = $1`, [equipoId]);
  if (!rowCount) throw new ErrorDeNegocio('equipo_no_encontrado', 'Ese equipo no existe.', 404);
}

const DIAS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

function explicar(e: ReturnType<typeof validarHorario>[number]): string {
  const dia = DIAS[Number(e.dia)] ?? `día ${e.dia}`;
  switch (e.tipo) {
    case 'dia_invalido':
      return `«${e.dia}» no es un día de la semana.`;
    case 'hora_invalida':
      return `«${e.valor}» no es una hora válida (${dia}).`;
    case 'tramo_al_reves':
      return `El ${dia} cierra antes de abrir (${e.tramo[0]}–${e.tramo[1]}). Para trasnochar, pon un tramo en cada día.`;
    case 'tramos_se_solapan':
      return `Los tramos del ${dia} se pisan.`;
  }
}

function zonaValida(zona: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}
