import { useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { ResumenDelPanel, Sesion, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Informe } from '../../componentes/panel/Informe.tsx';
import { irA } from '../../estado/ruta.ts';
import estilos from './Panel.module.css';

interface Props {
  sesion: Sesion;
  alSalir: () => void;
}

const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

function duracion(segundos: number | null): string {
  if (segundos === null) return '—';
  if (segundos < 60) return `${segundos} s`;
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/**
 * Panel de control. Lo primero es lo accionable —a quién hay que responder
 * ahora— y solo después el volumen. Cada tarjeta de arriba lleva a la bandeja
 * ya filtrada: un número que no se puede pulsar es un número que no sirve.
 */
export function Panel({ sesion, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [d, setD] = useState<ResumenDelPanel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    const cargar = () =>
      api
        .panel()
        .then(setD)
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : 'No se pudo cargar el panel.'),
        );
    void cargar();
    const id = setInterval(cargar, 30_000);
    return () => clearInterval(id);
  }, [api]);

  const totalHoy = (d?.actividadHoy ?? []).reduce((n, a) => n + a.entrantes + a.salientes, 0);
  const maxCanal = Math.max(1, ...(d?.actividadHoy ?? []).map((a) => a.entrantes + a.salientes));

  return (
    <div className={estilos.pantalla}>
      <Barra api={api} yo={yo} activa="panel" alSalir={alSalir} />
      <main className={estilos.contenido}>
        <header className={estilos.cabecera}>
          <div>
            <h1 className={estilos.titulo}>Hoy</h1>
            <p className={estilos.subtitulo}>Lo que necesita respuesta, antes que lo demás.</p>
          </div>
        </header>

        {error && (
          <p className={`glass ${estilos.error}`} role="alert">
            {error}
          </p>
        )}

        <section className={estilos.atencion} aria-label="Requiere atención">
          <Urgente
            valor={d?.atencion.sinResponder}
            titulo="Sin responder"
            detalle="Esperan a una persona del equipo, aunque haya contestado el bot"
            tono={d && d.atencion.sinResponder > 0 ? 'warn' : 'ok'}
            alPulsar={() =>
              irA({ pantalla: 'bandeja', conversacionId: null, vista: 'sinRespuesta' })
            }
          />
          <Urgente
            valor={d?.atencion.ventanasPorCerrar}
            titulo="Ventanas por cerrar"
            detalle="Menos de 2 h para responder sin plantilla"
            tono={d && d.atencion.ventanasPorCerrar > 0 ? 'danger' : 'ok'}
            alPulsar={() =>
              irA({ pantalla: 'bandeja', conversacionId: null, vista: 'sinRespuesta' })
            }
          />
          <Urgente
            valor={d?.atencion.sinAsignar}
            titulo="Sin asignar"
            detalle="Abiertas y sin nadie que las atienda"
            tono="neutro"
            alPulsar={() => irA({ pantalla: 'bandeja', conversacionId: null })}
          />
        </section>

        <div className={estilos.rejilla}>
          <section className={`glass ${estilos.tarjeta}`} aria-label="Actividad de hoy">
            <h2 className={estilos.tarjetaTitulo}>Actividad de hoy</h2>
            <p className={estilos.granCifra}>{totalHoy.toLocaleString('es')}</p>
            <p className={estilos.granCifraPie}>mensajes, entrantes y salientes</p>
            <ul className={estilos.canales}>
              {(d?.actividadHoy ?? []).map((a) => (
                <li key={a.canal} className={estilos.canal}>
                  <span className={estilos.canalNombre}>
                    <span
                      className={`${estilos.canalPunto} ${estilos[`canal_${a.canal}`] ?? ''}`}
                      aria-hidden="true"
                    />
                    {CANAL[a.canal] ?? a.canal}
                  </span>
                  <span className={estilos.canalBarra} aria-hidden="true">
                    <span
                      className={estilos.canalRelleno}
                      ref={(n) =>
                        n?.style.setProperty(
                          '--parte',
                          `${((a.entrantes + a.salientes) / maxCanal) * 100}%`,
                        )
                      }
                    />
                  </span>
                  <span className={estilos.canalCifra}>
                    {a.entrantes} <span className={estilos.canalFlecha}>↓</span> {a.salientes}{' '}
                    <span className={estilos.canalFlecha}>↑</span>
                  </span>
                </li>
              ))}
              {d && d.actividadHoy.length === 0 && (
                <li className={estilos.vacio}>Todavía no hay mensajes hoy.</li>
              )}
            </ul>
          </section>

          <section className={`glass ${estilos.tarjeta}`} aria-label="Primera respuesta">
            <h2 className={estilos.tarjetaTitulo}>Primera respuesta</h2>
            <p className={estilos.granCifra}>{duracion(d?.respuesta.medianaSegundos ?? null)}</p>
            <p className={estilos.granCifraPie}>
              mediana de los últimos 7 días
              {d ? ` · ${d.respuesta.conversacionesMedidas} conversaciones` : ''}
            </p>
            <p className={estilos.nota}>
              La mediana y no la media: una conversación olvidada un fin de semana dispara la media
              y deja de describir cómo va el equipo.
            </p>
          </section>

          <section className={`glass ${estilos.tarjeta}`} aria-label="Conversaciones">
            <h2 className={estilos.tarjetaTitulo}>Conversaciones</h2>
            <dl className={estilos.lista}>
              <div className={estilos.filaDato}>
                <dt>Abiertas</dt>
                <dd>{d?.conversaciones.abiertas ?? '—'}</dd>
              </div>
              <div className={estilos.filaDato}>
                <dt>Pendientes</dt>
                <dd>{d?.conversaciones.pendientes ?? '—'}</dd>
              </div>
              <div className={estilos.filaDato}>
                <dt>Cerradas hoy</dt>
                <dd>{d?.conversaciones.cerradasHoy ?? '—'}</dd>
              </div>
            </dl>
          </section>

          <section className={`glass ${estilos.tarjeta}`} aria-label="Uso del mes">
            <h2 className={estilos.tarjetaTitulo}>Este mes {d ? `· ${d.periodo}` : ''}</h2>
            <dl className={estilos.lista}>
              <div className={estilos.filaDato}>
                <dt>Recibidos</dt>
                <dd>{(d?.uso['messages.inbound'] ?? 0).toLocaleString('es')}</dd>
              </div>
              <div className={estilos.filaDato}>
                <dt>Entregados</dt>
                <dd>{(d?.uso['messages.outbound'] ?? 0).toLocaleString('es')}</dd>
              </div>
              <div className={estilos.filaDato}>
                <dt>Conversaciones abiertas</dt>
                <dd>{(d?.uso['conversations.opened'] ?? 0).toLocaleString('es')}</dd>
              </div>
            </dl>
            <button
              className={estilos.enlace}
              onClick={() => irA({ pantalla: 'ajustes', seccion: 'uso' })}
            >
              Ver el uso frente al plan
            </button>
          </section>
        </div>

        {/* Lo de arriba es AHORA; esto es el periodo. Van separados porque
            responden preguntas distintas y mezclarlos obligaba a elegir. */}
        <Informe api={api} />
      </main>
    </div>
  );
}

function Urgente({
  valor,
  titulo,
  detalle,
  tono,
  alPulsar,
}: {
  valor: number | undefined;
  titulo: string;
  detalle: string;
  tono: 'ok' | 'warn' | 'danger' | 'neutro';
  alPulsar: () => void;
}) {
  return (
    <button className={`glass ${estilos.urgente} ${estilos[`tono_${tono}`]}`} onClick={alPulsar}>
      <span className={estilos.urgenteCifra}>{valor ?? '—'}</span>
      <span className={estilos.urgenteTitulo}>{titulo}</span>
      <span className={estilos.urgenteDetalle}>{detalle}</span>
    </button>
  );
}
