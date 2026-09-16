import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type {
  LimitesDeMedios,
  PlantillaSugerida,
  RespuestaRapida,
  ResumenDeConversacion,
} from '../../api/tipos.ts';
import {
  Adjuntos,
  problemaDelArchivo,
  tipoDeArchivo,
  useObjectUrls,
  type Adjunto,
} from './Adjuntos.tsx';
import { Emojis } from './Emojis.tsx';
import estilos from './Compositor.module.css';

interface Props {
  api: Api;
  conversacion: ResumenDeConversacion;
  alEnviado: () => void;
}

/**
 * El compositor no sabe si la ventana está abierta ni qué permite el plan:
 * envía, y si la API dice que no, pinta el motivo y lo que sí se puede hacer
 * (las plantillas sugeridas vienen en el 409). Ninguna regla vive aquí.
 */
export function Compositor({ api, conversacion, alEnviado }: Props) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sugeridas, setSugeridas] = useState<PlantillaSugerida[]>([]);
  const [rapidas, setRapidas] = useState<RespuestaRapida[] | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  /** Archivos elegidos y todavía no enviados. Elegir ya NO envía. */
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [subiendoId, setSubiendoId] = useState<string | null>(null);
  const [limites, setLimites] = useState<LimitesDeMedios | null>(null);
  const [emojis, setEmojis] = useState(false);
  const [iaActiva, setIaActiva] = useState(false);
  const [sugiriendo, setSugiriendo] = useState(false);
  /**
   * El texto del área salió de la IA. Se mantiene aunque el agente lo edite:
   * el mensaje sigue siendo un borrador de la IA revisado por una persona.
   * Se pierde al vaciar el área o al enviar.
   */
  const [deIa, setDeIa] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const archivo = useRef<HTMLInputElement>(null);

  useObjectUrls(adjuntos);

  useEffect(() => {
    let vigente = true;
    // Si falla, se sigue pudiendo adjuntar: el servidor valida igual, solo se
    // pierde el aviso temprano.
    api
      .limitesDeMedios()
      .then((l) => vigente && setLimites(l))
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [api]);

  useEffect(() => {
    let vigente = true;
    api
      .iaAjustes()
      .then((a) => vigente && setIaActiva(a.activa))
      .catch(() => vigente && setIaActiva(false));
    return () => {
      vigente = false;
    };
  }, [api]);

  async function sugerir() {
    setSugiriendo(true);
    setError(null);
    try {
      const { texto: borrador } = await api.sugerirRespuesta(conversacion.id);
      setTexto(borrador);
      setDeIa(true);
      area.current?.focus();
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo pedir la sugerencia.');
    } finally {
      setSugiriendo(false);
    }
  }

  const buscandoRapida = texto.startsWith('/');
  useEffect(() => {
    if (buscandoRapida && rapidas === null) {
      api
        .respuestasRapidas()
        .then(setRapidas)
        .catch(() => setRapidas([]));
    }
  }, [buscandoRapida, rapidas, api]);

  const coincidencias = buscandoRapida
    ? (rapidas ?? []).filter((r) => r.atajo.startsWith(texto.trim().toLowerCase())).slice(0, 6)
    : [];

  async function intentar(fn: () => Promise<unknown>) {
    setEnviando(true);
    setError(null);
    try {
      await fn();
      setTexto('');
      setDeIa(false);
      setSugeridas([]);
      alEnviado();
      area.current?.focus();
    } catch (e) {
      if (e instanceof ErrorDeApi) {
        setError(e.message);
        const s = e.detalle['plantillasSugeridas'];
        setSugeridas(
          e.codigo === 'fuera_de_ventana' && Array.isArray(s) ? (s as PlantillaSugerida[]) : [],
        );
      } else {
        setError('No se pudo enviar. Revisa tu conexión.');
      }
    } finally {
      setEnviando(false);
    }
  }

  const enviarTexto = () => {
    const t = texto.trim();
    if (!t || enviando) return;
    void intentar(() =>
      api.enviar(conversacion.id, {
        tipo: 'text',
        texto: t,
        ...(deIa ? { generadoPorIa: true } : {}),
      }),
    );
  };
  const enviarPlantilla = (p: PlantillaSugerida) =>
    void intentar(() =>
      api.enviar(conversacion.id, {
        tipo: 'template',
        nombre: p.nombre,
        idioma: p.idioma,
        parametros: [],
      }),
    );
  const enviarRapida = (r: RespuestaRapida) =>
    void intentar(() => api.enviar(conversacion.id, { tipo: 'quick_reply', quickReplyId: r.id }));

  /** Elegir archivos los pone en la bandeja. No envía nada. */
  function elegir(archivos: FileList) {
    const nuevos: Adjunto[] = [...archivos].map((f) => ({
      id: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
      archivo: f,
      vista: URL.createObjectURL(f),
      tipo: tipoDeArchivo(f.type),
      problema: problemaDelArchivo(f, conversacion.canal, limites),
    }));
    setAdjuntos((a) => [...a, ...nuevos]);
    setError(null);
    if (archivo.current) archivo.current.value = '';
  }

  function quitar(id: string) {
    setAdjuntos((a) => {
      const fuera = a.find((x) => x.id === id);
      if (fuera) URL.revokeObjectURL(fuera.vista);
      return a.filter((x) => x.id !== id);
    });
  }

  /** Sube uno y lo envía. Devuelve el id del medio ya enviado. */
  async function enviarAdjunto(a: Adjunto, pie: string) {
    const { mediaAssetId, urlDeSubida } = await api.prepararSubida(
      a.archivo.type,
      a.archivo.size,
      a.archivo.name,
    );
    const r = await fetch(urlDeSubida, {
      method: 'PUT',
      body: a.archivo,
      headers: { 'content-type': a.archivo.type },
    });
    if (!r.ok) throw new Error('subida');
    await api.confirmarSubida(mediaAssetId);
    await api.enviar(conversacion.id, {
      tipo: a.tipo,
      mediaAssetId,
      ...(pie ? { pieDeFoto: pie } : {}),
    });
  }

  /**
   * Manda la tanda en orden, uno por uno.
   *
   * De uno en uno y no en paralelo a propósito: el orden en que los ve el
   * cliente es el orden en que se eligieron, y tres subidas a la vez por una
   * red móvil tardan más que tres seguidas.
   *
   * El pie va **solo en el primero**, como hace WhatsApp con una tanda;
   * repetirlo sería el mismo texto tres veces.
   *
   * Si uno falla, los que ya salieron NO se deshacen —un mensaje enviado no se
   * puede retirar— y los que faltan se quedan en la bandeja con el error a la
   * vista, para reintentar solo esos.
   */
  async function enviarAdjuntos() {
    if (adjuntos.some((a) => a.problema)) {
      setError('Quita los archivos marcados en rojo para poder enviar.');
      return;
    }
    setSubiendo(true);
    setError(null);
    let pie = texto.trim();
    try {
      for (const a of adjuntos) {
        setSubiendoId(a.id);
        await enviarAdjunto(a, pie);
        pie = '';
        quitar(a.id);
        alEnviado();
      }
      setTexto('');
      setDeIa(false);
      area.current?.focus();
    } catch (e) {
      setError(
        e instanceof ErrorDeApi ? e.message : 'No se pudo enviar el archivo. Revisa tu conexión.',
      );
    } finally {
      setSubiendoId(null);
      setSubiendo(false);
    }
  }

  /**
   * Mete el emoji donde está el cursor, no al final. Escribir «Gracias» y que
   * el emoji aparezca pegado a la primera letra es lo que hace que estos
   * paneles acaben sin usarse.
   */
  function ponerEmoji(emoji: string) {
    const caja = area.current;
    const inicio = caja?.selectionStart ?? texto.length;
    const fin = caja?.selectionEnd ?? texto.length;
    const nuevo = texto.slice(0, inicio) + emoji + texto.slice(fin);
    setTexto(nuevo);
    // El foco vuelve al área con el cursor detrás del emoji, para poder seguir
    // escribiendo sin tocar el ratón.
    requestAnimationFrame(() => {
      caja?.focus();
      caja?.setSelectionRange(inicio + emoji.length, inicio + emoji.length);
    });
  }

  function teclas(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (coincidencias.length === 1 && buscandoRapida) enviarRapida(coincidencias[0]!);
      // Con archivos en la bandeja, Enter manda la tanda: el área es su pie.
      else if (adjuntos.length > 0) void enviarAdjuntos();
      else enviarTexto();
    }
  }

  return (
    <div className={estilos.compositor}>
      {coincidencias.length > 0 && (
        <ul className={estilos.rapidas} role="listbox" aria-label="Respuestas rápidas">
          {coincidencias.map((r) => (
            <li key={r.id}>
              <button type="button" className={estilos.rapida} onClick={() => enviarRapida(r)}>
                <span className={estilos.atajo}>{r.atajo}</span>
                <span className={estilos.rapidaTitulo}>{r.titulo}</span>
                <span className={estilos.rapidaCuerpo}>{r.cuerpo}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className={estilos.aviso} role="alert">
          <p>{error}</p>
          {sugeridas.length > 0 && (
            <div className={estilos.sugeridas}>
              {sugeridas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={estilos.sugerida}
                  onClick={() => enviarPlantilla(p)}
                  disabled={enviando}
                >
                  Enviar «{p.nombre}» ({p.idioma})
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {deIa && texto.trim() && (
        <p className={estilos.borradorIa}>
          Borrador de la IA: revísalo antes de enviar. Quedará marcado como redactado con IA.
        </p>
      )}

      {emojis && <Emojis alElegir={ponerEmoji} alCerrar={() => setEmojis(false)} />}

      <Adjuntos adjuntos={adjuntos} subiendoId={subiendoId} alQuitar={quitar} />

      <div className={`${estilos.caja} ${iaActiva ? estilos.cajaConIa : ''}`}>
        <button
          type="button"
          className={estilos.icono}
          title="Adjuntar archivo"
          onClick={() => archivo.current?.click()}
          disabled={enviando || subiendo}
        >
          <IconoClip />
          <span className="visually-hidden">Adjuntar archivo</span>
        </button>
        <input
          ref={archivo}
          type="file"
          className="visually-hidden"
          multiple
          /*
            `video/*` y no `video/mp4`: un vídeo del iPhone es `quicktime` y
            con el filtro estrecho aparecía en gris, sin explicación. Ahora se
            puede elegir y la ficha dice que hay que convertirlo a MP4.
          */
          accept="image/*,video/*,audio/*,application/pdf"
          onChange={(e) => {
            if (e.target.files?.length) elegir(e.target.files);
          }}
        />
        <textarea
          ref={area}
          className={estilos.area}
          rows={1}
          placeholder={
            adjuntos.length > 0
              ? 'Pie de foto (opcional). Va solo en el primero.'
              : 'Escribe un mensaje. «/» para respuestas rápidas.'
          }
          value={texto}
          disabled={enviando}
          onChange={(e) => {
            setTexto(e.target.value);
            if (!e.target.value.trim()) setDeIa(false);
          }}
          onKeyDown={teclas}
          aria-label="Mensaje"
        />
        <button
          type="button"
          className={estilos.icono}
          title="Emojis"
          aria-expanded={emojis}
          onClick={() => setEmojis((v) => !v)}
          disabled={enviando || subiendo}
        >
          <span aria-hidden="true" className={estilos.caraEmoji}>
            🙂
          </span>
          <span className="visually-hidden">Emojis</span>
        </button>
        {iaActiva && (
          <button
            type="button"
            className={estilos.icono}
            title="Sugerir respuesta con IA"
            onClick={() => void sugerir()}
            disabled={enviando || subiendo || sugiriendo}
            aria-busy={sugiriendo}
          >
            {sugiriendo ? <span className={estilos.pensando} aria-hidden="true" /> : <IconoIa />}
            <span className="visually-hidden">
              {sugiriendo ? 'Redactando sugerencia…' : 'Sugerir respuesta con IA'}
            </span>
          </button>
        )}
        <button
          type="button"
          className={estilos.enviar}
          onClick={adjuntos.length > 0 ? () => void enviarAdjuntos() : enviarTexto}
          disabled={enviando || subiendo || (adjuntos.length === 0 && !texto.trim())}
        >
          {subiendo
            ? `Enviando ${adjuntos.length > 1 ? `(${adjuntos.length})` : ''}…`
            : enviando
              ? 'Enviando…'
              : adjuntos.length > 1
                ? `Enviar ${adjuntos.length}`
                : 'Enviar'}
        </button>
      </div>
    </div>
  );
}

function IconoIa() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9 12 3.5ZM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconoClip() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 11.5 11.6 20a5 5 0 0 1-7-7l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7L9.3 17.7a1.7 1.7 0 0 1-2.4-2.4L14.8 7.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
