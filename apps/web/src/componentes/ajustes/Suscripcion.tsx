import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { ResumenDeSuscripcion } from '../../api/tipos.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
}

const ESTADOS: Record<string, { texto: string; detalle: string }> = {
  prueba: { texto: 'En prueba', detalle: 'Todo disponible hasta que termine la prueba.' },
  activa: { texto: 'Al día', detalle: 'La cuenta está cubierta.' },
  gracia: {
    texto: 'En gracia',
    detalle: 'El periodo venció. Solo se puede enviar texto y los bots están detenidos.',
  },
  suspendida: {
    texto: 'Suspendida',
    detalle: 'Puedes consultar y exportar tu historial, pero no enviar.',
  },
};

const LIMITES: Record<string, string> = {
  agentes: 'asientos',
  conversaciones_mes: 'conversaciones del mes',
  bot_runs_mes: 'ejecuciones de bot del mes',
  creditos_ia_mes: 'créditos de IA del mes',
};

function dinero(centimos: number, moneda: string): string {
  return `${(centimos / 100).toLocaleString('es', { minimumFractionDigits: 2 })} ${moneda}`;
}

function fecha(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';
}

/**
 * Qué se paga y hasta cuándo está cubierta la cuenta.
 *
 * **No hay botón de pagar, y no es un olvido**: el cobro es manual (ADR-011).
 * Aquí se ve el importe, la cobertura y el historial; el pago se registra por
 * fuera. Poner un botón que no cobra sería peor que no ponerlo.
 */
export function Suscripcion({ api }: Props) {
  const [d, setD] = useState<ResumenDeSuscripcion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .suscripcion()
      .then(setD)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, [api]);

  if (error) {
    return (
      <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
        {error}
      </p>
    );
  }
  if (!d) return <p className={estilos.descripcion}>Cargando…</p>;

  const estado = ESTADOS[d.estado] ?? { texto: d.estado, detalle: '' };
  const moneda = d.plan?.moneda ?? 'USD';
  const cubiertaHasta = d.periodoHasta ?? d.pruebaHasta;

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Suscripción</h2>
          <p className={estilos.descripcion}>
            {d.plan ? `Plan ${d.plan.nombre}` : 'Sin plan'} ·{' '}
            {dinero(d.plan?.precioPorAsientoCentimos ?? 0, moneda)} por asiento y mes. El consumo de
            WhatsApp lo cobra Meta directamente en tu cuenta; aquí solo va la suscripción.
          </p>
        </div>
      </header>

      {d.avisos.map((a) => (
        <p
          key={a.limite}
          className={`${estilos.aviso} ${a.nivel === 'pasado' ? estilos.aviso_error : estilos.aviso_info}`}
          role="status"
        >
          {a.nivel === 'pasado'
            ? `Has llegado al límite de ${LIMITES[a.limite] ?? a.limite} de tu plan (${a.usado} de ${a.tope}). Las conversaciones siguen entrando; lo que se detiene son los bots.`
            : `Vas por ${a.usado} de ${a.tope} ${LIMITES[a.limite] ?? a.limite}.`}
        </p>
      ))}

      <div className={estilos.tarjetas}>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Estado</span>
          <span className={estilos.tarjetaDetalle}>{estado.texto}</span>
          <span className={estilos.descripcion}>{estado.detalle}</span>
        </div>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Este mes</span>
          <span className={estilos.tarjetaDetalle}>{dinero(d.importeMensualCentimos, moneda)}</span>
          <span className={estilos.descripcion}>
            {d.asientos} {d.asientos === 1 ? 'asiento ocupado' : 'asientos ocupados'}
          </span>
        </div>
        <div className={estilos.tarjeta}>
          <span className={estilos.tarjetaTitulo}>Cubierta hasta</span>
          <span className={estilos.tarjetaDetalle}>{fecha(cubiertaHasta)}</span>
          <span className={estilos.descripcion}>
            {d.graciaHasta ? `Después hay gracia hasta el ${fecha(d.graciaHasta)}.` : ''}
          </span>
        </div>
      </div>

      <h3 className={estilos.tarjetaTitulo}>Pagos registrados</h3>
      {d.pagos.length === 0 ? (
        <p className={estilos.descripcion}>
          Todavía no hay ninguno. Los pagos se hacen por transferencia y los registramos nosotros al
          recibirlos.
        </p>
      ) : (
        <table className={estilos.tabla}>
          <thead>
            <tr>
              <th>Cubre</th>
              <th>Importe</th>
              <th>Forma</th>
              <th>Referencia</th>
            </tr>
          </thead>
          <tbody>
            {d.pagos.map((p, i) => (
              <tr key={i}>
                <td>
                  {fecha(p.cubreDesde)} — {fecha(p.cubreHasta)}
                </td>
                <td>{dinero(p.importeCentimos, p.moneda)}</td>
                <td>{p.metodo}</td>
                <td>{p.referencia ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
