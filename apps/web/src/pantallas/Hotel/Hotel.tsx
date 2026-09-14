import { useCallback, useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { CatalogoDeHotel, Sesion, UnidadDeServicio, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Cotizador } from '../../componentes/hotel/Cotizador.tsx';
import { FichaDeTipo } from '../../componentes/hotel/FichaDeTipo.tsx';
import { aCentimos, importe } from '../../vista/dinero.ts';
import estilos from './Hotel.module.css';

interface Props {
  sesion: Sesion;
  alSalir: () => void;
}

const UNIDADES: { valor: UnidadDeServicio; texto: string }[] = [
  { valor: 'por_estancia', texto: 'por estancia' },
  { valor: 'por_noche', texto: 'por noche' },
  { valor: 'por_persona_noche', texto: 'por persona y noche' },
];

/**
 * El hotel: qué se vende y a cuánto.
 *
 * Tres columnas con tres trabajos distintos: la lista de tipos es para
 * elegir, la ficha para administrar, y el cotizador para **contestar** — que
 * es para lo que recepción abre esta pantalla nueve de cada diez veces. Por
 * eso el cotizador está siempre a la vista y no detrás de un botón.
 *
 * El catálogo empieza vacío en una cuenta nueva: los tipos y los precios del
 * hotel no están escritos en el código, se ponen aquí.
 */
export function Hotel({ sesion, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoDeHotel | null>(null);
  const [elegido, setElegido] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nuevoTipo, setNuevoTipo] = useState({ nombre: '', capacidad: '2', precio: '' });
  const [nuevoServicio, setNuevoServicio] = useState({
    nombre: '',
    precio: '',
    unidad: 'por_estancia' as UnidadDeServicio,
  });

  const cargar = useCallback(async () => {
    try {
      const c = await api.hotel();
      setCatalogo(c);
      setElegido((actual) => actual ?? c.tipos[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el hotel.');
    }
  }, [api]);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    void cargar();
  }, [api, cargar]);

  const puedeEditar = yo?.rol === 'owner' || yo?.rol === 'admin';
  const tipo = catalogo?.tipos.find((t) => t.id === elegido) ?? null;

  async function hacer(f: () => Promise<unknown>) {
    setError(null);
    try {
      await f();
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
  }

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="hotel" alSalir={alSalir} />

      <main className={estilos.centro}>
        <header className={`glass ${estilos.barra}`}>
          <h1 className={estilos.titulo}>Hotel</h1>
          <p className={estilos.subtitulo}>
            Habitaciones, tarifas y servicios. Los precios se cambian aquí y en ningún otro sitio.
          </p>
        </header>

        {error && <p className={estilos.error}>{error}</p>}

        <div className={estilos.cuerpo}>
          {/* --- Tipos ------------------------------------------------------ */}
          <aside className={`glass ${estilos.tipos}`} aria-label="Tipos de habitación">
            <h2 className={estilos.seccion}>Tipos de habitación</h2>
            <ul className={estilos.lista}>
              {catalogo?.tipos.map((t) => (
                <li key={t.id}>
                  <button
                    className={`${estilos.tipo} ${t.id === elegido ? estilos.tipoElegido : ''} ${
                      t.activo ? '' : estilos.tipoArchivado
                    }`}
                    aria-current={t.id === elegido ? 'true' : undefined}
                    onClick={() => setElegido(t.id)}
                  >
                    <span className={estilos.tipoNombre}>{t.nombre}</span>
                    <span className={estilos.tipoDato}>
                      hasta {t.capacidad} · {t.habitaciones.length} hab.
                    </span>
                    <span className={estilos.tipoPrecio}>
                      {t.precioBase === null ? 'sin precio' : importe(t.precioBase, t.moneda)}
                    </span>
                  </button>
                </li>
              ))}
              {catalogo && catalogo.tipos.length === 0 && (
                <li className={estilos.vacio}>
                  {puedeEditar
                    ? 'Aún no hay tipos. Crea el primero aquí debajo.'
                    : 'El administrador todavía no ha cargado las habitaciones.'}
                </li>
              )}
            </ul>

            {puedeEditar && (
              <form
                className={estilos.alta}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!nuevoTipo.nombre.trim()) return;
                  void hacer(async () => {
                    const { id } = await api.crearTipo({
                      nombre: nuevoTipo.nombre.trim(),
                      capacidad: Math.max(1, Number(nuevoTipo.capacidad) || 1),
                      precioBase: nuevoTipo.precio.trim() ? aCentimos(nuevoTipo.precio) : null,
                    });
                    setNuevoTipo({ nombre: '', capacidad: '2', precio: '' });
                    setElegido(id);
                  });
                }}
              >
                <input
                  className={estilos.control}
                  placeholder="Nuevo tipo: Familiar VIP…"
                  aria-label="Nombre del tipo nuevo"
                  value={nuevoTipo.nombre}
                  onChange={(e) => setNuevoTipo({ ...nuevoTipo, nombre: e.target.value })}
                />
                <div className={estilos.altaFila}>
                  <input
                    className={estilos.control}
                    type="number"
                    min={1}
                    aria-label="Capacidad"
                    title="Personas"
                    value={nuevoTipo.capacidad}
                    onChange={(e) => setNuevoTipo({ ...nuevoTipo, capacidad: e.target.value })}
                  />
                  <input
                    className={estilos.control}
                    inputMode="decimal"
                    placeholder="Precio / noche"
                    aria-label="Precio base por noche"
                    value={nuevoTipo.precio}
                    onChange={(e) => setNuevoTipo({ ...nuevoTipo, precio: e.target.value })}
                  />
                  <button className={estilos.boton} disabled={!nuevoTipo.nombre.trim()}>
                    Crear
                  </button>
                </div>
              </form>
            )}
          </aside>

          {/* --- Ficha ------------------------------------------------------ */}
          {tipo ? (
            <FichaDeTipo api={api} tipo={tipo} puedeEditar={puedeEditar} alCambiar={cargar} />
          ) : (
            <section className={`glass ${estilos.sinTipo}`}>
              <p>Elige un tipo de habitación para ver sus habitaciones y sus tarifas.</p>
            </section>
          )}

          {/* --- Cotizador y servicios --------------------------------------- */}
          <div className={estilos.derecha}>
            {catalogo && (
              <Cotizador
                api={api}
                tipos={catalogo.tipos}
                servicios={catalogo.servicios}
                tipoInicial={elegido}
              />
            )}

            <section className={`glass ${estilos.servicios}`} aria-label="Servicios adicionales">
              <h2 className={estilos.seccion}>Servicios adicionales</h2>
              <ul className={estilos.lista}>
                {catalogo?.servicios.map((s) => (
                  <li
                    key={s.id}
                    className={`${estilos.servicio} ${s.activo ? '' : estilos.tipoArchivado}`}
                  >
                    <span className={estilos.tipoNombre}>{s.nombre}</span>
                    <span className={estilos.tipoDato}>
                      {importe(s.precio, s.moneda)}{' '}
                      {UNIDADES.find((u) => u.valor === s.unidad)?.texto}
                    </span>
                    {puedeEditar && (
                      <button
                        className={estilos.enlace}
                        onClick={() =>
                          void hacer(() => api.editarServicio(s.id, { activo: !s.activo }))
                        }
                      >
                        {s.activo ? 'Retirar' : 'Ofrecer'}
                      </button>
                    )}
                  </li>
                ))}
                {catalogo && catalogo.servicios.length === 0 && (
                  <li className={estilos.vacio}>Desayuno, cochera, cama extra…</li>
                )}
              </ul>
              {puedeEditar && (
                <form
                  className={estilos.altaFila}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!nuevoServicio.nombre.trim() || !nuevoServicio.precio.trim()) return;
                    void hacer(async () => {
                      await api.crearServicio({
                        nombre: nuevoServicio.nombre.trim(),
                        precio: aCentimos(nuevoServicio.precio),
                        unidad: nuevoServicio.unidad,
                      });
                      setNuevoServicio({ nombre: '', precio: '', unidad: 'por_estancia' });
                    });
                  }}
                >
                  <input
                    className={estilos.control}
                    placeholder="Desayuno"
                    aria-label="Nombre del servicio"
                    value={nuevoServicio.nombre}
                    onChange={(e) => setNuevoServicio({ ...nuevoServicio, nombre: e.target.value })}
                  />
                  <input
                    className={estilos.control}
                    inputMode="decimal"
                    placeholder="Precio"
                    aria-label="Precio del servicio"
                    value={nuevoServicio.precio}
                    onChange={(e) => setNuevoServicio({ ...nuevoServicio, precio: e.target.value })}
                  />
                  <select
                    className={estilos.control}
                    aria-label="Cómo se cobra"
                    value={nuevoServicio.unidad}
                    onChange={(e) =>
                      setNuevoServicio({
                        ...nuevoServicio,
                        unidad: e.target.value as UnidadDeServicio,
                      })
                    }
                  >
                    {UNIDADES.map((u) => (
                      <option key={u.valor} value={u.valor}>
                        {u.texto}
                      </option>
                    ))}
                  </select>
                  <button
                    className={estilos.boton}
                    disabled={!nuevoServicio.nombre.trim() || !nuevoServicio.precio.trim()}
                  >
                    Añadir
                  </button>
                </form>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
