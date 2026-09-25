import { useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ConfiguracionDeReparto, EquipoDeLaCuenta } from '../../api/tipos.ts';
import compartidos from './ajustes.module.css';
import estilos from './Reparto.module.css';

interface Props {
  api: Api;
  /** Propietario o administrador: el reparto afecta a todo el equipo. */
  administra: boolean;
}

const ROL: Record<string, string> = {
  owner: 'Propietario',
  admin: 'Administrador',
  supervisor: 'Supervisor',
  agent: 'Agente',
};

/**
 * Ajustes → Reparto. Encendido, cada conversación nueva se asigna sola al
 * miembro con menos conversaciones abiertas, entre quienes están marcados.
 * Una conversación que vuelve conserva a quien la atendió.
 *
 * ## Por qué la visibilidad vive aquí (PR-96)
 *
 * Es la misma pregunta —quién trabaja qué conversación— vista por el otro
 * lado: el reparto dice a quién le TOCA, y la visibilidad qué puede VER.
 * Separarlas en dos pantallas obligaría a cruzarlas de cabeza.
 *
 * La regla llevaba desde 0010 aplicándose de verdad en la bandeja y en el
 * embudo, y **no había dónde cambiarla**: se hacía con un PATCH a mano. Lo
 * encontró la guarda de rutas sin pantalla de PR-94.
 */
