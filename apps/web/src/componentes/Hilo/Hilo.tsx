import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { Mensaje, ResumenDeConversacion } from '../../api/tipos.ts';
import { diaDeMensaje, horaDeMensaje, inicial, ventana } from '../../vista/tiempo.ts';
import { Compositor } from '../Compositor/Compositor.tsx';
import { CompositorDeComentario } from '../Compositor/CompositorDeComentario.tsx';
import { Aplazar } from './Aplazar.tsx';
import { AvatarDeAutor } from './AvatarDeAutor.tsx';
import { Medio } from './Medio.tsx';
import estilos from './Hilo.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  /** Si la ficha del contacto esta a la vista; el boton la alterna. */
  fichaAbierta: boolean;
  alAlternarFicha: () => void;
  /** Cambia cuando llega un evento en vivo de ESTA conversación: toca recargar. */
  senalDeRecarga?: number;
  /** Volver a la lista. Solo se ve en movil, donde no caben las dos. */
  alVolver: () => void;
  alCambiar: () => void;
}

/** Respaldo: con eventos en vivo ya no hace falta preguntar cada 5 segundos. */
const CADA_MS = 30_000;
const CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
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
  senalDeRecarga,
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

  /*
    Abrir el hilo es leerlo, como en cualquier mensajería: el globo de sin
    leer se apaga aunque no se conteste. Antes solo lo apagaba enviar un
    mensaje, así que quien leía y decidía no responder se quedaba el aviso
    encima para siempre.

    Solo se llama si hay algo que apagar: esta pantalla recarga cada 30
    segundos y una escritura por vuelta no compraría nada.
  */
  const noLeidos = conversacion.noLeidos;
  useEffect(() => {
    if (noLeidos === 0) return;
    api
      .marcarLeida(conversacion.id)
      .then(alCambiar)
      // Que falle no debe estropear la lectura: el hilo ya está en pantalla y
      // el globo se apagará al siguiente intento.
      .catch(() => undefined);
  }, [api, conversacion.id, noLeidos, alCambiar]);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => void cargar(), CADA_MS);
    const reloj = setInterval(() => setTic((t) => t + 1), 30_000);
    return () => {
      clearInterval(id);
      clearInterval(reloj);
    };
  }, [cargar]);

  // Un evento en vivo de esta conversación: se recarga al momento.
  useEffect(() => {
    if (senalDeRecarga) void cargar();
  }, [senalDeRecarga, cargar]);

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
        <Aplazar
          api={api}
          conversacionId={conversacion.id}
          aplazadaHasta={conversacion.aplazadaHasta}
          alCambiar={alCambiar}
        />
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

      {/*
        El motivo, entero y debajo de la cabecera: en la fila solo cabía la
        insignia. Es `role="status"` y no `alert` porque informa de algo que ya
        pasó; un `alert` interrumpiría al agente cada vez que abre el hilo.
      */}
      {conversacion.relevo && (
        <p className={estilos.relevo} role="status">
          <strong className={estilos.relevoTitulo}>El bot pidió una persona:</strong>{' '}
          {conversacion.relevo.motivo}
        </p>
      )}

      <div className={estilos.mensajes} role="log" aria-live="polite" aria-busy={cargando}>
        {!cargando && mensajes.length === 0 && (
          <p className={estilos.sinMensajes}>Todavía no hay mensajes.</p>
        )}
        {/*
          Un bloque por día, y no una lista plana con separadores sueltos.
          Los separadores son `sticky`: si todos cuelgan del mismo padre se
          pegan al MISMO borde y se apilan unos encima de otros — se leía
          «Martes, 1 Ayer tiembre». Dentro de su propio bloque, cada uno se
          queda arriba mientras dura su día y el siguiente lo empuja fuera,
          que es como se comporta esto en cualquier mensajería.
        */}
        {porDias(mensajes).map(({ dia, delDia }) => (
          <section key={dia} className={estilos.bloqueDeDia}>
            <div className={estilos.dia}>
              <span className={estilos.diaTexto}>{dia}</span>
            </div>
            {delDia.map((m, i) => {
              const anterior = delDia[i - 1];
              return (
                <Burbuja
                  key={m.id}
                  m={m}
                  api={api}
                  /*
                    Se agrupa por dirección Y por quién escribe: si contestan
                    dos personas seguidas, agrupar escondería el nombre de la
                    segunda y el hilo diría que habló una sola.
                  */
                  agrupado={
                    anterior !== undefined &&
                    anterior.direccion === m.direccion &&
                    autorDe(anterior) === autorDe(m)
                  }
                />
              );
            })}
          </section>
        ))}
        <div ref={fondo} />
      </div>

      <Cierre api={api} conversacion={conversacion} alCambiar={alCambiar} />

      {conversacion.tipo === 'comment_thread' ? (
        <CompositorDeComentario
          api={api}
          conversacion={conversacion}
          mensajes={mensajes}
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

/** Parte los mensajes en bloques por día, conservando el orden. */
function porDias(mensajes: Mensaje[]): { dia: string; delDia: Mensaje[] }[] {
  const bloques: { dia: string; delDia: Mensaje[] }[] = [];
  for (const m of mensajes) {
    const dia = diaDeMensaje(m.creado_en);
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.dia === dia) ultimo.delDia.push(m);
    else bloques.push({ dia, delDia: [m] });
  }
  return bloques;
}

/**
 * Quién lo dijo, en una palabra.
 *
 * Solo para lo que SALE: quién escribió del lado del hotel es la pregunta
 * diaria de un equipo —«¿quién le dijo eso al cliente?»— y hasta ahora el dato
 * se guardaba y no se enseñaba. De lo que entra ya se sabe: el contacto, que
 * está en la cabecera.
 */
function autorDe(m: Mensaje): string | null {
  if (m.direccion !== 'outbound') return null;
  if (m.origen === 'bot') return 'Bot';
  // Una persona borrada del equipo deja su mensaje, pero ya no su nombre: se
  // dice «un agente» en vez de fingir que no lo escribió nadie.
  if (m.origen === 'human') return m.autor ?? 'Un agente';
  return null;
}

function Burbuja({ m, api, agrupado }: { m: Mensaje; api: Api; agrupado: boolean }) {
  const saliente = m.direccion === 'outbound';
  const autor = autorDe(m);
  /*
    La cara solo en la primera de una tanda y solo en lo que sale: repetirla
    en seis burbujas seguidas es ruido, y de lo que entra ya hay avatar en la
    cabecera del hilo.
  */
  const conCara = saliente && autor !== null && !agrupado;
  return (
    <div className={`${estilos.fila} ${saliente ? estilos.filaSaliente : estilos.filaEntrante}`}>
      <article
        className={`${estilos.burbuja} ${saliente ? estilos.saliente : estilos.entrante} ${agrupado ? estilos.agrupado : ''} ${m.estado === 'failed' ? estilos.fallido : ''}`}
      >
        {m.medio_id && (
          <Medio
            api={api}
            tipo={m.tipo}
            medioId={m.medio_id}
            estado={m.medio_estado}
            nombre={m.medio_nombre}
          />
        )}
        {m.tipo === 'template' && <span className={estilos.tipo}>Plantilla</span>}
        {m.texto && <p className={estilos.texto}>{m.texto}</p>}
        <footer className={estilos.meta}>
          {/*
          Solo en el primero de una tanda: repetir «Marta» en seis burbujas
          seguidas es ruido, y el agrupado ya dice que son del mismo.
        */}
          {autor && !agrupado && <span className={estilos.autor}>{autor}</span>}
          <time dateTime={m.creado_en}>{horaDeMensaje(m.creado_en)}</time>
          {m.generado_por_ia && (
            <span className={estilos.ia} title="Redactado con IA y revisado por una persona">
              IA
            </span>
          )}
          {saliente && (
            <span className={estilos.estado}>
              {m.estado === 'failed' && m.error?.mensaje
                ? `No se envió: ${m.error.mensaje}`
                : (ESTADO_MENSAJE[m.estado] ?? m.estado)}
            </span>
          )}
        </footer>
      </article>
      {conCara && <AvatarDeAutor api={api} nombre={autor} fotoId={m.autor_foto_id} />}
    </div>
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

/**
 * Las dos formas de quitarse una conversación de encima.
 *
 * Están aquí, justo encima del compositor, porque es el momento en que se
 * decide: se acaba de leer el hilo y hay que hacer algo con él. En un menú
 * escondido nadie las usaría, y la bandeja seguiría llena de conversaciones
 * viejas que ya nadie va a contestar.
 *
 * ## Las dos no son lo mismo, y la diferencia importa
 *
 * - **Poner en espera**: sale de pendientes y **el bot se calla**. Si el
 *   cliente vuelve a escribir, el mensaje se ve —no se esconde a nadie—, pero
 *   nadie automático le contesta. Es para el cliente al que se decidió no
 *   atender por ahora.
 * - **Marcar resuelto**: esto terminó. Si vuelve a escribir, empieza de cero
 *   y **el bot puede atenderle** como a cualquiera.
 *
 * Antes solo existía cerrar, y quitarse de encima a un cliente difícil
 * significaba que el bot le saludara al día siguiente.
 */
function Cierre({
  api,
  conversacion,
  alCambiar,
}: {
  api: Api;
  conversacion: ResumenDeConversacion;
  alCambiar: () => void;
}) {
  const [ocupado, setOcupado] = useState<'espera' | 'resuelto' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cerrada = conversacion.estado === 'closed';

  async function hacer(cual: 'espera' | 'resuelto', accion: () => Promise<unknown>) {
    setOcupado(cual);
    setError(null);
    try {
      await accion();
      alCambiar();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo. Reintenta.');
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className={estilos.cierre}>
      <button
        className={`${estilos.accion} ${conversacion.enEspera ? estilos.accionActiva : ''}`}
        disabled={ocupado !== null}
        /* El título explica la consecuencia, que es lo que no se ve. */
        title={
          conversacion.enEspera
            ? 'Quitar la espera: el bot volverá a poder contestarle'
            : 'Sale de pendientes y el bot deja de contestarle'
        }
        onClick={() =>
          void hacer('espera', () => api.ponerEnEspera(conversacion.id, !conversacion.enEspera))
        }
      >
        {conversacion.enEspera ? 'Quitar de espera' : 'Poner en espera'}
      </button>

      {!cerrada && (
        <button
          className={estilos.accion}
          disabled={ocupado !== null}
          title="Se da por terminada. Si vuelve a escribir, el bot podrá atenderle"
          onClick={() => void hacer('resuelto', () => api.cambiarEstado(conversacion.id, 'closed'))}
        >
          Marcar resuelto
        </button>
      )}

      {conversacion.enEspera && (
        <span className={estilos.nota}>El bot no le contesta mientras esté en espera.</span>
      )}
      {error && (
        <span className={estilos.errorCierre} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
