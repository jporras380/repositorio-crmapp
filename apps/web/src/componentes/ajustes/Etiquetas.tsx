import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorDeApi, type Api } from '../../api/cliente.ts';
import type { EtiquetaConUso } from '../../api/tipos.ts';
import { useListaFiltrable, type ListaFiltrada } from '../../vista/listaFiltrable.ts';
import { BarraDeFiltro, ContadorYPaginas } from './FiltroDeLista.tsx';
import compartidos from './ajustes.module.css';
import estilos from './Etiquetas.module.css';

interface Props {
  api: Api;
  gestor: boolean;
}

const COLOR_POR_DEFECTO = '#8e8e93';

function plural(n: number, uno: string, varios: string) {
  return `${n} ${n === 1 ? uno : varios}`;
}

function describirUso(e: EtiquetaConUso): string {
  const partes = [
    e.usos.conversaciones && plural(e.usos.conversaciones, 'conversación', 'conversaciones'),
    e.usos.clientes && plural(e.usos.clientes, 'cliente', 'clientes'),
    e.usos.leads && plural(e.usos.leads, 'lead', 'leads'),
  ].filter(Boolean);
  return partes.length ? partes.join(' · ') : 'Sin usar';
}

/**
 * El apartado donde se administran las etiquetas: crear, renombrar,
 * recolorear y borrar. Una etiqueta es la misma en conversaciones, clientes y
 * leads, así que cambiarla aquí la cambia en todas partes. Antes de borrar se
 * dice cuánto se pierde, y la API no deja borrar la que usa un bot.
 */
export function Etiquetas({ api, gestor }: Props) {
  const [etiquetas, setEtiquetas] = useState<EtiquetaConUso[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nombreNueva, setNombreNueva] = useState('');
  const [colorNueva, setColorNueva] = useState('#007aff');

  const cargar = useCallback(async () => {
    try {
      setEtiquetas(await api.etiquetasConUso());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las etiquetas.');
    }
  }, [api]);
  useEffect(() => void cargar(), [cargar]);

  async function hacer(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await cargar();
      return true;
    } catch (e) {
      setError(e instanceof ErrorDeApi ? e.message : 'No se pudo guardar.');
      return false;
    }
  }

  async function crear(e: FormEvent) {
    e.preventDefault();
    const nombre = nombreNueva.trim();
    if (!nombre) return;
    if (await hacer(() => api.crearEtiqueta(nombre, colorNueva))) setNombreNueva('');
  }

  function borrar(e: EtiquetaConUso) {
    const uso = describirUso(e);
    const aviso =
      uso === 'Sin usar'
        ? `¿Borrar la etiqueta «${e.nombre}»?`
        : `¿Borrar «${e.nombre}»? Se quitará de: ${uso}. No se puede deshacer.`;
    if (!confirm(aviso)) return;
    void hacer(() => api.borrarEtiqueta(e.id));
  }

  /*
    Se busca por nombre y por los bots que la usan: «¿qué etiqueta pone el bot
    de bienvenida?» es una pregunta real cuando hay varios flujos, y hasta
    ahora obligaba a abrirlos uno a uno.
  */
  const filtrada = useListaFiltrable(
    etiquetas,
    (e) => [e.nombre, ...e.bots],
    (e) => e.creadaEn,
  );

  return (
    <section className={compartidos.seccion}>
      <header className={compartidos.cabecera}>
        <div>
          <h2 className={compartidos.titulo}>Etiquetas</h2>
          <p className={compartidos.descripcion}>
            Las mismas etiquetas sirven para conversaciones, clientes y leads. Cambiar el nombre o
            el color aquí lo cambia en todas partes.
          </p>
        </div>
      </header>

      {error && (
        <p className={`${compartidos.aviso} ${compartidos.aviso_error}`} role="alert">
          {error}
        </p>
      )}

      {gestor && (
        <form className={estilos.nueva} onSubmit={crear}>
          <input
            type="color"
            className={estilos.color}
            value={colorNueva}
            onChange={(e) => setColorNueva(e.target.value)}
            aria-label="Color de la etiqueta nueva"
          />
          <input
            className={estilos.nombre}
            placeholder="Nueva etiqueta"
            maxLength={40}
            value={nombreNueva}
            onChange={(e) => setNombreNueva(e.target.value)}
            aria-label="Nombre de la etiqueta nueva"
          />
          <button type="submit" className={compartidos.primario} disabled={!nombreNueva.trim()}>
            Crear
          </button>
        </form>
      )}

      {etiquetas && etiquetas.length === 0 && (
        <p className={compartidos.vacio}>Todavía no hay etiquetas.</p>
      )}

      {etiquetas && etiquetas.length > 0 && (
        <BarraDeFiltro
          lista={filtrada as ListaFiltrada<unknown>}
          nombre={{ uno: 'etiqueta', varios: 'etiquetas' }}
          ejemplo="Buscar por nombre o por el bot que la usa…"
        />
      )}

      {filtrada.total > 0 && filtrada.encontrados === 0 && (
        <p className={compartidos.vacio}>Ninguna etiqueta coincide con lo que buscas.</p>
      )}

      <ul className={estilos.lista}>
        {filtrada.visibles.map((e) => (
          <Fila
            key={`${e.id}:${e.nombre}:${e.color}`}
            etiqueta={e}
            gestor={gestor}
            alGuardar={(cambios) => hacer(() => api.editarEtiqueta(e.id, cambios))}
            alBorrar={() => borrar(e)}
          />
        ))}
      </ul>

      {etiquetas && etiquetas.length > 0 && (
        <ContadorYPaginas
          lista={filtrada as ListaFiltrada<unknown>}
          nombre={{ uno: 'etiqueta', varios: 'etiquetas' }}
        />
      )}
    </section>
  );
}

