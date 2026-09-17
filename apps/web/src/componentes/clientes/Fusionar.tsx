import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { DuplicadoDeCliente, ResumenDeCliente } from '../../api/tipos.ts';
import estilos from './Fusionar.module.css';

/**
 * Unir dos fichas del mismo huésped.
 *
 * Es la operación más cara de equivocarse de toda la pantalla: si se unen dos
 * personas distintas, quien atienda leerá la conversación de otra. Por eso:
 *
 * - **se pide confirmación con los dos nombres delante**, no un «¿seguro?»;
 * - **se dice qué se va a mover** antes de hacerlo;
 * - **se recuerda que se puede deshacer**, que es lo que permite decidir sin
 *   miedo y sin llamar a nadie.
 *
 * Las sugerencias son por nombre y llegan del servidor. Buscar a mano también
 * vale: hay huéspedes duplicados que ningún parecido detecta —dos números y
 * dos nombres escritos distinto— y esos solo los conoce quien atiende.
 */

interface Props {
  api: Api;
  /** La ficha abierta: es la que SOBREVIVE. */
  destinoId: string;
  nombreDestino: string | null;
  alHecho: () => void | Promise<void>;
  alCerrar: () => void;
}

export function Fusionar({ api, destinoId, nombreDestino, alHecho, alCerrar }: Props) {
  const [sugerencias, setSugerencias] = useState<DuplicadoDeCliente[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [encontrados, setEncontrados] = useState<ResumenDeCliente[]>([]);
  const [elegido, setElegido] = useState<{ id: string; nombre: string | null } | null>(null);
  const [motivo, setMotivo] = useState('duplicado');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    api
      .duplicadosDeCliente(destinoId)
      .then((d) => vivo && setSugerencias(d))
      .catch(() => vivo && setSugerencias([]));
    return () => {
      vivo = false;
    };
  }, [api, destinoId]);

  const buscar = useCallback(
    async (texto: string) => {
      setBusqueda(texto);
      if (texto.trim().length < 2) {
        setEncontrados([]);
        return;
      }
      try {
        const p = await api.clientes({ q: texto.trim() });
        // Nunca se ofrece la propia ficha: fusionarse consigo mismo no existe.
        setEncontrados(p.items.filter((c) => c.id !== destinoId).slice(0, 8));
      } catch {
        setEncontrados([]);
      }
    },
    [api, destinoId],
  );

  async function fusionar() {
    if (!elegido) return;
    setOcupado(true);
    setError(null);
    try {
      await api.fusionarClientes(destinoId, elegido.id, motivo.trim() || 'duplicado');
      await alHecho();
      alCerrar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo unir las fichas.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className={estilos.panel}>
      <h3 className={estilos.titulo}>Unir con otra ficha</h3>
      <p className={estilos.ayuda}>
        La ficha que estás viendo <strong>{nombreDestino ?? 'sin nombre'}</strong> se queda, y la
        otra se vacía en ella: sus conversaciones, sus canales y sus reservas pasan aquí.
      </p>

      {sugerencias.length > 0 && (
        <div className={estilos.grupo}>
          <p className={estilos.etiqueta}>Puede que sean la misma persona</p>
          {sugerencias.map((s) => (
            <button
              key={s.id}
              className={`${estilos.opcion} ${elegido?.id === s.id ? estilos.elegida : ''}`}
              onClick={() => setElegido({ id: s.id, nombre: s.nombre })}
            >
              <span>{s.nombre ?? 'Sin nombre'}</span>
              <span className={estilos.porque}>{s.porque}</span>
            </button>
          ))}
        </div>
      )}

      <div className={estilos.grupo}>
        <label className={estilos.etiqueta} htmlFor="buscar-fusion">
          O busca la otra ficha
        </label>
        <input
          id="buscar-fusion"
          className={estilos.buscar}
          value={busqueda}
          placeholder="Nombre, teléfono o correo"
          onChange={(e) => void buscar(e.target.value)}
        />
        {encontrados.map((c) => (
          <button
            key={c.id}
            className={`${estilos.opcion} ${elegido?.id === c.id ? estilos.elegida : ''}`}
            onClick={() => setElegido({ id: c.id, nombre: c.nombre })}
          >
            <span>{c.nombre ?? 'Sin nombre'}</span>
            <span className={estilos.porque}>{c.telefono ?? c.email ?? ''}</span>
          </button>
        ))}
      </div>

      {elegido && (
        <div className={estilos.confirmar}>
          <p>
            Se unirá <strong>{elegido.nombre ?? 'Sin nombre'}</strong> dentro de{' '}
            <strong>{nombreDestino ?? 'esta ficha'}</strong>.
          </p>
          <label className={estilos.etiqueta} htmlFor="motivo-fusion">
            Por qué (lo leerá quien mire esta ficha dentro de seis meses)
          </label>
          <input
            id="motivo-fusion"
            className={estilos.buscar}
            value={motivo}
            maxLength={200}
            onChange={(e) => setMotivo(e.target.value)}
          />
          <p className={estilos.reversible}>Se puede deshacer después.</p>
          <div className={estilos.acciones}>
            <button className={estilos.cancelar} onClick={alCerrar} disabled={ocupado}>
              Cancelar
            </button>
            <button className={estilos.unir} onClick={() => void fusionar()} disabled={ocupado}>
              {ocupado ? 'Uniendo…' : 'Unir las dos fichas'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
