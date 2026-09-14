/**
 * Panel de control: el estado operativo de la bandeja de un vistazo.
 *
 * La decisión de producto que lo separa de un panel genérico: **lo primero
 * que se ve es lo accionable**, no el volumen. Un número grande de mensajes
 * totales no cambia lo que hace el agente al llegar por la mañana; saber que
 * hay tres conversaciones cuya ventana de 24 h se cierra en menos de dos
 * horas, sí. Esa métrica no la tiene ningún CRM que hayamos visto y sale
 * gratis porque `session_expires_at` ya es un instante calculado (ARCH §9).
 *
 * Todo se calcula en SQL sobre las tablas vivas, con RLS: lo que no es del
 * inquilino no existe. El uso del mes viene de `usage_rollups`, nunca de
 * contar `messages` (ARCH §5.9).
 */
import { leerUsoDelPeriodo, type MetricaDeUso } from '@crmapp/db';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { ESTADO_DE_ATENCION, type EstadoDeAtencion } from '../bandeja/bandeja.service.js';

export type ClaveDePeriodo = '24h' | '7d' | '30d';

const DURACION: Record<ClaveDePeriodo, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

/**
 * El informe del periodo (§15 del encargo): cómo fue, no qué hay que hacer.
 *
 * Tres decisiones que cambian lo que se lee:
 *
 * - **Ventanas móviles, no «hoy» ni «esta semana».** «Hoy» exige saber la
 *   zona horaria del hotel, que no se guarda; con el día UTC, a las 20:00 en
 *   Lima el informe de «hoy» ya estaría vacío. «Últimas 24 horas» significa
 *   lo mismo en cualquier sitio.
 * - **Mediana y percentil 90, no media.** El encargo dice «tiempo promedio»,
 *   pero una conversación olvidada un fin de semana dispara la media y deja
 *   de describir al equipo. La mediana dice el día normal; el p90, cuánto
 *   esperan los peor atendidos. La media no dice ninguna de las dos cosas.
 * - **Nada se suma con cosas que no son lo mismo.** Consultas perdidas en el
 *   embudo y reservas canceladas van separadas; importes, por moneda; y la
 *   conversión se mide sobre una cohorte —las consultas que ENTRARON en el
 *   periodo y cuántas de ELLAS reservaron—, no dividiendo reservas de un mes
 *   entre consultas de otro.
 */
export interface InformeDelPeriodo {
  periodo: { clave: ClaveDePeriodo; desde: Date; hasta: Date };
  conversaciones: {
    nuevas: number;
    porCanal: { canal: string; nuevas: number }[];
    /** Foto de AHORA por estado de atención, con la misma definición que la bandeja. */
    atencionAhora: Record<EstadoDeAtencion, number>;
  };
  respuesta: {
    medianaSegundos: number | null;
    p90Segundos: number | null;
    medidas: number;
  };
  agentes: {
    id: string;
    nombre: string;
    asignadasAbiertas: number;
    /** Asignadas a esta persona donde el último mensaje es del cliente. */
    porResponder: number;
    respuestasEnviadas: number;
  }[];
  clientesNuevos: number;
  reservas: {
    generadas: number;
    confirmadas: number;
    canceladas: number;
    porMoneda: { moneda: string; confirmado: number; cobrado: number }[];
  };
  embudo: {
    consultas: number;
    /** De las consultas del periodo, cuántas acabaron con una reserva no cancelada. */
    conReserva: number;
    perdidas: number;
  };
}

export interface ResumenDelPanel {
  /** Lo accionable ahora mismo. Cada uno enlaza a la bandeja ya filtrada. */
  atencion: {
    sinResponder: number;
    ventanasPorCerrar: number;
    sinAsignar: number;
  };
  conversaciones: {
    abiertas: number;
    pendientes: number;
    cerradasHoy: number;
  };
  /** Mensajes de hoy, por canal y dirección: de dónde viene el trabajo. */
  actividadHoy: {
    canal: string;
    entrantes: number;
    salientes: number;
  }[];
  respuesta: {
    /** Segundos hasta la primera respuesta, mediana de los últimos 7 días. */
    medianaSegundos: number | null;
    conversacionesMedidas: number;
  };
  uso: Record<MetricaDeUso, number>;
  periodo: string;
}

