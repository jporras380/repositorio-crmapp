import { useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { EstadoDeHabitacion, TipoDeHabitacion } from '../../api/tipos.ts';
import { aCampo, aCentimos, importe } from '../../vista/dinero.ts';
import estilos from './FichaDeTipo.module.css';

interface Props {
  api: Api;
  tipo: TipoDeHabitacion;
  /** Solo propietario o administrador cambian el catálogo. */
  puedeEditar: boolean;
  alCambiar: () => void | Promise<void>;
  /** Tras borrarlo ya no existe: la pantalla tiene que dejar de enseñarlo. */
  alBorrar?: (() => void) | undefined;
}

const ESTADOS: { valor: EstadoDeHabitacion; texto: string }[] = [
  { valor: 'disponible', texto: 'Disponible' },
  { valor: 'mantenimiento', texto: 'En mantenimiento' },
  { valor: 'fuera_de_servicio', texto: 'Fuera de servicio' },
];

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Un tipo de habitación: sus datos, sus habitaciones y sus tarifas.
 *
 * Quien no administra ve lo mismo pero sin formularios. Esconderle los precios
 * a recepción no protege nada —los necesita para contestar— y enseñarle
 * campos que luego fallan con un 403 solo enseña a desconfiar de la pantalla.
 *
 * Los importes se escriben como una persona («180» o «180,50») y viajan en
 * céntimos: el dinero no cruza la red con decimales.
 */
export function FichaDeTipo({ api, tipo, puedeEditar, alCambiar, alBorrar }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [habitacion, setHabitacion] = useState('');
  const [tarifa, setTarifa] = useState({
    nombre: '',
    desde: '',
    hasta: '',
    precio: '',
    minNoches: '1',
    dias: [] as number[],
  });

  async function hacer(f: () => Promise<unknown>) {
    setError(null);
    try {
      await f();
      await alCambiar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
  }

  return (
    <section className={`glass ${estilos.ficha}`} aria-label={`Tipo: ${tipo.nombre}`}>
      <header className={estilos.cabecera}>
        {puedeEditar ? (
          <input
            className={estilos.nombre}
            defaultValue={tipo.nombre}
            aria-label="Nombre del tipo"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== tipo.nombre) void hacer(() => api.editarTipo(tipo.id, { nombre: v }));
            }}
          />
        ) : (
          <h2 className={estilos.nombreFijo}>{tipo.nombre}</h2>
        )}
        {!tipo.activo && <span className={estilos.archivado}>Archivado</span>}
      </header>

      {error && <p className={estilos.error}>{error}</p>}

      <div className={estilos.datos}>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Capacidad</span>
          {puedeEditar ? (
            <input
              className={estilos.control}
              type="number"
              min={1}
              max={50}
              defaultValue={tipo.capacidad}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v !== tipo.capacidad) {
                  void hacer(() => api.editarTipo(tipo.id, { capacidad: v }));
                }
              }}
            />
          ) : (
            <span className={estilos.valor}>{tipo.capacidad} personas</span>
          )}
        </label>
        <label className={estilos.campo}>
          <span className={estilos.etiqueta}>Precio base por noche</span>
          {puedeEditar ? (
            <input
              className={estilos.control}
              inputMode="decimal"
              placeholder="Sin precio de lista"
              defaultValue={tipo.precioBase === null ? '' : aCampo(tipo.precioBase)}
              onBlur={(e) => {
                const texto = e.target.value.trim();
                const v = texto === '' ? null : aCentimos(texto);
                if (v !== tipo.precioBase) {
                  void hacer(() => api.editarTipo(tipo.id, { precioBase: v }));
                }
              }}
            />
          ) : (
            <span className={estilos.valor}>
              {tipo.precioBase === null
                ? 'Sin precio de lista'
                : importe(tipo.precioBase, tipo.moneda)}
            </span>
          )}
        </label>
      </div>

      {/* --- Habitaciones --------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Habitaciones">
        <h3 className={estilos.bloqueTitulo}>Habitaciones · {tipo.habitaciones.length}</h3>
        <ul className={estilos.lista}>
          {tipo.habitaciones.map((h) => (
            <li key={h.id} className={estilos.fila}>
              <span className={estilos.filaNombre}>{h.nombre}</span>
              {puedeEditar ? (
                <select
                  className={`${estilos.control} ${estilos[`estado_${h.estado}`] ?? ''}`}
                  value={h.estado}
                  aria-label={`Estado de ${h.nombre}`}
                  onChange={(e) =>
                    void hacer(() =>
                      api.editarHabitacion(h.id, { estado: e.target.value as EstadoDeHabitacion }),
                    )
                  }
                >
                  {ESTADOS.map((s) => (
                    <option key={s.valor} value={s.valor}>
                      {s.texto}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`${estilos.estado} ${estilos[`estado_${h.estado}`] ?? ''}`}>
                  {ESTADOS.find((s) => s.valor === h.estado)?.texto}
                </span>
              )}
              {puedeEditar && (
                <button
                  className={estilos.quitar}
                  aria-label={`Borrar ${h.nombre}`}
                  onClick={() => void hacer(() => api.borrarHabitacion(h.id))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {tipo.habitaciones.length === 0 && <li className={estilos.vacio}>Sin habitaciones.</li>}
        </ul>
        {puedeEditar && (
          <form
            className={estilos.alta}
            onSubmit={(e) => {
              e.preventDefault();
              const nombre = habitacion.trim();
              if (!nombre) return;
              void hacer(async () => {
                await api.crearHabitacion({ tipoId: tipo.id, nombre });
                setHabitacion('');
              });
            }}
          >
            <input
              className={estilos.control}
              placeholder="Bungalow 4, 204…"
              aria-label="Nombre de la habitación nueva"
              value={habitacion}
              onChange={(e) => setHabitacion(e.target.value)}
            />
            <button className={estilos.boton} disabled={!habitacion.trim()}>
              Añadir
            </button>
          </form>
        )}
      </section>

      {/* --- Tarifas -------------------------------------------------------- */}
      <section className={estilos.bloque} aria-label="Tarifas">
        <h3 className={estilos.bloqueTitulo}>Tarifas</h3>
        <p className={estilos.ayuda}>
          Si dos tarifas cubren la misma noche, manda la de rango más corto. Cada noche se cobra a
          su precio.
        </p>
        <ul className={estilos.lista}>
          {tipo.tarifas.map((t) => (
            <li key={t.id} className={estilos.tarifa}>
              <span className={estilos.filaNombre}>{t.nombre}</span>
              <span className={estilos.secundario}>
                {t.desde} → {t.hasta}
                {t.dias ? ` · ${t.dias.map((d) => NOMBRE_DIA[d]).join(', ')}` : ''}
                {t.minNoches > 1 ? ` · mínimo ${t.minNoches} noches` : ''}
              </span>
              <span className={estilos.cifra}>{importe(t.precio, tipo.moneda)}</span>
              {puedeEditar && (
                <button
                  className={estilos.quitar}
                  aria-label={`Borrar la tarifa ${t.nombre}`}
                  onClick={() => void hacer(() => api.borrarTarifa(t.id))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {tipo.tarifas.length === 0 && (
            <li className={estilos.vacio}>
              Sin tarifas: todas las noches se cobran al precio base.
            </li>
          )}
        </ul>

        {puedeEditar && (
          <form
            className={estilos.nuevaTarifa}
            onSubmit={(e) => {
              e.preventDefault();
              if (!tarifa.nombre.trim() || !tarifa.desde || !tarifa.hasta || !tarifa.precio) return;
              void hacer(async () => {
                await api.crearTarifa({
                  tipoId: tipo.id,
                  nombre: tarifa.nombre.trim(),
                  desde: tarifa.desde,
                  hasta: tarifa.hasta,
                  precio: aCentimos(tarifa.precio),
                  minNoches: Math.max(1, Number(tarifa.minNoches) || 1),
                  dias: tarifa.dias.length ? tarifa.dias : null,
                });
                setTarifa({
                  nombre: '',
                  desde: '',
                  hasta: '',
                  precio: '',
                  minNoches: '1',
                  dias: [],
                });
              });
            }}
          >
            <input
              className={estilos.control}
              placeholder="Fiestas Patrias"
              aria-label="Nombre de la tarifa"
              value={tarifa.nombre}
              onChange={(e) => setTarifa({ ...tarifa, nombre: e.target.value })}
            />
            <input
              className={estilos.control}
              type="date"
              aria-label="Desde"
              value={tarifa.desde}
              onChange={(e) => setTarifa({ ...tarifa, desde: e.target.value })}
            />
            <input
              className={estilos.control}
              type="date"
              aria-label="Hasta"
              min={tarifa.desde || undefined}
              value={tarifa.hasta}
              onChange={(e) => setTarifa({ ...tarifa, hasta: e.target.value })}
            />
            <input
              className={estilos.control}
              inputMode="decimal"
              placeholder="Precio / noche"
              aria-label="Precio por noche"
              value={tarifa.precio}
              onChange={(e) => setTarifa({ ...tarifa, precio: e.target.value })}
            />
            <input
              className={estilos.control}
              type="number"
              min={1}
              aria-label="Noches mínimas"
              title="Noches mínimas"
              value={tarifa.minNoches}
              onChange={(e) => setTarifa({ ...tarifa, minNoches: e.target.value })}
            />
            <span className={estilos.dias} role="group" aria-label="Días en que aplica">
              {DIAS.map((d, i) => {
                const puesto = tarifa.dias.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`${estilos.dia} ${puesto ? estilos.diaPuesto : ''}`}
                    aria-pressed={puesto}
                    aria-label={NOMBRE_DIA[i]}
                    onClick={() =>
                      setTarifa({
                        ...tarifa,
                        dias: puesto ? tarifa.dias.filter((x) => x !== i) : [...tarifa.dias, i],
                      })
                    }
                  >
                    {d}
                  </button>
                );
              })}
            </span>
            <button
              className={estilos.boton}
              disabled={!tarifa.nombre.trim() || !tarifa.desde || !tarifa.hasta || !tarifa.precio}
            >
              Añadir tarifa
            </button>
          </form>
        )}
      </section>

      {puedeEditar && (
        <footer className={estilos.pie}>
          <button
            className={estilos.secundarioBoton}
            onClick={() => void hacer(() => api.editarTipo(tipo.id, { activo: !tipo.activo }))}
          >
            {tipo.activo ? 'Archivar tipo' : 'Volver a ofrecerlo'}
          </button>
          {/* Borrar de verdad, que no existía: se podían crear tipos y no
              quitarlos, y era la deuda con nombre más vieja de la guarda.
              Solo se ofrece SIN habitaciones: con ellas la API contesta 409,
              y enseñar un botón que siempre falla es peor que no tenerlo.
              Para dejar de ofrecer un tipo que sí tiene, está archivar. */}
          {tipo.habitaciones.length === 0 && (
            <button
              className={estilos.peligroBoton}
              onClick={() => {
                if (!confirm(`¿Borrar el tipo «${tipo.nombre}»? No tiene habitaciones.`)) return;
                void hacer(async () => {
                  await api.borrarTipo(tipo.id);
                  alBorrar?.();
                });
              }}
            >
              Borrar tipo
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
