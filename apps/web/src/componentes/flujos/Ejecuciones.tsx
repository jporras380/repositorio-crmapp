import { useCallback, useEffect, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EjecucionDeFlujo } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { hace } from '../../vista/tiempo.ts';
import estilos from './Ejecuciones.module.css';

/**
 * Qué está haciendo este bot ahora mismo, y qué hizo la última vez.
 *
 * ## Por qué hacía falta
 *
 * Hasta ahora, un bot que se portaba mal era una caja negra: la lista de bots
 * decía «3 en curso» y ahí se acababa la información. Si un cliente se
 * quejaba de que el bot le contestó algo raro, la única salida era leer la
 * conversación y adivinar qué rama tomó.
 *
 * El registro paso a paso ya se guardaba desde la migración 0015 —«por qué el
 * bot dijo lo que dijo»—, y la API para leerlo existía. **Lo que faltaba era
 * la pantalla**: el método del cliente web llevaba meses sin que lo llamara
 * nadie, y estaba anotado como deuda en la guarda de «declarado y sin usar».
 *
 * ## Por qué se actualiza a mano y no solo
 *
 * Esto es un banco de trabajo, no un panel de control: se abre cuando se está
 * investigando algo concreto. Un sondeo cada pocos segundos gastaría batería y
 * consultas para una pantalla que la mayor parte del tiempo nadie mira.
 */

interface Props {
  api: Api;
  flujoId: string;
}

/** En el idioma de quien lo lee, no en el de la columna. */
const ESTADO: Record<string, string> = {
  running: 'Ejecutándose',
  waiting: 'Esperando respuesta',
  done: 'Terminada',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

export function Ejecuciones({ api, flujoId }: Props) {
  const [ejecuciones, setEjecuciones] = useState<EjecucionDeFlujo[] | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setEjecuciones(await api.ejecucionesDeFlujo(flujoId));
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudieron cargar las ejecuciones.');
    } finally {
      setCargando(false);
    }
  }, [api, flujoId]);
  useEffect(() => void cargar(), [cargar]);

  const vivas = (ejecuciones ?? []).filter(
    (e) => e.estado === 'running' || e.estado === 'waiting',
  ).length;

  return (
    <section className={estilos.panel}>
      <header className={estilos.cabecera}>
        <h3 className={estilos.titulo}>
          Ejecuciones
          {/* Cuántas están vivas ahora: es la pregunta con la que se abre
              esto, y contarlas a ojo en una lista de veinte no es contarlas. */}
          {vivas > 0 && <span className={estilos.vivas}>{vivas} en curso</span>}
        </h3>
        <button className={estilos.actualizar} onClick={() => void cargar()} disabled={cargando}>
          {cargando ? 'Cargando…' : 'Actualizar'}
        </button>
      </header>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      {ejecuciones?.length === 0 && (
        <p className={estilos.vacio}>Este bot todavía no ha atendido ninguna conversación.</p>
      )}

      <ul className={estilos.lista}>
        {(ejecuciones ?? []).map((e) => (
          <li key={e.id} className={estilos.ejecucion}>
            <button
              className={estilos.fila}
              aria-expanded={abierta === e.id}
              onClick={() => setAbierta(abierta === e.id ? null : e.id)}
            >
              <span className={`${estilos.estado} ${estilos[`estado_${e.estado}`] ?? ''}`}>
                {ESTADO[e.estado] ?? e.estado}
              </span>
              <span className={estilos.cuando}>
                {hace(e.iniciadaEn) ?? 'ahora'}
                {e.nodoActual && !e.terminadaEn ? ` · en «${e.nodoActual}»` : ''}
              </span>
              <span className={estilos.pasosCuenta}>
                {e.pasos.length} {e.pasos.length === 1 ? 'paso' : 'pasos'}
              </span>
            </button>

            {/* El error va SIEMPRE visible, sin desplegar: es lo único de esta
                lista sobre lo que hay que hacer algo. */}
            {e.error && <p className={estilos.fallo}>{e.error}</p>}

            {abierta === e.id && (
              <div className={estilos.detalle}>
                <ol className={estilos.pasos}>
                  {e.pasos.map((p, i) => (
                    <li key={i} className={p.error ? estilos.pasoFallido : undefined}>
                      <span className={estilos.pasoNodo}>{p.nodoId}</span>
                      <span className={estilos.pasoTipo}>{p.tipo}</span>
                      <span className={estilos.pasoHora}>{hace(p.en) ?? 'ahora'}</span>
                      {p.error && <span className={estilos.pasoError}>{p.error}</span>}
                    </li>
                  ))}
                  {e.pasos.length === 0 && (
                    <li className={estilos.vacio}>Arrancó y todavía no dio ningún paso.</li>
                  )}
                </ol>

                {/* Desde el paso que falló a la conversación de verdad: sin
                    esto, hay que buscarla a mano por el identificador. */}
                <button
                  className={estilos.irAConversacion}
                  onClick={() => irA({ pantalla: 'bandeja', conversacionId: e.conversacionId })}
                >
                  Ver la conversación
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
