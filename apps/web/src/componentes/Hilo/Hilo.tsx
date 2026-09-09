import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Mensaje, ResumenDeConversacion } from '../../api/tipos.ts';
import { diaDeMensaje, horaDeMensaje, inicial, ventana } from '../../vista/tiempo.ts';
import { Compositor } from '../Compositor/Compositor.tsx';
import { CompositorDeComentario } from '../Compositor/CompositorDeComentario.tsx';
import { Medio } from './Medio.tsx';
import estilos from './Hilo.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  /** Si la ficha del contacto esta a la vista; el boton la alterna. */
  fichaAbierta: boolean;
  alAlternarFicha: () => void;
  /** Volver a la lista. Solo se ve en movil, donde no caben las dos. */
  alVolver: () => void;
  alCambiar: () => void;
}

const CADA_MS = 5_000;
const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};
const ESTADO_MENSAJE: Record<string, string> = {
  queued: 'En cola',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'No se envió',
};

export function Hilo({
  api,
  conversacion,
  fichaAbierta,
  alAlternarFicha,
  alVolver,
  alCambiar,
}: Props) {
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [cargando, setCargando] = useState(true);
  const [tic, setTic] = useState(0);
  const fondo = useRef<HTMLDivElement>(null);
  const ultimoId = useRef<string | null>(null);

  const cargar = useCallback(async () => {
    const p = await api.mensajes(conversacion.id);
    // La API devuelve los más recientes primero; el hilo se lee de arriba abajo.
    setMensajes(p.items.slice().reverse());
    setCargando(false);
  }, [api, conversacion.id]);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => void cargar(), CADA_MS);
    const reloj = setInterval(() => setTic((t) => t + 1), 30_000);
    return () => {
      clearInterval(id);
      clearInterval(reloj);
    };
  }, [cargar]);

  // Baja al final solo cuando llega algo nuevo, no en cada sondeo.
  useEffect(() => {
    const ultimo = mensajes[mensajes.length - 1]?.id ?? null;
    if (ultimo && ultimo !== ultimoId.current) {
      ultimoId.current = ultimo;
      fondo.current?.scrollIntoView({ block: 'end' });
    }
  }, [mensajes]);

  void tic;
  const v = ventana(conversacion.ventanaExpiraEn);
  const nombre = conversacion.contacto.nombre ?? conversacion.contacto.handle ?? 'Sin nombre';

  return (
    <div className={estilos.hilo}>
      <header className={estilos.cabecera}>
        <button className={estilos.volver} onClick={alVolver} title="Volver a la lista">
          <Galon />
          <span className="visually-hidden">Volver a la lista</span>
        </button>
        <span className={estilos.avatar} aria-hidden="true">
          {inicial(conversacion.contacto.nombre, conversacion.contacto.handle)}
        </span>
        <div className={estilos.quien}>
          <h2 className={estilos.nombre}>{nombre}</h2>
          <p className={estilos.detalle}>
            {CANAL[conversacion.canal] ?? conversacion.canal}
            {conversacion.contacto.handle ? ` · ${conversacion.contacto.handle}` : ''}
            {conversacion.tipo === 'comment_thread' ? ' · publicación' : ''}
          </p>
        </div>
        {conversacion.tipo === 'comment_thread' ? (
          <span className={estilos.hiloComentarios} title="Comentarios de una publicación">
            Comentarios
          </span>
        ) : (
          <span
            className={`${estilos.ventana} ${estilos[`ventana_${v.tono}`]}`}
            title="Tiempo para responder sin plantilla"
          >
            {v.texto}
          </span>
        )}
        <button
          className={`${estilos.detalles} ${fichaAbierta ? estilos.detallesActivo : ''}`}
          aria-pressed={fichaAbierta}
          aria-controls="panel-ficha"
          onClick={alAlternarFicha}
          title={fichaAbierta ? 'Ocultar la ficha del contacto' : 'Ver la ficha del contacto'}
        >
          <IconoFicha />
          <span className={estilos.detallesTexto}>Detalles</span>
        </button>
      </header>

      <div className={estilos.mensajes} role="log" aria-live="polite" aria-busy={cargando}>
        {!cargando && mensajes.length === 0 && (
          <p className={estilos.sinMensajes}>Todavía no hay mensajes.</p>
        )}
        {mensajes.map((m, i) => {
          const anterior = mensajes[i - 1];
          const dia = diaDeMensaje(m.creado_en);
          const nuevoDia = !anterior || diaDeMensaje(anterior.creado_en) !== dia;
          return (
            <Fragment key={m.id}>
              {nuevoDia && (
                <div className={estilos.dia}>
                  <span className={estilos.diaTexto}>{dia}</span>
                </div>
              )}
              <Burbuja
                m={m}
                api={api}
                agrupado={!nuevoDia && anterior?.direccion === m.direccion}
              />
            </Fragment>
          );
        })}
        <div ref={fondo} />
      </div>

      {conversacion.tipo === 'comment_thread' ? (
        <CompositorDeComentario
          api={api}
          conversacion={conversacion}
          alEnviado={() => {
            void cargar();
            alCambiar();
          }}
        />
      ) : (
        <Compositor
          api={api}
          conversacion={conversacion}
          alEnviado={() => {
            void cargar();
            alCambiar();
          }}
        />
      )}
    </div>
  );
}

function Burbuja({ m, api, agrupado }: { m: Mensaje; api: Api; agrupado: boolean }) {
  const saliente = m.direccion === 'outbound';
  return (
    <article
      className={`${estilos.burbuja} ${saliente ? estilos.saliente : estilos.entrante} ${agrupado ? estilos.agrupado : ''} ${m.estado === 'failed' ? estilos.fallido : ''}`}
    >
      {m.medio_id && <Medio api={api} tipo={m.tipo} medioId={m.medio_id} estado={m.medio_estado} />}
      {m.tipo === 'template' && <span className={estilos.tipo}>Plantilla</span>}
      {m.texto && <p className={estilos.texto}>{m.texto}</p>}
      <footer className={estilos.meta}>
        <time dateTime={m.creado_en}>{horaDeMensaje(m.creado_en)}</time>
        {saliente && (
          <span className={estilos.estado}>
            {m.estado === 'failed' && m.error?.mensaje
              ? `No se envió: ${m.error.mensaje}`
              : (ESTADO_MENSAJE[m.estado] ?? m.estado)}
          </span>
        )}
      </footer>
    </article>
  );
}

function Galon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconoFicha() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 19.5c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
