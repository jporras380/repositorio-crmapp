import { useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { ConfiguracionDeReparto } from '../../api/tipos.ts';
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