export class PanelService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;

  constructor(o: { db: BaseDeDatos; ahora?: () => Date }) {
    this.#db = o.db;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  async informe(clave: ClaveDePeriodo): Promise<InformeDelPeriodo> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    const hasta = this.#ahora();
    const desde = new Date(hasta.getTime() - DURACION[clave] * 86_400_000);

    return this.#db.enTransaccion(async (c) => {
      const porCanal = await c.query<{ canal: string; nuevas: string }>(
        `SELECT ca.channel AS canal, count(*) AS nuevas
           FROM conversations cv JOIN channel_accounts ca ON ca.id = cv.channel_account_id
          WHERE cv.created_at >= $1 AND cv.created_at < $2
          GROUP BY ca.channel ORDER BY count(*) DESC`,
        [desde, hasta],
      );

      // La MISMA expresión que pinta la bandeja: si el informe contara
      // «por responder» de otra forma, los números no cuadrarían con la lista
      // que el agente tiene delante.
      const atencion = await c.query<{ atencion: EstadoDeAtencion; n: string }>(
        `SELECT ${ESTADO_DE_ATENCION} AS atencion, count(*) AS n
           FROM conversations c GROUP BY 1`,
      );

      const respuesta = await c.query<{ mediana: string | null; p90: string | null; n: string }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS mediana,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY s) AS p90,
                count(*) AS n
           FROM (SELECT extract(epoch FROM (first_response_at - created_at)) AS s
                   FROM conversations
                  WHERE first_response_at >= $1 AND first_response_at < $2
                    AND first_response_at > created_at) t`,
        [desde, hasta],
      );

      const agentes = await c.query<{
        id: string;
        nombre: string;
        asignadas: string;
        por_responder: string;
        respuestas: string;
      }>(
        `SELECT u.id, u.full_name AS nombre,
                (SELECT count(*) FROM conversations cv
                  WHERE cv.assignee_user_id = u.id AND cv.status <> 'closed') AS asignadas,
                (SELECT count(*) FROM conversations cv
                  WHERE cv.assignee_user_id = u.id AND cv.status <> 'closed'
                    AND cv.last_inbound_at > COALESCE(cv.last_outbound_at, '-infinity'::timestamptz))
                  AS por_responder,
                (SELECT count(*) FROM messages m
                  WHERE m.sent_by_user_id = u.id AND m.sent_by = 'human'
                    AND m.direction = 'outbound'
                    AND m.created_at >= $1 AND m.created_at < $2) AS respuestas
           FROM memberships mb JOIN users u ON u.id = mb.user_id
          WHERE mb.status = 'active'
          ORDER BY u.full_name`,
        [desde, hasta],
      );

      const clientes = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM contacts
          WHERE created_at >= $1 AND created_at < $2 AND anonymized_at IS NULL`,
        [desde, hasta],
      );

      // Confirmadas y canceladas por el EVENTO del periodo, no por el estado
      // actual: una reserva confirmada el lunes y cancelada el jueves cuenta
      // en las dos columnas de su semana, que es lo que pasó.
      const reservas = await c.query<{
        generadas: string;
        confirmadas: string;
        canceladas: string;
      }>(
        `SELECT
           (SELECT count(*) FROM reservations WHERE created_at >= $1 AND created_at < $2) AS generadas,
           (SELECT count(*) FROM reservation_events
             WHERE type = 'confirmar' AND at >= $1 AND at < $2) AS confirmadas,
           (SELECT count(*) FROM reservation_events
             WHERE type = 'cancelar' AND at >= $1 AND at < $2) AS canceladas`,
        [desde, hasta],
      );
      const dinero = await c.query<{ moneda: string; confirmado: string; cobrado: string }>(
        `SELECT m.moneda,
                COALESCE((SELECT sum(r.total_cents) FROM reservations r
                           JOIN reservation_events e ON e.reservation_id = r.id AND e.type = 'confirmar'
                          WHERE r.currency = m.moneda AND e.at >= $1 AND e.at < $2), 0) AS confirmado,
                COALESCE((SELECT sum(p.amount_cents) FROM reservation_payments p
                           JOIN reservations r ON r.id = p.reservation_id
                          WHERE r.currency = m.moneda AND p.paid_at >= $1 AND p.paid_at < $2), 0) AS cobrado
           FROM (SELECT DISTINCT currency AS moneda FROM reservations) m
          ORDER BY m.moneda`,
        [desde, hasta],
      );

      const embudo = await c.query<{ consultas: string; con_reserva: string; perdidas: string }>(
        `SELECT
           (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2) AS consultas,
           (SELECT count(*) FROM leads l
             WHERE l.created_at >= $1 AND l.created_at < $2
               AND EXISTS (SELECT 1 FROM reservations r
                            WHERE r.contact_id = l.contact_id AND r.created_at >= l.created_at
                              AND r.status <> 'cancelada')) AS con_reserva,
           (SELECT count(*) FROM leads
             WHERE status = 'perdido' AND closed_at >= $1 AND closed_at < $2) AS perdidas`,
        [desde, hasta],
      );

      const atencionAhora: Record<EstadoDeAtencion, number> = {
        nueva: 0,
        por_responder: 0,
        esperando_cliente: 0,
        seguimiento: 0,
        cerrada: 0,
      };
      for (const f of atencion.rows) atencionAhora[f.atencion] = Number(f.n);

      const r = respuesta.rows[0]!;
      const rv = reservas.rows[0]!;
      const eb = embudo.rows[0]!;

      return {
        periodo: { clave, desde, hasta },
        conversaciones: {
          nuevas: porCanal.rows.reduce((suma, f) => suma + Number(f.nuevas), 0),
          porCanal: porCanal.rows.map((f) => ({ canal: f.canal, nuevas: Number(f.nuevas) })),
          atencionAhora,
        },
        respuesta: {
          medianaSegundos: r.mediana === null ? null : Math.round(Number(r.mediana)),
          p90Segundos: r.p90 === null ? null : Math.round(Number(r.p90)),
          medidas: Number(r.n),
        },
        agentes: agentes.rows.map((a) => ({
          id: a.id,
          nombre: a.nombre,
          asignadasAbiertas: Number(a.asignadas),
          porResponder: Number(a.por_responder),
          respuestasEnviadas: Number(a.respuestas),
        })),
        clientesNuevos: Number(clientes.rows[0]!.n),
        reservas: {
          generadas: Number(rv.generadas),
          confirmadas: Number(rv.confirmadas),
          canceladas: Number(rv.canceladas),
          porMoneda: dinero.rows.map((d) => ({
            moneda: d.moneda,
            confirmado: Number(d.confirmado),
            cobrado: Number(d.cobrado),
          })),
        },
        embudo: {
          consultas: Number(eb.consultas),
          conReserva: Number(eb.con_reserva),
          perdidas: Number(eb.perdidas),
        },
      };
    });
  }

  async resumen(): Promise<ResumenDelPanel> {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    const ahora = this.#ahora();

    return this.#db.enTransaccion(async (c) => {
      const estado = await c.query<{
        sin_responder: string;
        ventanas_por_cerrar: string;
        sin_asignar: string;
        abiertas: string;
        pendientes: string;
        cerradas_hoy: string;
      }>(
        `SELECT
           count(*) FILTER (
             WHERE status IN ('open', 'pending')
               AND last_inbound_at IS NOT NULL
               AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)
           ) AS sin_responder,
           -- La ventana que se cierra pronto: si nadie responde, para hablar
           -- con esa persona hará falta una plantilla aprobada.
           count(*) FILTER (
             WHERE status <> 'closed'
               AND session_expires_at > $1
               AND session_expires_at < $1 + interval '2 hours'
           ) AS ventanas_por_cerrar,
           count(*) FILTER (WHERE status IN ('open', 'pending') AND assignee_user_id IS NULL)
             AS sin_asignar,
           count(*) FILTER (WHERE status = 'open') AS abiertas,
           count(*) FILTER (WHERE status = 'pending') AS pendientes,
           count(*) FILTER (WHERE status = 'closed' AND closed_at >= date_trunc('day', $1::timestamptz))
             AS cerradas_hoy
         FROM conversations`,
        [ahora],
      );

      const actividad = await c.query<{ canal: string; entrantes: string; salientes: string }>(
        `SELECT ca.channel AS canal,
                count(*) FILTER (WHERE m.direction = 'inbound') AS entrantes,
                count(*) FILTER (WHERE m.direction = 'outbound') AS salientes
           FROM messages m
           JOIN channel_accounts ca ON ca.id = m.channel_account_id
          WHERE m.created_at >= date_trunc('day', $1::timestamptz)
          GROUP BY ca.channel
          ORDER BY ca.channel`,
        [ahora],
      );

      // Mediana y no media: una conversación olvidada un fin de semana
      // dispara la media y deja de describir el día normal del equipo.
      const respuesta = await c.query<{ mediana: string | null; n: string }>(
        `SELECT percentile_cont(0.5) WITHIN GROUP (
                  ORDER BY extract(epoch FROM (first_response_at - created_at))
                ) AS mediana,
                count(*) AS n
           FROM conversations
          WHERE first_response_at IS NOT NULL
            AND first_response_at >= $1::timestamptz - interval '7 days'
            -- created_at es el primer entrante cuando la conversación nace de
            -- un webhook, que es el caso normal. Con datos importados o
            -- sembrados puede ser posterior a la respuesta y daría duraciones
            -- negativas: esas no se miden, no se maquillan.
            AND first_response_at > created_at`,
        [ahora],
      );

      const uso = await leerUsoDelPeriodo(c, ctx.tenantId, ahora);
      const e = estado.rows[0]!;
      const r = respuesta.rows[0]!;

      return {
        atencion: {
          sinResponder: Number(e.sin_responder),
          ventanasPorCerrar: Number(e.ventanas_por_cerrar),
          sinAsignar: Number(e.sin_asignar),
        },
        conversaciones: {
          abiertas: Number(e.abiertas),
          pendientes: Number(e.pendientes),
          cerradasHoy: Number(e.cerradas_hoy),
        },
        actividadHoy: actividad.rows.map((a) => ({
          canal: a.canal,
          entrantes: Number(a.entrantes),
          salientes: Number(a.salientes),
        })),
        respuesta: {
          medianaSegundos: r.mediana === null ? null : Math.round(Number(r.mediana)),
          conversacionesMedidas: Number(r.n),
        },
        uso,
        periodo: `${ahora.getUTCFullYear()}-${String(ahora.getUTCMonth() + 1).padStart(2, '0')}`,
      };
    });
  }
}
