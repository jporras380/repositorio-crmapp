import { useRef, useState } from 'react';
import type { ColumnaDelTablero, TarjetaDeLead } from '../../api/tipos.ts';
import { importe as formatearImporte } from '../../vista/dinero.ts';
import { diaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './Tablero.module.css';

interface Props {
  columnas: ColumnaDelTablero[];
  moneda: string;
  seleccionado: string | null;
  alAbrir: (leadId: string) => void;
  /** Mover una tarjeta a otra etapa. La devuelve el servidor, no el optimismo. */
  alMover: (leadId: string, etapaId: string) => void | Promise<void>;
}

/**
 * El tablero: una columna por etapa, una tarjeta por oportunidad de venta.
 *
 * **Arrastrar no es la única forma de mover.** El arrastre nativo de HTML no
 * funciona con teclado ni con lector de pantalla, así que cada tarjeta lleva
 * además un desplegable «Mover a». No es un extra de accesibilidad: en una
 * pantalla de 13 pulgadas con seis columnas, arrastrar de la primera a la
 * última obliga a un desplazamiento horizontal a ciegas, y el desplegable es
 * más rápido incluso con ratón.
 *
 * **Sin librería de arrastre.** Añadir una dependencia pesada para mover
 * cajas está en la lista de parada, y el arrastre nativo cubre el gesto: lo
 * único que no da es reordenar dentro de la columna, que aquí no existe a
 * propósito (el orden lo manda la fecha, ver migración 0018).
 */
export function Tablero({ columnas, moneda, seleccionado, alAbrir, alMover }: Props) {
  const [sobre, setSobre] = useState<string | null>(null);
  const arrastrando = useRef<string | null>(null);

  return (
    <div className={estilos.tablero} role="list" aria-label="Etapas del embudo">
      {columnas.map((col) => (
        <section
          key={col.etapa.id}
          role="listitem"
          className={`${estilos.columna} ${sobre === col.etapa.id ? estilos.columnaSobre : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setSobre(col.etapa.id);
          }}
          onDragLeave={() => setSobre((s) => (s === col.etapa.id ? null : s))}
          onDrop={(e) => {
            e.preventDefault();
            setSobre(null);
            const id = arrastrando.current ?? e.dataTransfer.getData('text/plain');
            arrastrando.current = null;
            if (id) void alMover(id, col.etapa.id);
          }}
        >
          <header className={estilos.cabecera}>
            <span
              className={estilos.franja}
              ref={(n) => n?.style.setProperty('--color-etapa', col.etapa.color ?? '#8E8E93')}
              aria-hidden="true"
            />
            <h2 className={estilos.nombre}>{col.etapa.nombre}</h2>
            <p className={estilos.cuenta}>
              {col.total} {col.total === 1 ? 'lead' : 'leads'}
              {col.importe > 0 && (
                <>
                  {' · '}
                  <span className={estilos.suma}>{formatearImporte(col.importe, moneda)}</span>
                </>
              )}
            </p>
          </header>

          <div className={estilos.pila}>
            {col.tarjetas.map((t) => (
              <Tarjeta
                key={t.id}
                lead={t}
                moneda={moneda}
                etapaActual={col.etapa.id}
                etapas={columnas.map((c) => c.etapa)}
                seleccionado={seleccionado === t.id}
                alAbrir={alAbrir}
                alMover={alMover}
                alEmpezarArrastre={(id) => (arrastrando.current = id)}
              />
            ))}
            {col.tarjetas.length === 0 && <p className={estilos.vacia}>Nada por aquí.</p>}
            {col.total > col.tarjetas.length && (
              <p className={estilos.resto}>
                y {col.total - col.tarjetas.length} más — afina con la búsqueda
              </p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function Tarjeta({
  lead,
  moneda,
  etapaActual,
  etapas,
  seleccionado,
  alAbrir,
  alMover,
  alEmpezarArrastre,
}: {
  lead: TarjetaDeLead;
  moneda: string;
  etapaActual: string;
  etapas: { id: string; nombre: string }[];
  seleccionado: boolean;
  alAbrir: (id: string) => void;
  alMover: (leadId: string, etapaId: string) => void | Promise<void>;
  alEmpezarArrastre: (id: string) => void;
}) {
  return (
    <article
      className={`${estilos.tarjeta} ${seleccionado ? estilos.tarjetaElegida : ''}`}
      draggable
      onDragStart={(e) => {
        alEmpezarArrastre(lead.id);
        e.dataTransfer.setData('text/plain', lead.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <button className={estilos.abrir} onClick={() => alAbrir(lead.id)}>
        <span className={estilos.contacto}>
          {lead.canal && (
            <span
              className={estilos.canal}
              ref={(n) => n?.style.setProperty('--color-canal', `var(--channel-${lead.canal})`)}
              title={lead.canal}
              aria-hidden="true"
            />
          )}
          {lead.contacto.nombre ?? 'Sin nombre'}
        </span>
        <span className={estilos.titulo}>{lead.titulo}</span>
        {lead.importe > 0 && (
          <span className={estilos.importe}>{formatearImporte(lead.importe, moneda)}</span>
        )}
        {lead.etiquetas.length > 0 && (
          <span className={estilos.etiquetas}>
            {lead.etiquetas.map((e) => (
              <span
                key={e.id}
                className={estilos.etiqueta}
                ref={(n) => n?.style.setProperty('--color-etiqueta', e.color ?? '#8E8E93')}
              >
                {e.nombre}
              </span>
            ))}
          </span>
        )}
        <span className={estilos.fecha}>{diaDeMensaje(lead.actualizadoEn)}</span>
      </button>

      {/* El camino accesible —y el rápido— para mover sin arrastrar. */}
      <select
        className={estilos.mover}
        value={etapaActual}
        aria-label={`Mover «${lead.titulo}» a otra etapa`}
        onChange={(e) => void alMover(lead.id, e.target.value)}
      >
        {etapas.map((e) => (
          <option key={e.id} value={e.id}>
            {e.nombre}
          </option>
        ))}
      </select>
    </article>
  );
}
