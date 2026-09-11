import { useCallback, useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { Etiqueta, ResumenDeCliente, Sesion, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { FichaDeCliente } from '../../componentes/clientes/FichaDeCliente.tsx';
import { Importar } from '../../componentes/clientes/Importar.tsx';
import { irA } from '../../estado/ruta.ts';
import { diaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './Clientes.module.css';

interface Props {
  sesion: Sesion;
  clienteId: string | null;
  alSalir: () => void;
}

const ORIGENES = [
  ['', 'Todos los orígenes'],
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
  ['web', 'Web'],
  ['otro', 'Otro'],
] as const;

/**
 * Clientes.
 *
 * Una tabla, no tarjetas: aquí se viene a **encontrar** a alguien y a
 * comparar filas, no a admirar cada registro. Las tarjetas del embudo tienen
 * sentido porque se arrastran; estas no.
 *
 * La búsqueda y los filtros van al servidor. La lista se pagina por cursor,
 * así que filtrar en el navegador escondería justo lo que no se ha traído.
 */
export function Clientes({ sesion, clienteId, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [items, setItems] = useState<ResumenDeCliente[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [origen, setOrigen] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [importando, setImportando] = useState(false);
  const [creando, setCreando] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filtros = useMemo(
    () => ({
      ...(busqueda.trim() ? { q: busqueda.trim() } : {}),
      ...(origen ? { origen } : {}),
      ...(etiqueta ? { etiqueta } : {}),
    }),
    [busqueda, origen, etiqueta],
  );

  const cargar = useCallback(async () => {
    try {
      const pagina = await api.clientes(filtros);
      setItems(pagina.items);
      setCursor(pagina.siguienteCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los clientes.');
    } finally {
      setCargando(false);
    }
  }, [api, filtros]);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    api
      .etiquetas()
      .then(setEtiquetas)
      .catch(() => undefined);
  }, [api]);

  // Espera a que se deje de escribir: una consulta por tecla no aporta nada.
  useEffect(() => {
    const t = setTimeout(() => void cargar(), busqueda ? 250 : 0);
    return () => clearTimeout(t);
  }, [cargar, busqueda]);

  async function masResultados() {
    if (!cursor) return;
    try {
      const pagina = await api.clientes({ ...filtros, cursor });
      setItems((previos) => [...previos, ...pagina.items]);
      setCursor(pagina.siguienteCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo traer más.');
    }
  }

  async function exportar() {
    try {
      const { csv, nombreDeArchivo } = await api.exportarClientes(filtros);
      // El archivo se arma aquí porque la descarga necesita la cabecera de
      // sesión, y un enlace del navegador no la lleva.
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreDeArchivo;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo exportar.');
    }
  }

  async function crear() {
    setCreando(true);
    try {
      const { id } = await api.crearCliente({ nombre: 'Cliente nuevo' });
      await cargar();
      irA({ pantalla: 'clientes', clienteId: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear.');
    } finally {
      setCreando(false);
    }
  }

  const puedeBorrar = yo?.rol === 'owner' || yo?.rol === 'admin';

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="clientes" alSalir={alSalir} />

      <main className={estilos.centro}>
        <header className={`glass ${estilos.barra}`}>
          <h1 className={estilos.titulo}>Clientes</h1>

          <input
            className={estilos.buscar}
            type="search"
            placeholder="Buscar por nombre, teléfono, correo o ciudad…"
            aria-label="Buscar clientes"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />

          <select
            className={estilos.filtro}
            value={origen}
            aria-label="Filtrar por origen"
            onChange={(e) => setOrigen(e.target.value)}
          >
            {ORIGENES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>

          <select
            className={estilos.filtro}
            value={etiqueta}
            aria-label="Filtrar por etiqueta"
            onChange={(e) => setEtiqueta(e.target.value)}
          >
            <option value="">Todas las etiquetas</option>
            {etiquetas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>

          <button className={estilos.accion} onClick={() => setImportando(true)}>
            Importar
          </button>
          <button className={estilos.accion} onClick={() => void exportar()}>
            Exportar
          </button>
          <button className={estilos.primario} disabled={creando} onClick={() => void crear()}>
            Nuevo cliente
          </button>
        </header>

        {error && <p className={estilos.error}>{error}</p>}

        {importando && (
          <Importar api={api} alCerrar={() => setImportando(false)} alTerminar={cargar} />
        )}

        <div className={estilos.cuerpo}>
          <div className={`glass ${estilos.tabla}`}>
            {cargando && <p className={estilos.vacio}>Cargando…</p>}
            {!cargando && items.length === 0 && (
              <p className={estilos.vacio}>
                No hay clientes con esos filtros. Los que escriben por WhatsApp entran solos.
              </p>
            )}
            {items.length > 0 && (
              <table className={estilos.rejilla}>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Teléfono</th>
                    <th>Ciudad</th>
                    <th>Origen</th>
                    <th>Etiquetas</th>
                    <th>Última actividad</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr
                      key={c.id}
                      className={c.id === clienteId ? estilos.elegida : ''}
                      onClick={() => irA({ pantalla: 'clientes', clienteId: c.id })}
                    >
                      <td>
                        <button className={estilos.abrir}>{c.nombre ?? 'Sin nombre'}</button>
                      </td>
                      <td className={estilos.numero}>{c.telefono ?? '—'}</td>
                      <td>{c.ciudad ?? '—'}</td>
                      <td className={estilos.origen}>{c.origen}</td>
                      <td>
                        <span className={estilos.etiquetas}>
                          {c.etiquetas.map((e) => (
                            <span
                              key={e.id}
                              className={estilos.etiqueta}
                              ref={(n) =>
                                n?.style.setProperty('--color-etiqueta', e.color ?? '#8E8E93')
                              }
                            >
                              {e.nombre}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className={estilos.fecha}>
                        {c.ultimaActividad ? diaDeMensaje(c.ultimaActividad) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {cursor && (
              <button className={estilos.mas} onClick={() => void masResultados()}>
                Ver más
              </button>
            )}
          </div>

          {clienteId && (
            <FichaDeCliente
              api={api}
              clienteId={clienteId}
              etiquetas={etiquetas}
              puedeBorrar={puedeBorrar}
              alCerrar={() => irA({ pantalla: 'clientes', clienteId: null })}
              alCambiar={cargar}
            />
          )}
        </div>
      </main>
    </div>
  );
}
