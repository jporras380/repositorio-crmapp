import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { RespuestaRapida } from '../../api/tipos.ts';
import { useListaFiltrable, type ListaFiltrada } from '../../vista/listaFiltrable.ts';
import { BarraDeFiltro, ContadorYPaginas } from './FiltroDeLista.tsx';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

export function RespuestasRapidas({ api, gestor }: Props) {
  const [lista, setLista] = useState<RespuestaRapida[] | null>(null);
  const [editando, setEditando] = useState<RespuestaRapida | 'nueva' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setLista(await api.respuestasRapidas());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function archivar(r: RespuestaRapida) {
    if (!confirm(`¿Archivar ${r.atajo}? Los mensajes ya enviados no cambian.`)) return;
    try {
      await api.archivarRapida(r.id);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo archivar.');
    }
  }

  /*
    Se busca por atajo, título Y texto. Quien se acuerda de «Trujillo» está
    pensando en lo que dice la respuesta, no en cómo la llamó hace tres meses.
  */
  const filtrada = useListaFiltrable(
    lista,
    (r) => [r.atajo, r.titulo, r.cuerpo],
    (r) => r.actualizadoEn,
  );

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Respuestas rápidas</h2>
          <p className={estilos.descripcion}>
            Textos que el equipo repite. En el compositor se escriben con «/» y el atajo. Solo salen
            con la ventana abierta: para escribir primero, usa una plantilla.
          </p>
        </div>
        {gestor && editando === null && (
          <button className={estilos.primario} onClick={() => setEditando('nueva')}>
            Nueva respuesta
          </button>
        )}
      </header>

      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {editando !== null && (
        <Formulario
          api={api}
          inicial={editando === 'nueva' ? null : editando}
          alCancelar={() => setEditando(null)}
          alGuardar={async () => {
            setEditando(null);
            await cargar();
          }}
        />
      )}

      {lista && lista.length === 0 && editando === null && (
        <p className={estilos.vacio}>Todavía no hay respuestas rápidas.</p>
      )}

      {lista && lista.length > 0 && (
        <BarraDeFiltro
          lista={filtrada as ListaFiltrada<unknown>}
          nombre={{ uno: 'respuesta', varios: 'respuestas' }}
          ejemplo="Buscar por atajo, título o texto…"
        />
      )}

      {/* Distinto de «todavía no hay»: aquí sí hay, y el filtro las esconde. */}
      {filtrada.total > 0 && filtrada.encontrados === 0 && (
        <p className={estilos.vacio}>Ninguna respuesta coincide con lo que buscas.</p>
      )}

      <div className={estilos.tarjetas}>
        {filtrada.visibles.map((r) => (
          <article key={r.id} className={estilos.tarjeta}>
            <span className={estilos.estado}>{r.atajo}</span>
            <div>
              <p className={estilos.tarjetaTitulo}>{r.titulo}</p>
              <p className={estilos.tarjetaDetalle}>
                {r.cuerpo || '(sin texto)'}
                {r.medioId ? ' · con adjunto' : ''} · v{r.version}
              </p>
            </div>
            {gestor && (
              <div className={estilos.acciones}>
                <button className={estilos.secundario} onClick={() => setEditando(r)}>
                  Editar
                </button>
                <button className={estilos.peligro} onClick={() => void archivar(r)}>
                  Archivar
                </button>
              </div>
            )}
          </article>
        ))}
      </div>

      {lista && lista.length > 0 && (
        <ContadorYPaginas
          lista={filtrada as ListaFiltrada<unknown>}
          nombre={{ uno: 'respuesta', varios: 'respuestas' }}
        />
      )}
    </section>
  );
}

