import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { MensajeDeSoporte } from '../../api/tipos.ts';
import { horaDeMensaje, diaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './ChatDeSoporte.module.css';

/**
 * Hablar con soporte técnico desde dentro del CRM.
 *
 * ## Qué reemplaza
 *
 * Escribir por WhatsApp a un número personal. Eso pierde el historial, deja a
 * todo el mundo sin saber qué se respondió, y hace que quien atiende no tenga
 * delante ni el plan ni el estado de los canales de esa cuenta. Aquí está
 * donde ya se está trabajando, y quien contesta ve la cuenta al lado.
 *
 * ## Por qué cualquiera del equipo puede escribir
 *
 * El que se topa con el problema es quien lo cuenta. Obligar a avisar al dueño
 * para poder reportarlo solo garantiza que no se reporte.
 *
 * ## Por qué abrir el hilo SÍ lo marca como leído
 *
 * Es lo contrario de la bandeja, y a propósito: allí «leído» es una decisión
 * sobre el trabajo de un equipo, y aquí es tu propia conversación con quien
 * te vende el producto. No hay nada que decidir.
 *
 * ## Por qué adjunta el cliente y no soporte (0044)
 *
 * «No me sale el botón» y una captura del botón que no sale son la misma
 * frase, pero solo una se entiende a la primera. Quien tiene el problema
 * delante es el cliente, así que el botón de adjuntar es suyo.
 *
 * Soporte responde solo con texto. No es una limitación técnica sino la
 * misma línea de siempre: cuanto menos escriba soporte en la cuenta de un
 * cliente, menos hay que explicar después.
 */

interface Props {
  api: Api;
  /** Una cuenta concreta: lo usa la consola del operador para responder. */
  tenantId?: string | undefined;
}

/** Lo que sirve para enseñar un problema: una captura o un vídeo corto. */
const ADJUNTOS = 'image/jpeg,image/png,image/webp,video/mp4';

export function ChatDeSoporte({ api, tenantId }: Props) {
  const [mensajes, setMensajes] = useState<MensajeDeSoporte[] | null>(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjunto, setAdjunto] = useState<{ id: string; nombre: string } | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const fondo = useRef<HTMLDivElement>(null);
  const archivo = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    try {
      setMensajes(tenantId ? await api.hiloDeSoporteDe(tenantId) : await api.mensajesDeSoporte());
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo cargar la conversación.');
    }
  }, [api, tenantId]);
  useEffect(() => void cargar(), [cargar]);

  // Al fondo, como cualquier chat: lo último es lo que importa.
  useEffect(() => {
    fondo.current?.scrollIntoView({ block: 'end' });
  }, [mensajes]);

  /**
   * Sube la captura al elegirla, no al enviar.
   *
   * Un vídeo de 8 MB por datos móviles convierte «Enviar» en un botón que
   * parece colgado. Así se ve que ya está adjunto, y enviar es inmediato.
   */
  async function subir(f: File) {
    setSubiendo(true);
    setError(null);
    try {
      const { mediaAssetId, urlDeSubida } = await api.prepararSubida(f.type, f.size, f.name);
      const r = await fetch(urlDeSubida, {
        method: 'PUT',
        body: f,
        headers: { 'content-type': f.type },
      });
      if (!r.ok) throw new Error('subida');
      await api.confirmarSubida(mediaAssetId);
      setAdjunto({ id: mediaAssetId, nombre: f.name });
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo subir el archivo.');
    } finally {
      setSubiendo(false);
      if (archivo.current) archivo.current.value = '';
    }
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const cuerpo = texto.trim();
    // Con captura, el texto sobra: la imagen ya dice algo.
    if (!cuerpo && !adjunto) return;
    setEnviando(true);
    setError(null);
    try {
      setMensajes(
        tenantId
          ? await api.responderASoporte(tenantId, cuerpo)
          : await api.escribirASoporte(cuerpo, adjunto?.id),
      );
      setTexto('');
      setAdjunto(null);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo enviar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className={estilos.chat}>
      <div className={estilos.hilo} role="log" aria-label="Conversación con soporte">
        {mensajes?.length === 0 && (
          <p className={estilos.vacio}>
            {tenantId
              ? 'Esta cuenta no ha escrito todavía.'
              : 'Cuéntanos qué te pasa y te respondemos por aquí.'}
          </p>
        )}
        {(mensajes ?? []).map((m, i) => {
          const anterior = mensajes![i - 1];
          const dia = diaDeMensaje(m.creadoEn);
          return (
            <div key={m.id}>
              {/* El día solo cuando cambia: en un hilo que dura semanas, sin
                  esto no se sabe si algo se dijo ayer o en marzo. */}
              {(!anterior || diaDeMensaje(anterior.creadoEn) !== dia) && (
                <p className={estilos.dia}>{dia}</p>
              )}
              <Burbuja
                api={api}
                m={m}
                propio={tenantId ? m.deLaPlataforma : !m.deLaPlataforma}
                tenantId={tenantId}
              />
            </div>
          );
        })}
        <div ref={fondo} />
      </div>

      {error && (
        <p className={estilos.error} role="alert">
          {error}
        </p>
      )}

      {/* Lo que va a salir con el mensaje, antes de enviarlo: un adjunto que
          no se ve hasta después es un adjunto que se manda sin querer. */}
      {adjunto && (
        <p className={estilos.adjunto}>
          <span className={estilos.adjuntoNombre}>{adjunto.nombre}</span>
          <button
            type="button"
            className={estilos.quitar}
            onClick={() => setAdjunto(null)}
            aria-label={`Quitar ${adjunto.nombre}`}
          >
            Quitar
          </button>
        </p>
      )}

      <form className={estilos.compositor} onSubmit={enviar}>
        <label className="visually-hidden" htmlFor="mensaje-de-soporte">
          Mensaje para soporte
        </label>
        <textarea
          id="mensaje-de-soporte"
          className={estilos.entrada}
          rows={2}
          maxLength={4000}
          value={texto}
          placeholder={tenantId ? 'Responder…' : 'Escribe qué te pasa…'}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            // Enter envía; Mayús+Enter salta de línea. Es lo que hace el
            // teclado de cualquiera que use esto todo el día.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar(e as unknown as FormEvent);
            }
          }}
        />
        {/* Solo el cliente adjunta: el problema lo tiene él delante. */}
        {!tenantId && (
          <>
            <input
              ref={archivo}
              type="file"
              id="adjunto-de-soporte"
              className="visually-hidden"
              accept={ADJUNTOS}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void subir(f);
              }}
            />
            <label htmlFor="adjunto-de-soporte" className={estilos.adjuntar}>
              {subiendo ? 'Subiendo…' : 'Adjuntar'}
            </label>
          </>
        )}
        <button
          type="submit"
          className={estilos.enviar}
          disabled={enviando || subiendo || (!texto.trim() && !adjunto)}
        >
          {enviando ? 'Enviando…' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}

