import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EquipoDeLaCuenta } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './Equipos.module.css';

/**
 * Equipos: Recepción, Reservas, Mantenimiento.
 *
 * ## Qué desbloquea
 *
 * El modo «por equipos» de la visibilidad (ADR-008). En PR-96 no se pudo
 * ofrecer porque sin equipos se comportaba como «solo las mías»: una opción
 * que no hace lo que dice. Esto es lo que la hace real.
 *
 * Las tablas llevaban desde la migración 0002 sin que las escribiera nadie.
 * No era un olvido de una tarde: llevaban ahí desde el principio.
 *
 * ## Por qué el contador de abiertas va en cada equipo
 *
 * Es lo único que distingue un equipo vivo de uno que alguien creó y dejó.
 * Sin él, la pantalla es una lista de nombres y no dice nada sobre el trabajo.
 *
 * ## Por qué borrar no asusta
 *
 * Las conversaciones que llevaba **no se cierran ni se pierden**: quedan sin
 * equipo, y las vuelve a ver todo el mundo. Perder trabajo en curso por
 * reorganizar el organigrama sería el peor cambio posible, y se dice en la
 * propia pantalla para que nadie tenga que averiguarlo.
 */

interface Props {
  api: Api;
  /** Solo propietario o admin monta el organigrama; el resto lo mira. */
  gestor: boolean;
  /** Las personas de la cuenta, para poder meterlas en un equipo. */
  personas: { userId: string; nombre: string; rol: string }[];
}

const NOMBRE_DE_ROL: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  supervisor: 'Supervisor',
  agent: 'Agente',
};

export function Equipos({ api, gestor, personas }: Props) {
  const [equipos, setEquipos] = useState<EquipoDeLaCuenta[] | null>(null);
  const [nombre, setNombre] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setEquipos(await api.equipos());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudieron cargar los equipos.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function hacer(accion: () => Promise<EquipoDeLaCuenta[]>) {
    setOcupado(true);
    setError(null);
    try {
      setEquipos(await accion());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo.');
    } finally {
      setOcupado(false);
    }
  }

  async function crear(e: FormEvent) {
    e.preventDefault();
    const limpio = nombre.trim();
    if (!limpio) return;
    await hacer(() => api.crearEquipo(limpio));
    setNombre('');
  }

  async function renombrar(eq: EquipoDeLaCuenta) {
    const nuevo = prompt('Nuevo nombre del equipo', eq.nombre);
    if (nuevo === null || nuevo.trim() === eq.nombre) return;
    await hacer(() => api.renombrarEquipo(eq.id, nuevo));
  }

  async function borrar(eq: EquipoDeLaCuenta) {
    // Se avisa de lo que pasa con el trabajo en curso, que es lo que se teme
    // al borrar algo que lleva conversaciones.
    const aviso =
      eq.abiertas > 0
        ? `«${eq.nombre}» lleva ${eq.abiertas} ${eq.abiertas === 1 ? 'conversación abierta' : 'conversaciones abiertas'}. No se cierran: quedan sin equipo y las ve todo el mundo. ¿Borrar el equipo?`
        : `¿Borrar el equipo «${eq.nombre}»?`;
    if (!confirm(aviso)) return;
    await hacer(() => api.borrarEquipo(eq.id));
  }

  return (
    <>
      <h3 className={compartidos.tarjetaTitulo}>Equipos</h3>
      <p className={compartidos.descripcion}>
        Recepción, Reservas, Mantenimiento. Sirven para derivar una conversación sin asignársela a
        nadie en concreto, y para que cada agente vea solo lo de los suyos si así lo decides en{' '}
        <strong>Reparto</strong>.
      </p>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {equipos?.length === 0 && (
        <p className={compartidos.vacio}>
          Todavía no hay equipos. Sin al menos uno, la bandeja no puede repartirse por equipos.
        </p>
      )}

      <ul className={estilos.lista}>
        {(equipos ?? []).map((eq) => (
          <li key={eq.id} className={estilos.equipo}>
            <div className={estilos.fila}>
              <button
                className={estilos.nombre}
                aria-expanded={abierto === eq.id}
                onClick={() => setAbierto(abierto === eq.id ? null : eq.id)}
              >
                {eq.nombre}
                <span className={estilos.cuantos}>
                  {eq.miembros.length} {eq.miembros.length === 1 ? 'persona' : 'personas'}
                </span>
              </button>
              {/* Lo que distingue un equipo vivo de uno que alguien dejó. */}
              <span className={eq.abiertas > 0 ? estilos.abiertas : estilos.menor}>
                {eq.abiertas} {eq.abiertas === 1 ? 'abierta' : 'abiertas'}
              </span>
              {gestor && (
                <span className={estilos.acciones}>
                  <button
                    className={compartidos.secundario}
                    disabled={ocupado}
                    onClick={() => void renombrar(eq)}
                  >
                    Renombrar
                  </button>
                  <button
                    className={compartidos.peligro}
                    disabled={ocupado}
                    onClick={() => void borrar(eq)}
                    aria-label={`Borrar el equipo ${eq.nombre}`}
                  >
                    Borrar
                  </button>
                </span>
              )}
            </div>

            {abierto === eq.id && (
              <ul className={estilos.personas}>
                {personas.map((p) => {
                  const dentro = eq.miembros.some((m) => m.userId === p.userId);
                  return (
                    <li key={p.userId}>
                      <label className={estilos.persona}>
                        <input
                          type="checkbox"
                          checked={dentro}
                          disabled={!gestor || ocupado}
                          onChange={(e) =>
                            void hacer(() =>
                              api.cambiarMiembroDeEquipo(eq.id, p.userId, e.target.checked),
                            )
                          }
                        />
                        <span>
                          {p.nombre}
                          <span className={estilos.menor}> · {NOMBRE_DE_ROL[p.rol] ?? p.rol}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
                {/* Una persona puede estar en varios: en un hotel pequeño,
                    quien atiende recepción lleva también las reservas. */}
                {personas.length === 0 && (
                  <li className={estilos.menor}>Invita a alguien antes de formar equipos.</li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {gestor && (
        <form className={estilos.nuevo} onSubmit={crear}>
          <label className={estilos.campoNuevo}>
            <span className="visually-hidden">Nombre del equipo nuevo</span>
            <input
              value={nombre}
              maxLength={60}
              disabled={ocupado}
              placeholder="Recepción"
              onChange={(e) => setNombre(e.target.value)}
            />
          </label>
          <button className={compartidos.primario} disabled={ocupado || !nombre.trim()}>
            Crear equipo
          </button>
        </form>
      )}
    </>
  );
}
