import type { ResumenDeConversacion } from '../../api/tipos.ts';
import { horaCorta, inicial, ventana } from '../../vista/tiempo.ts';
import { pintar } from '../Filtros/Filtros.tsx';
import estilos from './ListaDeConversaciones.module.css';

interface Props {
  items: ResumenDeConversacion[];
  seleccionadaId: string | null;
  cargando: boolean;
  error: string | null;
  hayMas: boolean;
  alSeleccionar: (id: string) => void;
  alCargarMas: () => void;
}

/** Solo lo que hay que mirar. Lo normal no lleva insignia. */
const ATENCION: Record<string, string> = {
  nueva: 'Nueva',
  por_responder: 'Por responder',
  seguimiento: 'Aplazada',
};

export function ListaDeConversaciones({
  items,
  seleccionadaId,
  cargando,
  error,
  hayMas,
  alSeleccionar,
  alCargarMas,
}: Props) {
  if (error) {
    return (
      <p className={estilos.aviso} role="alert">
        {error}
      </p>
    );
  }
  if (!cargando && items.length === 0) {
    return (
      <div className={estilos.vacio}>
        <p className={estilos.vacioTitulo}>Nada por aquí</p>
        <p className={estilos.vacioTexto}>
          Cuando alguien te escriba, su conversación aparecerá en esta lista.
        </p>
      </div>
    );
  }
  return (
    <ul className={estilos.lista} aria-busy={cargando}>
      {items.map((c) => (
        <Fila
          key={c.id}
          c={c}
          activa={c.id === seleccionadaId}
          alSeleccionar={() => alSeleccionar(c.id)}
        />
      ))}
      {hayMas && (
        <li className={estilos.mas}>
          <button onClick={alCargarMas}>Cargar más</button>
        </li>
      )}
    </ul>
  );
}

function Fila({
  c,
  activa,
  alSeleccionar,
}: {
  c: ResumenDeConversacion;
  activa: boolean;
  alSeleccionar: () => void;
}) {
  const v = ventana(c.ventanaExpiraEn);
  const nombre = c.contacto.nombre ?? c.contacto.handle ?? 'Sin nombre';
  return (
    <li>
      <button
        className={`${estilos.fila} ${activa ? estilos.activa : ''} ${c.noLeidos > 0 ? estilos.noLeida : ''}`}
        onClick={alSeleccionar}
        aria-current={activa ? 'true' : undefined}
      >
        {/* Franja de color: las etiquetas del usuario, apiladas (Zenvia). */}
        <span className={estilos.franja} aria-hidden="true">
          {c.etiquetas
            .filter((e) => e.color)
            .slice(0, 3)
            .map((e) => (
              <span key={e.id} className={estilos.franjaTramo} ref={pintar(e.color)} />
            ))}
        </span>

        <span className={estilos.avatar} data-canal={c.canal} aria-hidden="true">
          {inicial(c.contacto.nombre, c.contacto.handle)}
          <span className={`${estilos.canal} ${estilos[`canal_${c.canal}`] ?? ''}`} />
        </span>

        <span className={estilos.cuerpo}>
          <span className={estilos.linea}>
            <span className={estilos.nombre}>{nombre}</span>
            <time className={estilos.hora} dateTime={c.ultimoEntranteEn ?? undefined}>
              {horaCorta(c.ultimoEntranteEn ?? c.ultimoSalienteEn)}
            </time>
          </span>
          <span className={estilos.linea}>
            <span className={estilos.vistaPrevia}>{c.vistaPrevia ?? '—'}</span>
            {c.noLeidos > 0 && (
              <span className={estilos.contador} aria-label={`${c.noLeidos} sin leer`}>
                {c.noLeidos > 99 ? '99+' : c.noLeidos}
              </span>
            )}
          </span>
          <span className={estilos.pie}>
            {/* El estado de atención lo calcula el servidor; aquí solo se
                pinta. «Esperando cliente» no se marca porque es el estado
                normal tras responder: señalarlo sería ruido en cada fila. */}
            {ATENCION[c.atencion] && (
              <span className={`${estilos.atencion} ${estilos[`atencion_${c.atencion}`] ?? ''}`}>
                {ATENCION[c.atencion]}
              </span>
            )}
            {c.tipo === 'comment_thread' ? (
              <span className={estilos.comentario}>Comentario</span>
            ) : (
              <span className={`${estilos.ventana} ${estilos[`ventana_${v.tono}`]}`}>
                {v.texto}
              </span>
            )}
            {c.etiquetas.slice(0, 2).map((e) => (
              <span key={e.id} className={estilos.etiqueta} ref={pintar(e.color)}>
                {e.nombre}
              </span>
            ))}
            {c.etiquetas.length > 2 && (
              <span className={estilos.etiquetaMas}>+{c.etiquetas.length - 2}</span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
