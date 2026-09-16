import { useState, type FormEvent } from 'react';
import type {
  Embudo,
  Etiqueta,
  FiltrosDeBandeja,
  Miembro,
  VistaDeBandeja,
} from '../../api/tipos.ts';
import { PanelDeFiltros } from './PanelDeFiltros.tsx';
import estilos from './Filtros.module.css';

interface Props {
  filtros: FiltrosDeBandeja;
  etiquetas: Etiqueta[];
  userId: string;
  miembros: Miembro[];
  embudos: Embudo[];
  vistas: VistaDeBandeja[];
  alCambiar: (f: FiltrosDeBandeja) => void;
  alCrearEtiqueta: (nombre: string, color: string | null) => Promise<void>;
  alGuardarVista: (nombre: string) => void | Promise<void>;
  alBorrarVista: (id: string) => void | Promise<void>;
}

/** Filtros que no salen de la fila de vistas: los que abre el panel. */
const AVANZADOS = ['atencion', 'agenteId', 'etapaId', 'desde', 'hasta'] as const;

const COLORES = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];

/**
 * Filtros de primer nivel. Las etiquetas de color van arriba y siempre
 * visibles (Zenvia): el usuario marca lo importante con color y filtra por él.
 */
export function Filtros({
  filtros,
  etiquetas,
  userId,
  miembros,
  embudos,
  vistas,
  alCambiar,
  alCrearEtiqueta,
  alGuardarVista,
  alBorrarVista,
}: Props) {
  const [creando, setCreando] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const avanzados = AVANZADOS.filter((k) => filtros[k] !== undefined && filtros[k] !== '').length;

  const vista =
    filtros.estado === 'closed'
      ? 'cerradas'
      : filtros.tipo === 'comment_thread'
        ? 'comentarios'
        : filtros.sinRespuesta
          ? 'sinRespuesta'
          : filtros.agenteId
            ? 'mias'
            : 'todas';

  function verVista(v: typeof vista) {
    const base: FiltrosDeBandeja = { canal: filtros.canal, etiquetaId: filtros.etiquetaId };
    if (v === 'sinRespuesta') base.sinRespuesta = true;
    if (v === 'mias') base.agenteId = userId;
    if (v === 'cerradas') base.estado = 'closed';
    if (v === 'comentarios') base.tipo = 'comment_thread';
    alCambiar(base);
  }
  function verCanal(canal: string | undefined) {
    alCambiar({ ...filtros, canal: filtros.canal === canal ? undefined : canal });
  }
  function verEtiqueta(id: string) {
    alCambiar({ ...filtros, etiquetaId: filtros.etiquetaId === id ? undefined : id });
  }

  return (
    <header className={estilos.cabecera}>
      <div className={estilos.fila}>
        <h1 className={estilos.titulo}>Bandeja</h1>
        <div className={estilos.canales} role="group" aria-label="Canal">
          <button
            className={`${estilos.canal} ${estilos.whatsapp} ${filtros.canal === 'whatsapp' ? estilos.canalActivo : ''}`}
            aria-pressed={filtros.canal === 'whatsapp'}
            onClick={() => verCanal('whatsapp')}
            title="Solo WhatsApp"
          >
            <span className="visually-hidden">WhatsApp</span>
          </button>
          <button
            className={`${estilos.canal} ${estilos.instagram} ${filtros.canal === 'instagram' ? estilos.canalActivo : ''}`}
            aria-pressed={filtros.canal === 'instagram'}
            onClick={() => verCanal('instagram')}
            title="Solo Instagram"
          >
            <span className="visually-hidden">Instagram</span>
          </button>
          <button
            className={`${estilos.canal} ${estilos.facebook} ${filtros.canal === 'facebook' ? estilos.canalActivo : ''}`}
            aria-pressed={filtros.canal === 'facebook'}
            onClick={() => verCanal('facebook')}
            title="Solo Facebook"
          >
            <span className="visually-hidden">Facebook</span>
          </button>
        </div>
      </div>

      <div className={estilos.fila}>
        <input
          className={estilos.buscar}
          type="search"
          placeholder="Buscar por cliente, teléfono o lo que se dijo…"
          aria-label="Buscar conversaciones"
          value={filtros.q ?? ''}
          onChange={(e) => alCambiar({ ...filtros, q: e.target.value || undefined })}
        />
        <button
          className={`${estilos.masFiltros} ${avanzados > 0 ? estilos.masFiltrosActivo : ''}`}
          aria-expanded={abierto}
          onClick={() => setAbierto((v) => !v)}
        >
          Filtros{avanzados > 0 ? ` · ${avanzados}` : ''}
        </button>
      </div>

      {abierto && (
        <PanelDeFiltros
          filtros={filtros}
          miembros={miembros}
          embudos={embudos}
          vistas={vistas}
          alCambiar={alCambiar}
          alGuardarVista={alGuardarVista}
          alBorrarVista={alBorrarVista}
          alAplicarVista={(v) => {
            // Una vista guardada es el filtro ENTERO, no un añadido: aplicarla
            // sobre lo que había dejaría restos invisibles de la búsqueda
            // anterior y el resultado no sería el que se guardó.
            alCambiar({ ...(v.filtros as FiltrosDeBandeja) });
            setAbierto(false);
          }}
          alCerrar={() => setAbierto(false)}
        />
      )}

      <div className={estilos.vistas} role="tablist" aria-label="Vista">
        {(
          [
            ['todas', 'Todas'],
            ['sinRespuesta', 'Sin respuesta'],
            ['mias', 'Mías'],
            ['comentarios', 'Comentarios'],
            ['cerradas', 'Cerradas'],
          ] as const
        ).map(([v, texto]) => (
          <button
            key={v}
            role="tab"
            aria-selected={vista === v}
            className={`${estilos.vista} ${vista === v ? estilos.vistaActiva : ''}`}
            onClick={() => verVista(v)}
          >
            {texto}
          </button>
        ))}
      </div>

      <div className={estilos.etiquetas} role="group" aria-label="Etiquetas">
        {etiquetas.map((e) => (
          <button
            key={e.id}
            className={`${estilos.etiqueta} ${filtros.etiquetaId === e.id ? estilos.etiquetaActiva : ''}`}
            aria-pressed={filtros.etiquetaId === e.id}
            onClick={() => verEtiqueta(e.id)}
          >
            <span className={estilos.punto} ref={pintar(e.color)} />
            {e.nombre}
          </button>
        ))}
        {creando ? (
          <NuevaEtiqueta
            alCancelar={() => setCreando(false)}
            alCrear={async (n, c) => {
              await alCrearEtiqueta(n, c);
              setCreando(false);
            }}
          />
        ) : (
          <button className={estilos.nueva} onClick={() => setCreando(true)}>
            + etiqueta
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * El color de una etiqueta es dato del usuario, no estilo nuestro: se pasa
 * como propiedad personalizada al nodo. Es la única excepción admitida a
 * "nada en línea", y por eso va por ref y no por `style=`.
 */
export function pintar(color: string | null) {
  return (nodo: HTMLElement | null) => {
    if (nodo) nodo.style.setProperty('--tag', color ?? 'var(--fg-faint)');
  };
}

function NuevaEtiqueta({
  alCrear,
  alCancelar,
}: {
  alCrear: (nombre: string, color: string | null) => Promise<void>;
  alCancelar: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [color, setColor] = useState<string>(COLORES[3]!);
  const [error, setError] = useState<string | null>(null);

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) return;
    try {
      await alCrear(nombre.trim(), color);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear.');
    }
  }
  return (
    <form className={estilos.nuevaForma} onSubmit={crear}>
      <div className={estilos.paleta} role="radiogroup" aria-label="Color">
        {COLORES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            className={`${estilos.muestra} ${color === c ? estilos.muestraActiva : ''}`}
            ref={pintar(c)}
            onClick={() => setColor(c)}
          >
            <span className="visually-hidden">{c}</span>
          </button>
        ))}
      </div>
      <input
        autoFocus
        className={estilos.nuevaEntrada}
        placeholder="Nombre de la etiqueta"
        value={nombre}
        maxLength={40}
        onChange={(e) => setNombre(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && alCancelar()}
      />
      {error && <span className={estilos.error}>{error}</span>}
      <div className={estilos.acciones}>
        <button type="button" className={estilos.secundario} onClick={alCancelar}>
          Cancelar
        </button>
        <button type="submit" className={estilos.primario}>
          Crear etiqueta
        </button>
      </div>
    </form>
  );
}
