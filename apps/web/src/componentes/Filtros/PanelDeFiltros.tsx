import { useState } from 'react';
import type { Embudo, FiltrosDeBandeja, Miembro, VistaDeBandeja } from '../../api/tipos.ts';
import estilos from './PanelDeFiltros.module.css';

interface Props {
  filtros: FiltrosDeBandeja;
  miembros: Miembro[];
  embudos: Embudo[];
  vistas: VistaDeBandeja[];
  alCambiar: (f: FiltrosDeBandeja) => void;
  alGuardarVista: (nombre: string) => void | Promise<void>;
  alBorrarVista: (id: string) => void | Promise<void>;
  alAplicarVista: (v: VistaDeBandeja) => void;
  alCerrar: () => void;
}

const ATENCION: [string, string][] = [
  ['nueva', 'Nueva · nadie la ha atendido'],
  ['por_responder', 'Por responder · escribió el cliente'],
  ['esperando_cliente', 'Esperando al cliente'],
  ['seguimiento', 'En seguimiento · aplazada'],
  ['cerrada', 'Cerrada'],
];

/** Rangos que se piden de verdad. Un calendario para «hoy» es un clic de más. */
const CUANDO: [string, string, () => string | undefined][] = [
  ['', 'Cualquier fecha', () => undefined],
  ['hoy', 'Hoy', () => inicioDeHoy().toISOString()],
  ['7', 'Últimos 7 días', () => desdeHaceDias(7)],
  ['30', 'Últimos 30 días', () => desdeHaceDias(30)],
];

function inicioDeHoy(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function desdeHaceDias(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Filtros compuestos y vistas guardadas.
 *
 * **El estado de atención no se elige a mano en la conversación: se deduce.**
 * Aquí solo se filtra por él. Una columna que el agente tuviera que mantener
 * («ponme en atención») estaría desactualizada a los dos días y el filtro
 * dejaría de servir; así no puede mentir.
 *
 * **Una vista es un filtro con nombre.** Se guarda tal cual —los mismos
 * parámetros que entiende la lista— para que añadir un filtro nuevo no
 * obligue a tocar nada de esto.
 */
export function PanelDeFiltros({
  filtros,
  miembros,
  embudos,
  vistas,
  alCambiar,
  alGuardarVista,
  alBorrarVista,
  alAplicarVista,
  alCerrar,
}: Props) {
  const [nombre, setNombre] = useState('');
  const etapas = embudos.flatMap((e) => e.etapas.map((s) => ({ ...s, embudo: e.nombre })));
  const puestos = Object.entries(filtros).filter(([, v]) => v !== undefined && v !== '').length;

  const cambiar = (parte: Partial<FiltrosDeBandeja>) => alCambiar({ ...filtros, ...parte });

  return (
    <section className={estilos.panel} aria-label="Filtros">
      <header className={estilos.cabecera}>
        <h2 className={estilos.titulo}>Filtros</h2>
        <div className={estilos.acciones}>
          {puestos > 0 && (
            <button className={estilos.limpiar} onClick={() => alCambiar({})}>
              Quitar todos
            </button>
          )}
          <button className={estilos.cerrar} onClick={alCerrar}>
            Listo
          </button>
        </div>
      </header>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Estado de atención</span>
        <select
          className={estilos.select}
          value={filtros.atencion ?? ''}
          onChange={(e) => cambiar({ atencion: e.target.value || undefined })}
        >
          <option value="">Cualquiera</option>
          {ATENCION.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Responsable</span>
        <select
          className={estilos.select}
          value={filtros.agenteId ?? ''}
          onChange={(e) => cambiar({ agenteId: e.target.value || undefined })}
        >
          <option value="">Cualquiera</option>
          {miembros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nombre}
            </option>
          ))}
        </select>
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Etapa del embudo</span>
        <select
          className={estilos.select}
          value={filtros.etapaId ?? ''}
          onChange={(e) => cambiar({ etapaId: e.target.value || undefined })}
        >
          <option value="">Cualquiera</option>
          {etapas.map((s) => (
            <option key={s.id} value={s.id}>
              {s.embudo} · {s.nombre}
            </option>
          ))}
        </select>
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Cuándo</span>
        <select
          className={estilos.select}
          value={CUANDO.find(([, , f]) => f() === filtros.desde)?.[0] ?? (filtros.desde ? '' : '')}
          onChange={(e) => {
            const opcion = CUANDO.find(([v]) => v === e.target.value);
            cambiar({ desde: opcion?.[2]() });
          }}
        >
          {CUANDO.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <section className={estilos.bloque} aria-label="Vistas guardadas">
        <h3 className={estilos.bloqueTitulo}>Mis vistas</h3>
        <ul className={estilos.vistas}>
          {vistas.map((v) => (
            <li key={v.id} className={estilos.vista}>
              <button className={estilos.aplicar} onClick={() => alAplicarVista(v)}>
                {v.nombre}
              </button>
              <button
                className={estilos.quitar}
                aria-label={`Borrar la vista ${v.nombre}`}
                onClick={() => void alBorrarVista(v.id)}
              >
                ×
              </button>
            </li>
          ))}
          {vistas.length === 0 && (
            <li className={estilos.pista}>
              Aún no has guardado ninguna. Ajusta los filtros y ponle un nombre.
            </li>
          )}
        </ul>
        <form
          className={estilos.guardar}
          onSubmit={(e) => {
            e.preventDefault();
            if (!nombre.trim()) return;
            void alGuardarVista(nombre.trim());
            setNombre('');
          }}
        >
          <input
            className={estilos.entrada}
            placeholder="Guardar estos filtros como…"
            aria-label="Nombre de la vista"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <button className={estilos.boton} disabled={!nombre.trim()}>
            Guardar
          </button>
        </form>
      </section>
    </section>
  );
}
