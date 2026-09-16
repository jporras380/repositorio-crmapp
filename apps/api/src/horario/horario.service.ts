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
 */
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
}

/** Zona horaria por defecto: el cliente es peruano (P-04). */
const ZONA_POR_DEFECTO = 'America/Lima';

export class HorarioService {
  readonly #db: BaseDeDatos;

  constructor(o: { db: BaseDeDatos }) {
    this.#db = o.db;
  }

  async leer(): Promise<HorarioDeAtencion> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        timezone: string;
        schedule: Horario;
        auto_reply_enabled: boolean;
        auto_reply_text: string;
      }>(
        `SELECT timezone, schedule, auto_reply_enabled, auto_reply_text
           FROM business_hours WHERE team_id IS NULL`,
      );
      const f = rows[0];
      return {
        zonaHoraria: f?.timezone ?? ZONA_POR_DEFECTO,
        horario: f?.schedule ?? {},
        avisoActivo: f?.auto_reply_enabled ?? false,
        avisoTexto: f?.auto_reply_text ?? '',
        configurado: Boolean(f),
      };
    });
  }

  async guardar(cambios: {
    zonaHoraria?: string | undefined;
    horario?: Horario | undefined;
    avisoActivo?: boolean | undefined;
    avisoTexto?: string | undefined;
  }): Promise<HorarioDeAtencion> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo propietario o administrador pueden cambiar el horario.',
        403,
      );
    }
    const actual = await this.leer();
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
         VALUES ($1, NULL, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, team_id) DO UPDATE
            SET timezone = EXCLUDED.timezone,
                schedule = EXCLUDED.schedule,
                auto_reply_enabled = EXCLUDED.auto_reply_enabled,
                auto_reply_text = EXCLUDED.auto_reply_text,
                updated_at = now()`,
        [ctx.tenantId, zonaHoraria, JSON.stringify(horario), avisoActivo, avisoTexto.trim()],
      );
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'cuenta.horario', 'tenant', $1, $3)`,
        [ctx.tenantId, ctx.userId, JSON.stringify({ zonaHoraria, avisoActivo })],
      );
    });
    return this.leer();
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
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
