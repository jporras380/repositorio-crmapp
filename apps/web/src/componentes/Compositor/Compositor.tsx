import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { PlantillaSugerida, RespuestaRapida, ResumenDeConversacion } from '../../api/tipos.ts';
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
  const area = useRef<HTMLTextAreaElement>(null);
  const archivo = useRef<HTMLInputElement>(null);

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
    void intentar(() => api.enviar(conversacion.id, { tipo: 'text', texto: t }));
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

  async function adjuntar(f: File) {
    setSubiendo(true);
    try {
      await intentar(async () => {
        const { mediaAssetId, urlDeSubida } = await api.prepararSubida(f.type, f.size, f.name);
        const r = await fetch(urlDeSubida, {
          method: 'PUT',
          body: f,
          headers: { 'content-type': f.type },
        });
        if (!r.ok) throw new Error('subida');
        await api.confirmarSubida(mediaAssetId);
        const tipo = f.type.startsWith('image/')
          ? 'image'
          : f.type.startsWith('video/')
            ? 'video'
            : f.type.startsWith('audio/')
              ? 'audio'
              : 'document';
        const pie = texto.trim();
        await api.enviar(conversacion.id, {
          tipo,
          mediaAssetId,
          ...(pie ? { pieDeFoto: pie } : {}),
        });
      });
    } finally {
      setSubiendo(false);
      if (archivo.current) archivo.current.value = '';
    }
  }

  function teclas(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (coincidencias.length === 1 && buscandoRapida) enviarRapida(coincidencias[0]!);
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

      <div className={estilos.caja}>
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
          accept="image/*,video/mp4,audio/*,application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void adjuntar(f);
          }}
        />
        <textarea
          ref={area}
          className={estilos.area}
          rows={1}
          placeholder="Escribe un mensaje. «/» para respuestas rápidas."
          value={texto}
          disabled={enviando}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={teclas}
          aria-label="Mensaje"
        />
        <button
          type="button"
          className={estilos.enviar}
          onClick={enviarTexto}
          disabled={enviando || subiendo || !texto.trim()}
        >
          {subiendo ? 'Subiendo…' : enviando ? 'Enviando…' : 'Enviar'}
        </button>
      </div>
    </div>
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
