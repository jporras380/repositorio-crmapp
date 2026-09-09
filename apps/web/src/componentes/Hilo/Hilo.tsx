import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { Mensaje, ResumenDeConversacion } from '../../api/tipos.ts';
import { horaDeMensaje, inicial, ventana } from '../../vista/tiempo.ts';
import { Compositor } from '../Compositor/Compositor.tsx';
import { CompositorDeComentario } from '../Compositor/CompositorDeComentario.tsx';
import { Medio } from './Medio.tsx';
import estilos from './Hilo.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
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

export function Hilo({ api, conversacion, alCambiar }: Props) {
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
      </header>

      <div className={estilos.mensajes} role="log" aria-live="polite" aria-busy={cargando}>
        {!cargando && mensajes.length === 0 && (
          <p className={estilos.sinMensajes}>Todavía no hay mensajes.</p>
        )}
        {mensajes.map((m, i) => (
          <Burbuja
            key={m.id}
            m={m}
            api={api}
            agrupado={mensajes[i - 1]?.direccion === m.direccion}
          />
        ))}
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