function Fila({
  etiqueta,
  gestor,
  alGuardar,
  alBorrar,
}: {
  etiqueta: EtiquetaConUso;
  gestor: boolean;
  alGuardar: (cambios: { nombre?: string; color?: string }) => Promise<boolean>;
  alBorrar: () => void;
}) {
  const [nombre, setNombre] = useState(etiqueta.nombre);
  const [color, setColor] = useState(etiqueta.color ?? COLOR_POR_DEFECTO);
  const cambios = {
    ...(nombre.trim() && nombre.trim() !== etiqueta.nombre ? { nombre: nombre.trim() } : {}),
    ...(color !== (etiqueta.color ?? COLOR_POR_DEFECTO) ? { color } : {}),
  };
  const hayCambios = Object.keys(cambios).length > 0;
  const usadaPorBot = etiqueta.bots.length > 0;

  return (
    <li className={estilos.fila}>
      <input
        type="color"
        className={estilos.color}
        value={color}
        disabled={!gestor}
        onChange={(e) => setColor(e.target.value)}
        aria-label={`Color de ${etiqueta.nombre}`}
      />
      <div className={estilos.datos}>
        <input
          className={estilos.nombre}
          value={nombre}
          maxLength={40}
          disabled={!gestor}
          onChange={(e) => setNombre(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hayCambios) void alGuardar(cambios);
            if (e.key === 'Escape') setNombre(etiqueta.nombre);
          }}
          aria-label={`Nombre de ${etiqueta.nombre}`}
        />
        <span className={estilos.uso}>
          {describirUso(etiqueta)}
          {usadaPorBot &&
            ` · la usa ${etiqueta.bots.length === 1 ? 'el bot' : 'los bots'} ${etiqueta.bots.map((b) => `«${b}»`).join(', ')}`}
        </span>
      </div>
      {gestor && (
        <div className={compartidos.acciones}>
          {hayCambios && (
            <button
              type="button"
              className={compartidos.primario}
              onClick={() => void alGuardar(cambios)}
            >
              Guardar
            </button>
          )}
          <button
            type="button"
            className={compartidos.peligro}
            onClick={alBorrar}
            disabled={usadaPorBot}
            title={usadaPorBot ? 'Quítala de los bots que la usan para poder borrarla' : undefined}
          >
            Borrar
          </button>
        </div>
      )}
    </li>
  );
}