function Formulario({
  api,
  inicial,
  alCancelar,
  alGuardar,
}: {
  api: Api;
  inicial: RespuestaRapida | null;
  alCancelar: () => void;
  alGuardar: () => Promise<void>;
}) {
  const [atajo, setAtajo] = useState(inicial?.atajo ?? '/');
  const [titulo, setTitulo] = useState(inicial?.titulo ?? '');
  const [cuerpo, setCuerpo] = useState(inicial?.cuerpo ?? '');
  const [medioId, setMedioId] = useState<string | null>(inicial?.medioId ?? null);
  const [vista, setVista] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const archivo = useRef<HTMLInputElement>(null);

  // La miniatura se pide aparte: los medios son privados y la URL se firma
  // para unos minutos, así que no puede guardarse en la respuesta.
  useEffect(() => {
    if (!medioId) {
      setVista(null);
      return;
    }
    let vivo = true;
    api
      .urlDeMedio(medioId)
      .then((m) => vivo && setVista(m.url))
      .catch(() => vivo && setVista(null));
    return () => {
      vivo = false;
    };
  }, [api, medioId]);

  /**
   * La imagen se sube ANTES de guardar la respuesta.
   *
   * Podría subirse al pulsar «Guardar», pero entonces una foto de 4 MB por
   * datos móviles parecería un formulario colgado. Así se ve la miniatura en
   * cuanto está, y guardar es instantáneo.
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
      setMedioId(mediaAssetId);
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo subir la imagen.');
    } finally {
      setSubiendo(false);
      if (archivo.current) archivo.current.value = '';
    }
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      // `null` quita el adjunto y `undefined` lo deja como estaba: el servicio
      // distingue las dos cosas, y aquí siempre se manda lo que hay en
      // pantalla, que es lo que la persona acaba de ver.
      if (inicial)
        await api.editarRapida(inicial.id, { atajo, titulo, cuerpo, mediaAssetId: medioId });
      else
        await api.crearRapida({
          atajo,
          titulo,
          cuerpo,
          ...(medioId ? { mediaAssetId: medioId } : {}),
        });
      await alGuardar();
    } catch (err) {
      setError(err instanceof ErrorDeApi ? err.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className={estilos.formulario} onSubmit={guardar}>
      <div className={estilos.campos}>
        <label className={estilos.campo}>
          <span>Atajo</span>
          <input
            required
            value={atajo}
            onChange={(e) => setAtajo(e.target.value.toLowerCase())}
            pattern="^/[a-z0-9_-]{1,30}$"
            title="Empieza por / y usa letras, números, guion o guion bajo"
          />
          <span className={estilos.ayuda}>Con barra, sin espacios: /gracias, /horario</span>
        </label>
        <label className={estilos.campo}>
          <span>Título</span>
          <input
            required
            maxLength={80}
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </label>
      </div>
      <label className={estilos.campo}>
        <span>Texto</span>
        <textarea maxLength={4096} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
      </label>

      <div className={estilos.campo}>
        <span>Imagen (opcional)</span>
        <p className={estilos.ayuda}>
          Va con el texto al usar el atajo. Sirve para el mapa de llegada, la lista de precios o la
          foto del bungalow: lo que se manda igual veinte veces por semana.
        </p>
        {vista && <img src={vista} alt="" className={estilos.miniatura} />}
        <div className={estilos.formularioAcciones}>
          <button
            type="button"
            className={estilos.secundario}
            disabled={subiendo}
            onClick={() => archivo.current?.click()}
          >
            {subiendo ? 'Subiendo…' : medioId ? 'Cambiar imagen' : 'Subir imagen'}
          </button>
          {medioId && (
            <button type="button" className={estilos.peligro} onClick={() => setMedioId(null)}>
              Quitar imagen
            </button>
          )}
        </div>
        <input
          ref={archivo}
          type="file"
          className="visually-hidden"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void subir(f);
          }}
        />
      </div>
      {error && (
        <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
          {error}
        </p>
      )}
      <div className={estilos.formularioAcciones}>
        <button type="button" className={estilos.secundario} onClick={alCancelar}>
          Cancelar
        </button>
        <button type="submit" className={estilos.primario} disabled={guardando}>
          {guardando ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Crear respuesta'}
        </button>
      </div>
    </form>
  );
}