export function Reparto({ api, administra }: Props) {
  const [config, setConfig] = useState<ConfiguracionDeReparto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    api
      .reparto()
      .then(setConfig)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'No se pudo cargar el reparto.'),
      );
  }, [api]);

  async function guardar(cambios: Parameters<Api['guardarReparto']>[0]) {
    setOcupado(true);
    setError(null);
    try {
      setConfig(await api.guardarReparto(cambios));
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  async function guardarVisibilidad(modo: 'all' | 'team' | 'assigned') {
    setOcupado(true);
    setError(null);
    try {
      setConfig(await api.guardarVisibilidad(modo));
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  const encendido = config?.modo === 'least_busy';
  const enReparto = config?.miembros.filter((m) => m.recibe).length ?? 0;

  return (
    <section className={compartidos.seccion}>
      <header className={compartidos.cabecera}>
        <div>
          <h2 className={compartidos.titulo}>Reparto de conversaciones</h2>
          <p className={compartidos.descripcion}>
            Encendido, cada conversación nueva se asigna sola a la persona con menos conversaciones
            abiertas. Si alguien vuelve a escribir, sigue con quien lo atendió.
          </p>
        </div>
        {config && administra && (
          <button
            type="button"
            className={encendido ? compartidos.secundario : compartidos.primario}
            disabled={ocupado}
            onClick={() => void guardar({ modo: encendido ? 'off' : 'least_busy' })}
          >
            {encendido ? 'Apagar reparto' : 'Encender reparto'}
          </button>
        )}
      </header>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {config && (
        <p
          className={`${compartidos.aviso} ${encendido ? compartidos.aviso_ok : compartidos.aviso_info}`}
          role="status"
        >
          {encendido
            ? enReparto === 0
              ? 'Encendido, pero nadie está marcado para recibir: las conversaciones quedarán sin asignar.'
              : `Encendido: reparte entre ${enReparto} ${enReparto === 1 ? 'persona' : 'personas'}.`
            : 'Apagado: las conversaciones nuevas quedan sin asignar hasta que alguien las tome.'}
        </p>
      )}

      {config && (
        <Visibilidad
          api={api}
          config={config}
          administra={administra}
          ocupado={ocupado}
          alCambiar={guardarVisibilidad}
        />
      )}

      <h3 className={compartidos.tarjetaTitulo}>Quién entra en el reparto</h3>
      <ul className={estilos.lista}>
        {config?.miembros.map((m) => (
          <li key={m.userId} className={estilos.miembro}>
            <label className={estilos.marca}>
              <input
                type="checkbox"
                checked={m.recibe}
                disabled={!administra || ocupado}
                onChange={(e) =>
                  void guardar({ miembros: [{ userId: m.userId, recibe: e.target.checked }] })
                }
              />
              <span className={estilos.quien}>
                <span className={estilos.nombre}>{m.nombre}</span>
                <span className={estilos.detalle}>
                  {ROL[m.rol] ?? m.rol} · {m.email}
                </span>
              </span>
            </label>
            <span className={estilos.abiertas}>
              {m.abiertas} {m.abiertas === 1 ? 'abierta' : 'abiertas'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Qué conversaciones ve un agente de las de los demás (ADR-008).
 *
 * ## Por qué solo dos opciones y no las tres de la base
 *
 * ## Por qué «por equipos» solo aparece cuando hay equipos
 *
 * En PR-96 esta opción no existía: `teams` llevaba desde la fase 0 sin que
 * nadie la escribiera, y con cero equipos el modo se comportaba como «solo
 * las mías» —una opción que no hace lo que dice—. PR-97 la hizo real.
 *
 * Sigue sin ofrecerse cuando la cuenta **no tiene ningún equipo**, por la
 * misma razón: elegirla ahí no cambiaría nada y parecería que sí. En su
 * lugar se dice dónde se crean.
 */
function Visibilidad({
  api,
  config,
  administra,
  ocupado,
  alCambiar,
}: {
  api: Api;
  config: ConfiguracionDeReparto;
  administra: boolean;
  ocupado: boolean;
  alCambiar: (modo: 'all' | 'team' | 'assigned') => Promise<void>;
}) {
  const [equipos, setEquipos] = useState<EquipoDeLaCuenta[]>([]);
  useEffect(() => {
    api
      .equipos()
      .then(setEquipos)
      .catch(() => undefined);
  }, [api]);

  const OPCIONES: { valor: 'all' | 'team' | 'assigned'; titulo: string; explica: string }[] = [
    {
      valor: 'all',
      titulo: 'Toda la bandeja',
      explica:
        'Cualquiera del equipo ve y responde cualquier conversación. Es lo que hace falta en una recepción donde se cubren entre todos.',
    },
    {
      valor: 'assigned',
      titulo: 'Solo las suyas',
      explica:
        'Un agente ve únicamente las que tiene asignadas. Las sin asignar también, para que una consulta nueva no se quede sin atender.',
    },
  ];

  // «Por equipos» solo si hay equipos: sin ellos se comporta igual que «solo
  // las suyas», y ofrecerla sería prometer algo que no pasa.
  if (equipos.length > 0) {
    OPCIONES.splice(1, 0, {
      valor: 'team',
      titulo: 'Las de sus equipos',
      explica:
        'Un agente ve las de los equipos a los que pertenece, las suyas y las sin asignar. Recepción no ve lo de Mantenimiento.',
    });
  }

  return (
    <>
      <h3 className={compartidos.tarjetaTitulo}>Qué ve cada agente</h3>
      <p className={compartidos.descripcion}>
        Solo afecta al rol <strong>Agente</strong>. Propietario, administrador y supervisor ven
        siempre toda la bandeja: su trabajo es ver lo que los demás no atienden.
      </p>

      {config.visibilidad === 'team' && equipos.length === 0 && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_info}`} role="status">
          Esta cuenta está en <strong>por equipos</strong> y no tiene ninguno, así que en la
          práctica cada agente ve las suyas y las sin asignar. Crea equipos en{' '}
          <strong>Ajustes → Equipo</strong>, o elige otra opción aquí.
        </p>
      )}

      <div className={estilos.opciones}>
        {OPCIONES.map((o) => (
          <label key={o.valor} className={estilos.opcion}>
            <input
              type="radio"
              name="visibilidad"
              checked={config.visibilidad === o.valor}
              disabled={!administra || ocupado}
              onChange={() => void alCambiar(o.valor)}
            />
            <span className={estilos.quien}>
              <span className={estilos.nombre}>{o.titulo}</span>
              <span className={estilos.detalle}>{o.explica}</span>
            </span>
          </label>
        ))}
      </div>
    </>
  );
}
