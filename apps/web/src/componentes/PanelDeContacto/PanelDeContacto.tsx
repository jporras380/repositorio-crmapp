import { useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Etiqueta, ResumenDeConversacion } from '../../api/tipos.ts';
import { horaCorta, inicial } from '../../vista/tiempo.ts';
import { pintar } from '../Filtros/Filtros.tsx';
import { ReservaDeConversacion } from './ReservaDeConversacion.tsx';
import { Notas } from './Notas.tsx';
import { NombreDelContacto } from './NombreDelContacto.tsx';
import estilos from './PanelDeContacto.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  etiquetas: Etiqueta[];
  userId: string;
  /** Cierra la ficha. Solo se ve donde la ficha tapa el hilo en vez de convivir con él. */
  alCerrar: () => void;
  alCambiar: () => void;
}

const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

const ESTADOS: [string, string][] = [
  ['open', 'Abierta'],
  ['pending', 'Pendiente'],
  ['snoozed', 'Pospuesta'],
  ['closed', 'Cerrada'],
];

/** Ficha del contacto (Kommo): quién es, quién la atiende, en qué estado va y sus etiquetas. */
export function PanelDeContacto({
  api,
  conversacion,
  etiquetas,
  userId,
  alCerrar,
  alCambiar,
}: Props) {
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
        {/*
          Por debajo de 1100 px la ficha se superpone al hilo y tapa el botón
          «Detalles» que la abrió: sin esta aspa no habría forma de cerrarla.
        */}
        <button className={estilos.cerrar} onClick={alCerrar} title="Cerrar la ficha">
          <span aria-hidden="true">×</span>
          <span className="visually-hidden">Cerrar la ficha</span>
        </button>
        <span className={estilos.avatar} aria-hidden="true">
          {inicial(conversacion.contacto.nombre, conversacion.contacto.handle)}
          <span className={`${estilos.canal} ${estilos[`canal_${conversacion.canal}`] ?? ''}`} />
        </span>
        <NombreDelContacto
          api={api}
          contactoId={conversacion.contacto.id}
          nombre={conversacion.contacto.nombre}
          handle={conversacion.contacto.handle}
          alGuardar={alCambiar}
        />
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

      {/*
        La ficha se quedaba a medias: quién es y qué se hace con ella, pero
        nada de cómo va. Estos tres datos ya viajan en el resumen de la
        conversación —no cuestan una petición más— y son los que se miran
        antes de escribir: por dónde llegó, cuándo escribió y si ya se le
        contestó.
      */}
      <section className={estilos.seccion}>
        <h3 className={estilos.titulo}>Actividad</h3>
        <dl className={estilos.datos}>
          <div className={estilos.dato}>
            <dt>Canal</dt>
            <dd>{CANAL[conversacion.canal] ?? conversacion.canal}</dd>
          </div>
          <div className={estilos.dato}>
            <dt>Escribió</dt>
            <dd>{horaCorta(conversacion.ultimoEntranteEn) || 'nunca'}</dd>
          </div>
          <div className={estilos.dato}>
            <dt>Respondimos</dt>
            <dd>{horaCorta(conversacion.ultimoSalienteEn) || 'todavía no'}</dd>
          </div>
        </dl>
      </section>

      <ReservaDeConversacion api={api} conversacionId={conversacion.id} />

      <Notas api={api} conversacionId={conversacion.id} userId={userId} />

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
