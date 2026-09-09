import { useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Etiqueta, ResumenDeConversacion } from '../../api/tipos.ts';
import { inicial } from '../../vista/tiempo.ts';
import { pintar } from '../Filtros/Filtros.tsx';
import estilos from './PanelDeContacto.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  etiquetas: Etiqueta[];
  userId: string;
  alCambiar: () => void;
}

const ESTADOS: [string, string][] = [
  ['open', 'Abierta'],
  ['pending', 'Pendiente'],
  ['snoozed', 'Pospuesta'],
  ['closed', 'Cerrada'],
];

/** Ficha del contacto (Kommo): quién es, quién la atiende, en qué estado va y sus etiquetas. */
export function PanelDeContacto({ api, conversacion, etiquetas, userId, alCambiar }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const mia = conversacion.agenteId === userId;
  const puestas = new Set(conversacion.etiquetas.map((e) => e.id));

  async function hacer(fn: () => Promise<unknown>) {
    setOcupado(true);
    setError(null);
    try {
      await fn();
      alCambiar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className={estilos.panel}>
      <div className={estilos.cabecera}>
        <span className={estilos.avatar} aria-hidden="true">
          {inicial(conversacion.contacto.nombre, conversacion.contacto.handle)}
        </span>
        <h2 className={estilos.nombre}>
          {conversacion.contacto.nombre ?? conversacion.contacto.handle ?? 'Sin nombre'}
        </h2>
        {conversacion.contacto.handle && (
          <p className={estilos.handle}>{conversacion.contacto.handle}</p>
        )}
      </div>

      <section className={estilos.seccion}>
        <h3 className={estilos.titulo}>Atiende</h3>
        <button
          className={estilos.accion}
          disabled={ocupado}
          onClick={() => hacer(() => api.asignar(conversacion.id, mia ? null : userId))}
        >
          {mia
            ? 'Quitarme la asignación'
            : conversacion.agenteId
              ? 'Asignármela a mí'
              : 'Tomar esta conversación'}
        </button>
        <p className={estilos.nota}>
          {mia
            ? 'La atiendes tú.'
            : conversacion.agenteId
              ? 'Asignada a otra persona.'
              : 'Sin asignar.'}
        </p>
      </section>

      <section className={estilos.seccion}>
        <h3 className={estilos.titulo}>Estado</h3>
        <div className={estilos.estados} role="radiogroup" aria-label="Estado">
          {ESTADOS.map(([valor, texto]) => (
            <button
              key={valor}
              role="radio"
              aria-checked={conversacion.estado === valor}
              className={`${estilos.estado} ${conversacion.estado === valor ? estilos.estadoActivo : ''}`}
              disabled={ocupado || conversacion.estado === valor}
              onClick={() => hacer(() => api.cambiarEstado(conversacion.id, valor))}
            >
              {texto}
            </button>
          ))}
        </div>
      </section>

      <section className={estilos.seccion}>
        <h3 className={estilos.titulo}>Etiquetas</h3>
        {etiquetas.length === 0 && (
          <p className={estilos.nota}>
            Crea etiquetas de color desde la lista para filtrar por ellas.
          </p>
        )}
        <ul className={estilos.etiquetas}>
          {etiquetas.map((e) => {
            const puesta = puestas.has(e.id);
            return (
              <li key={e.id}>
                <button
                  className={`${estilos.etiqueta} ${puesta ? estilos.etiquetaPuesta : ''}`}
                  aria-pressed={puesta}
                  disabled={ocupado}
                  ref={pintar(e.color)}
                  onClick={() => hacer(() => api.etiquetar(conversacion.id, e.id, !puesta))}
                >
                  <span className={estilos.punto} />
                  {e.nombre}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
