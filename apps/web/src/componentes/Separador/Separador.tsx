import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { acotar, type Limites } from '../../estado/paneles.ts';
import estilos from './Separador.module.css';

interface Props {
  /** Qué se está redimensionando, para quien navega a ciegas. */
  etiqueta: string;
  /** `id` del panel que controla: lo exige `aria-controls`. */
  controla: string;
  valor: number;
  limites: Limites;
  /** Hacia dónde crece el panel: `inicio` = está a la izquierda del asa. */
  lado: 'inicio' | 'fin';
  abierto: boolean;
  /** La ficha solo es columna en pantallas anchas; su separador, tambien. */
  soloAnchas?: boolean;
  /** Durante el arrastre, en cada píxel. No debe redibujar la bandeja. */
  alMover: (px: number) => void;
  /** Al soltar. Aquí sí se guarda la preferencia. */
  alFijar: (px: number) => void;
  alAlternar: () => void;
}

const PASO = 24;

/**
 * Separador de paneles: se arrastra, se pliega y también funciona con el
 * teclado (`role="separator"` enfocable, el «window splitter» de ARIA).
 *
 * El arrastre no pasa por el estado de React: mueve una variable CSS del
 * contenedor. Redibujar la bandeja entera en cada `pointermove` cuesta el
 * doble —lista, hilo y ficha— y a 120 Hz eso se ve. El estado se toca una
 * vez, al soltar; entre medias la fuente de verdad es la variable CSS.
 */
export function Separador({
  etiqueta,
  controla,
  valor,
  limites,
  lado,
  abierto,
  soloAnchas = false,
  alMover,
  alFijar,
  alAlternar,
}: Props) {
  const [actual, setActual] = useState(valor);
  const [arrastrando, setArrastrando] = useState(false);
  const vivo = useRef(valor);

  useEffect(() => {
    vivo.current = valor;
    setActual(valor);
  }, [valor]);

  function fijar(px: number) {
    vivo.current = px;
    setActual(px);
    alMover(px);
  }

  function alPulsar(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const nodo = e.currentTarget;
    const desdeX = e.clientX;
    const desdeValor = vivo.current;
    // La captura mantiene el gesto vivo aunque el puntero se salga del asa.
    // Todo navegador la tiene; jsdom no, y sin el guarda los tests del
    // componente se caen por algo que en produccion no puede pasar.
    nodo.setPointerCapture?.(e.pointerId);
    setArrastrando(true);
    // El cursor y la no-selección son de toda la página mientras dure el
    // arrastre: si se quedan en el asa, salirse de ella rompe el gesto.
    document.documentElement.classList.add('redimensionando');

    const mover = (ev: globalThis.PointerEvent) => {
      const delta = lado === 'inicio' ? ev.clientX - desdeX : desdeX - ev.clientX;
      fijar(acotar(desdeValor + delta, limites));
    };
    const soltar = () => {
      nodo.removeEventListener('pointermove', mover);
      document.documentElement.classList.remove('redimensionando');
      setArrastrando(false);
      alFijar(vivo.current);
    };
    nodo.addEventListener('pointermove', mover);
    nodo.addEventListener('pointerup', soltar, { once: true });
    nodo.addEventListener('pointercancel', soltar, { once: true });
  }

  function alTeclear(e: KeyboardEvent<HTMLDivElement>) {
    const hacia = lado === 'inicio' ? 1 : -1;
    let px: number | null = null;
    if (e.key === 'ArrowLeft') px = acotar(vivo.current - PASO * hacia, limites);
    if (e.key === 'ArrowRight') px = acotar(vivo.current + PASO * hacia, limites);
    if (e.key === 'Home') px = lado === 'inicio' ? limites.min : limites.max;
    if (e.key === 'End') px = lado === 'inicio' ? limites.max : limites.min;
    if (px === null) return;
    e.preventDefault();
    fijar(px);
    alFijar(px);
  }

  // Plegar empuja el panel hacia su lado; desplegar lo trae hacia el centro.
  const galon = abierto === (lado === 'inicio') ? 'inicio' : 'fin';

  return (
    <div
      className={`${estilos.zona} ${abierto ? '' : estilos.plegada} ${soloAnchas ? estilos.soloAnchas : ''}`}
    >
      {abierto && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={etiqueta}
          aria-valuenow={actual}
          aria-valuemin={limites.min}
          aria-valuemax={limites.max}
          aria-controls={controla}
          className={`${estilos.asa} ${arrastrando ? estilos.activa : ''}`}
          onPointerDown={alPulsar}
          onKeyDown={alTeclear}
          onDoubleClick={() => {
            fijar(limites.por);
            alFijar(limites.por);
          }}
          title="Arrastra para cambiar el ancho. Doble clic para volver al normal."
        />
      )}
      <button
        className={estilos.plegar}
        aria-controls={controla}
        aria-expanded={abierto}
        onClick={alAlternar}
        title={abierto ? `Ocultar: ${etiqueta}` : `Mostrar: ${etiqueta}`}
      >
        <Galon hacia={galon} />
        <span className="visually-hidden">{abierto ? 'Ocultar' : 'Mostrar'}</span>
      </button>
    </div>
  );
}

function Galon({ hacia }: { hacia: 'inicio' | 'fin' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={hacia === 'inicio' ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6'}
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
