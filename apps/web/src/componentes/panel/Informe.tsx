import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { ClaveDePeriodo, InformeDelPeriodo } from '../../api/tipos.ts';
import { importe } from '../../vista/dinero.ts';
import estilos from './Informe.module.css';

interface Props {
  api: Api;
}

const PERIODOS: { clave: ClaveDePeriodo; texto: string }[] = [
  { clave: '24h', texto: 'Últimas 24 h' },
  { clave: '7d', texto: '7 días' },
  { clave: '30d', texto: '30 días' },
];

const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

/** Por debajo de esto, una mediana no describe a un equipo. */
const POCAS_MEDIDAS = 5;

function duracion(segundos: number | null): string {
  if (segundos === null) return '—';
  if (segundos < 60) return `${segundos} s`;
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/**
 * El informe del periodo: cómo fue, no qué hay que hacer ahora (eso es la
 * parte de arriba del panel).
 *
 * Casi todo son **cifras sueltas y no gráficos**: un número con su etiqueta se
 * lee en un segundo, y un gráfico de un solo valor es una forma cara de
 * decirlo. Lo único que es comparación —conversaciones por canal— va en barras
 * de un solo color con el número escrito al lado: el color no distingue nada
 * que no diga ya la etiqueta.
 *
 * Tres avisos se dicen en la propia pantalla porque cambian cómo se lee:
 * mediana y p90 en vez de media; conversión sobre la cohorte del periodo; y
 * ventanas móviles en lugar de «hoy».
 */
export function Informe({ api }: Props) {
  const [periodo, setPeriodo] = useState<ClaveDePeriodo>('7d');
  const [d, setD] = useState<InformeDelPeriodo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    api
      .informe(periodo)
      .then((r) => {
        if (vigente) {
          setD(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudo cargar el informe.');
      });
    return () => {
      vigente = false;
    };
  }, [api, periodo]);

  const maxCanal = Math.max(1, ...(d?.conversaciones.porCanal ?? []).map((c) => c.nuevas));
  const conversion =
    d && d.embudo.consultas > 0
      ? Math.round((d.embudo.conReserva / d.embudo.consultas) * 100)
      : null;

  return (
    <section className={estilos.informe} aria-label="Informe del periodo">
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Cómo va</h2>
          <p className={estilos.subtitulo}>Ventana móvil: la misma en cualquier zona horaria.</p>
        </div>
        <div className={estilos.periodos} role="tablist" aria-label="Periodo">
          {PERIODOS.map((p) => (
            <button
              key={p.clave}
              role="tab"
              aria-selected={periodo === p.clave}
              className={`${estilos.periodo} ${periodo === p.clave ? estilos.periodoActivo : ''}`}
              onClick={() => setPeriodo(p.clave)}
            >
              {p.texto}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className={`glass ${estilos.error}`} role="alert">
          {error}
        </p>
      )}

      <div className={estilos.cifras}>
        <article className={`glass ${estilos.cifra}`}>
          <h3 className={estilos.cifraTitulo}>Conversaciones nuevas</h3>
          <p className={estilos.cifraValor}>{d?.conversaciones.nuevas ?? '—'}</p>
          <ul className={estilos.barras}>
            {(d?.conversaciones.porCanal ?? []).map((c) => (
              <li
                key={c.canal}
                className={estilos.barra}
                title={`${CANAL[c.canal] ?? c.canal}: ${c.nuevas}`}
              >
                <span className={estilos.barraNombre}>{CANAL[c.canal] ?? c.canal}</span>
                <span className={estilos.barraPista} aria-hidden="true">
                  <span
                    className={estilos.barraRelleno}
                    ref={(n) => n?.style.setProperty('--parte', `${(c.nuevas / maxCanal) * 100}%`)}
                  />
                </span>
                <span className={estilos.barraCifra}>{c.nuevas}</span>
              </li>
            ))}
            {d && d.conversaciones.porCanal.length === 0 && (
              <li className={estilos.vacio}>Ninguna en este periodo.</li>
            )}
          </ul>
        </article>

        <article className={`glass ${estilos.cifra}`}>
          <h3 className={estilos.cifraTitulo}>Primera respuesta</h3>
          <p className={estilos.cifraValor}>{duracion(d?.respuesta.medianaSegundos ?? null)}</p>
          <p className={estilos.cifraPie}>
            mediana · el 90 % en menos de{' '}
            <strong>{duracion(d?.respuesta.p90Segundos ?? null)}</strong>
          </p>
          {/* Con menos de cinco medidas, mediana y p90 son casi el mismo número y
              no describen nada. Se enseñan igual, pero se dice. */}
          {d && d.respuesta.medidas > 0 && d.respuesta.medidas < POCAS_MEDIDAS && (
            <p className={estilos.poca}>
              Solo{' '}
              {d.respuesta.medidas === 1
                ? 'una conversación medida'
                : `${d.respuesta.medidas} conversaciones medidas`}
              : todavía no es una tendencia.
            </p>
          )}
          <p className={estilos.nota}>
            {d && d.respuesta.medidas >= POCAS_MEDIDAS
              ? `${d.respuesta.medidas} conversaciones medidas. `
              : ''}
            Mediana y no media: una conversación olvidada un fin de semana dispara la media sin
            describir al equipo.
          </p>
        </article>

        <article className={`glass ${estilos.cifra}`}>
          <h3 className={estilos.cifraTitulo}>Reservas</h3>
          <p className={estilos.cifraValor}>{d?.reservas.confirmadas ?? '—'}</p>
          <p className={estilos.cifraPie}>confirmadas en el periodo</p>
          <dl className={estilos.lista}>
            <div>
              <dt>Generadas</dt>
              <dd>{d?.reservas.generadas ?? '—'}</dd>
            </div>
            <div>
              <dt>Canceladas</dt>
              <dd>{d?.reservas.canceladas ?? '—'}</dd>
            </div>
            {(d?.reservas.porMoneda ?? []).map((m) => (
              <div key={m.moneda} className={estilos.dinero}>
                <dt>Confirmado · cobrado</dt>
                <dd>
                  {importe(m.confirmado, m.moneda)} · {importe(m.cobrado, m.moneda)}
                </dd>
              </div>
            ))}
          </dl>
        </article>

        <article className={`glass ${estilos.cifra}`}>
          <h3 className={estilos.cifraTitulo}>Consultas que reservaron</h3>
          <p className={estilos.cifraValor}>{conversion === null ? '—' : `${conversion} %`}</p>
          <p className={estilos.cifraPie}>
            {d
              ? `${d.embudo.conReserva} de las ${d.embudo.consultas} consultas que entraron en el periodo`
              : ' '}
          </p>
          <dl className={estilos.lista}>
            <div>
              <dt>Consultas perdidas</dt>
              <dd>{d?.embudo.perdidas ?? '—'}</dd>
            </div>
            <div>
              <dt>Clientes nuevos</dt>
              <dd>{d?.clientesNuevos ?? '—'}</dd>
            </div>
          </dl>
        </article>
      </div>

      <div className={estilos.rejilla}>
        <article className={`glass ${estilos.bloque}`} aria-label="Estado de atención ahora">
          <h3 className={estilos.cifraTitulo}>Estado de atención, ahora</h3>
          <dl className={estilos.estados}>
            <div className={estilos.estadoNueva}>
              <dt>Nuevas</dt>
              <dd>{d?.conversaciones.atencionAhora.nueva ?? '—'}</dd>
            </div>
            <div className={estilos.estadoPorResponder}>
              <dt>Por responder</dt>
              <dd>{d?.conversaciones.atencionAhora.por_responder ?? '—'}</dd>
            </div>
            <div>
              <dt>Esperando al cliente</dt>
              <dd>{d?.conversaciones.atencionAhora.esperando_cliente ?? '—'}</dd>
            </div>
            <div>
              <dt>Aplazadas</dt>
              <dd>{d?.conversaciones.atencionAhora.seguimiento ?? '—'}</dd>
            </div>
          </dl>
          <p className={estilos.nota}>
            Con la misma regla que la bandeja: estos números son las listas que ve el agente.
          </p>
        </article>

        <article className={`glass ${estilos.bloque}`} aria-label="Por agente">
          <h3 className={estilos.cifraTitulo}>Por agente</h3>
          <table className={estilos.tabla}>
            <thead>
              <tr>
                <th>Agente</th>
                <th className={estilos.num}>Asignadas</th>
                <th className={estilos.num}>Por responder</th>
                <th className={estilos.num}>Respuestas</th>
              </tr>
            </thead>
            <tbody>
              {(d?.agentes ?? []).map((a) => (
                <tr key={a.id}>
                  <td>{a.nombre}</td>
                  <td className={estilos.num}>{a.asignadasAbiertas}</td>
                  <td className={`${estilos.num} ${a.porResponder > 0 ? estilos.pendiente : ''}`}>
                    {a.porResponder}
                  </td>
                  <td className={estilos.num}>{a.respuestasEnviadas}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={estilos.nota}>
            «Respuestas» son mensajes escritos por esa persona en el periodo; los del bot no
            cuentan.
          </p>
        </article>
      </div>
    </section>
  );
}