function Burbuja({
  api,
  m,
  propio,
  tenantId,
}: {
  api: Api;
  m: MensajeDeSoporte;
  propio: boolean;
  tenantId?: string | undefined;
}) {
  return (
    <div className={`${estilos.fila} ${propio ? estilos.filaPropia : ''}`}>
      <div className={`${estilos.burbuja} ${propio ? estilos.burbujaPropia : ''}`}>
        {/* Quién lo escribió: en una cuenta con varios agentes, «alguien dijo»
            no sirve para entender qué pasó. */}
        <p className={estilos.autor}>
          {m.deLaPlataforma ? `${m.autor ?? 'Soporte'} · soporte` : (m.autor ?? 'Tu equipo')}
        </p>
        {m.medioId && <Adjunto api={api} m={m} tenantId={tenantId} />}
        {m.cuerpo && <p className={estilos.cuerpo}>{m.cuerpo}</p>}
        <p className={estilos.hora}>{horaDeMensaje(m.creadoEn)}</p>
      </div>
    </div>
  );
}

/**
 * La captura de un mensaje.
 *
 * La URL se pide al pintar y caduca a los cinco minutos, así que no se puede
 * guardar en el mensaje ni reenviar por ahí. Cada lado la pide por su camino:
 * el cliente con `urlDeMedio` —su propio medio, RLS lo resuelve—, y la consola
 * con `adjuntoDeSoporte`, que solo firma lo que cuelga de este hilo.
 */
function Adjunto({
  api,
  m,
  tenantId,
}: {
  api: Api;
  m: MensajeDeSoporte;
  tenantId?: string | undefined;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    let vivo = true;
    const id = m.medioId;
    if (!id) return;
    void (async () => {
      try {
        const r = tenantId ? await api.adjuntoDeSoporte(tenantId, id) : await api.urlDeMedio(id);
        if (vivo) setUrl(r.url);
      } catch {
        if (vivo) setFallo(true);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [api, m.medioId, tenantId]);

  const nombre = m.medioNombre ?? 'Captura';
  if (fallo) return <p className={estilos.adjuntoRoto}>No se pudo abrir «{nombre}».</p>;
  if (!url) return <p className={estilos.adjuntoRoto}>Cargando «{nombre}»…</p>;

  return m.medioMime?.startsWith('video/') ? (
    // `controls` y nada más: un vídeo que arranca solo en una pantalla de
    // ajustes es ruido, y aquí puede sonar en una recepción.
    <video className={estilos.medio} src={url} controls preload="metadata" />
  ) : (
    <a href={url} target="_blank" rel="noreferrer">
      <img className={estilos.medio} src={url} alt={nombre} />
    </a>
  );
}
