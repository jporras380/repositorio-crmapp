import { useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { HorarioDeAtencion, TramoDeHorario } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './Horario.module.css';

interface Props {
  api: Api;
  administra: boolean;
}

const DIAS: [string, string][] = [
  ['1', 'Lunes'],
  ['2', 'Martes'],
  ['3', 'Miércoles'],
  ['4', 'Jueves'],
  ['5', 'Viernes'],
  ['6', 'Sábado'],
  ['7', 'Domingo'],
];

/** Zonas frecuentes primero; la lista completa la da el navegador. */
const ZONAS = (() => {
  const soportadas =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const frecuentes = ['America/Lima', 'America/Bogota', 'America/Mexico_City', 'Europe/Madrid'];
  return [...frecuentes, ...soportadas.filter((z) => !frecuentes.includes(z))];
})();

const TRAMO_POR_DEFECTO: TramoDeHorario = ['09:00', '18:00'];

/**
 * Ajustes → Horario. Dice cuándo atiende el hotel y, si se quiere, responde
 * solo fuera de ese horario para que nadie se quede esperando de madrugada.
 * Es lo ÚNICO que el CRM envía por su cuenta sin bot ni agente, así que viene
 * apagado y con el texto en manos del hotel.
 */
export function Horario({ api, administra }: Props) {
  const [datos, setDatos] = useState<HorarioDeAtencion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    api
      .horario()
      .then(setDatos)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'No se pudo cargar el horario.'),
      );
  }, [api]);

  async function guardar(
    cambios: Parameters<Api['guardarHorario']>[0],
    hecho = 'Horario guardado.',
  ) {
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      setDatos(await api.guardarHorario(cambios));
      setAviso(hecho);
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  if (!datos) {
    return (
      <section className={compartidos.seccion}>
        <h2 className={compartidos.titulo}>Horario de atención</h2>
        {error && (
          <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  const cambiarDia = (dia: string, tramos: TramoDeHorario[]) => {
    const horario = { ...datos.horario };
    if (tramos.length === 0) delete horario[dia];
    else horario[dia] = tramos;
    setDatos({ ...datos, horario });
  };

  return (
    <section className={compartidos.seccion}>
      <header className={compartidos.cabecera}>
        <div>
          <h2 className={compartidos.titulo}>Horario de atención</h2>
          <p className={compartidos.descripcion}>
            En qué horas atiende el equipo, en la hora del hotel. Sirve para responder solo a quien
            escribe fuera de ese horario; no cierra nada ni impide contestar.
          </p>
        </div>
        {administra && (
          <button
            className={compartidos.primario}
            disabled={guardando}
            onClick={() => void guardar({ horario: datos.horario, zonaHoraria: datos.zonaHoraria })}
          >
            {guardando ? 'Guardando…' : 'Guardar horario'}
          </button>
        )}
      </header>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      {aviso && <p className={`${compartidos.aviso} ${compartidos.aviso_ok}`}>{aviso}</p>}

      <label className={compartidos.campo}>
        <span>Zona horaria del hotel</span>
        <select
          value={datos.zonaHoraria}
          disabled={!administra}
          onChange={(e) => setDatos({ ...datos, zonaHoraria: e.target.value })}
        >
          {ZONAS.map((z) => (
            <option key={z} value={z}>
              {z.replace('_', ' ')}
            </option>
          ))}
        </select>
        <span className={compartidos.ayuda}>
          Las horas de abajo son de aquí, no del servidor ni del navegador.
        </span>
      </label>

      <ul className={estilos.dias}>
        {DIAS.map(([dia, nombre]) => {
          const tramos = datos.horario[dia] ?? [];
          const abierto = tramos.length > 0;
          return (
            <li key={dia} className={estilos.dia}>
              <label className={estilos.interruptor}>
                <input
                  type="checkbox"
                  checked={abierto}
                  disabled={!administra}
                  onChange={(e) => cambiarDia(dia, e.target.checked ? [TRAMO_POR_DEFECTO] : [])}
                />
                <span className={estilos.nombre}>{nombre}</span>
              </label>
              {abierto ? (
                <div className={estilos.tramos}>
                  {tramos.map((t, i) => (
                    <div key={i} className={estilos.tramo}>
                      <input
                        type="time"
                        value={t[0]}
                        disabled={!administra}
                        aria-label={`${nombre}: abre`}
                        onChange={(e) =>
                          cambiarDia(
                            dia,
                            tramos.map((x, j) => (j === i ? [e.target.value, x[1]] : x)),
                          )
                        }
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        value={t[1]}
                        disabled={!administra}
                        aria-label={`${nombre}: cierra`}
                        onChange={(e) =>
                          cambiarDia(
                            dia,
                            tramos.map((x, j) => (j === i ? [x[0], e.target.value] : x)),
                          )
                        }
                      />
                      {administra && tramos.length > 1 && (
                        <button
                          type="button"
                          className={estilos.quitar}
                          onClick={() =>
                            cambiarDia(
                              dia,
                              tramos.filter((_, j) => j !== i),
                            )
                          }
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                  ))}
                  {/* Un hotel cierra a mediodía: dos tramos en el mismo día. */}
                  {administra && tramos.length < 4 && (
                    <button
                      type="button"
                      className={estilos.anadir}
                      onClick={() => cambiarDia(dia, [...tramos, ['15:00', '20:00']])}
                    >
                      + tramo
                    </button>
                  )}
                </div>
              ) : (
                <span className={estilos.cerrado}>Cerrado</span>
              )}
            </li>
          );
        })}
      </ul>

      <section className={estilos.avisoFuera}>
        <h3 className={compartidos.titulo}>Respuesta fuera de horario</h3>
        <p className={compartidos.descripcion}>
          Si está encendida, a quien escriba fuera del horario se le responde una vez con este texto
          (como mucho una cada seis horas). Es lo único que el CRM envía sin que lo pulses.
        </p>
        <label className={compartidos.campo}>
          <span>Mensaje</span>
          <textarea
            rows={3}
            maxLength={1000}
            disabled={!administra}
            placeholder="Gracias por escribir al Apart Hotel El Paraíso. Ahora estamos cerrados; te respondemos apenas abramos."
            value={datos.avisoTexto}
            onChange={(e) => setDatos({ ...datos, avisoTexto: e.target.value })}
          />
        </label>
        {administra && (
          <div className={compartidos.formularioAcciones}>
            <button
              className={compartidos.secundario}
              disabled={guardando || (!datos.avisoActivo && !datos.avisoTexto.trim())}
              onClick={() =>
                void guardar(
                  { avisoActivo: !datos.avisoActivo, avisoTexto: datos.avisoTexto },
                  datos.avisoActivo
                    ? 'Respuesta automática apagada.'
                    : 'Respuesta automática encendida.',
                )
              }
            >
              {datos.avisoActivo ? 'Apagar respuesta' : 'Encender respuesta'}
            </button>
            <button
              className={compartidos.primario}
              disabled={guardando}
              onClick={() => void guardar({ avisoTexto: datos.avisoTexto }, 'Mensaje guardado.')}
            >
              Guardar mensaje
            </button>
          </div>
        )}
        <p
          className={`${compartidos.aviso} ${datos.avisoActivo ? compartidos.aviso_ok : compartidos.aviso_info}`}
          role="status"
        >
          {datos.avisoActivo
            ? 'Encendida: se responde fuera del horario de arriba.'
            : 'Apagada: fuera de horario no se envía nada.'}
        </p>
      </section>
    </section>
  );
}
