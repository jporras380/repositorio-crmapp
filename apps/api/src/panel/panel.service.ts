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
