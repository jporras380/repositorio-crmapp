import { useState, type FormEvent } from 'react';
import type { Etiqueta, FiltrosDeBandeja } from '../../api/tipos.ts';
import estilos from './Filtros.module.css';

interface Props {
  filtros: FiltrosDeBandeja;
  etiquetas: Etiqueta[];
  userId: string;
  alCambiar: (f: FiltrosDeBandeja) => void;
  alCrearEtiqueta: (nombre: string, color: string | null) => Promise<void>;
}

const COLORES = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];

/**
 * Filtros de primer nivel. Las etiquetas de color van arriba y siempre
 * visibles (Zenvia): el usuario marca lo importante con color y filtra por él.
 */
export function Filtros({ filtros, etiquetas, userId, alCambiar, alCrearEtiqueta }: Props) {
  const [creando, setCreando] = useState(false);

  const vista =
    filtros.estado === 'closed'
      ? 'cerradas'
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
        </div>
      </div>

      <div className={estilos.vistas} role="tablist" aria-label="Vista">
        {(
          [
            ['todas', 'Todas'],
            ['sinRespuesta', 'Sin respuesta'],
            ['mias', 'Mías'],
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
