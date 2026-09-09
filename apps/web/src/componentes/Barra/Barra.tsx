import type { Yo } from '../../api/tipos.ts';
import estilos from './Barra.module.css';

interface Props {
  yo: Yo | null;
  alSalir: () => void;
}

const ESTADOS: Record<string, { texto: string; tono: 'ok' | 'warn' | 'danger' | 'neutro' }> = {
  prueba: { texto: 'Prueba', tono: 'neutro' },
  activa: { texto: 'Activo', tono: 'ok' },
  gracia: { texto: 'Gracia: solo texto', tono: 'warn' },
  suspendida: { texto: 'Suspendido', tono: 'danger' },
};

/** Riel de navegación. Hoy una sola sección; el estado del plan siempre visible. */
export function Barra({ yo, alSalir }: Props) {
  const estado = yo ? (ESTADOS[yo.suscripcion] ?? { texto: yo.suscripcion, tono: 'neutro' }) : null;
  return (
    <nav className={`glass ${estilos.barra}`} aria-label="Principal">
      <div className={estilos.marca} aria-hidden="true" />
      <button className={`${estilos.item} ${estilos.activo}`} aria-current="page" title="Bandeja">
        <IconoBandeja />
        <span className="visually-hidden">Bandeja</span>
      </button>

      <div className={estilos.abajo}>
        {estado && (
          <span
            className={`${estilos.plan} ${estilos[`plan_${estado.tono}`]}`}
            title={`Suscripción: ${estado.texto}`}
          >
            {estado.texto}
          </span>
        )}
        <button className={estilos.item} onClick={alSalir} title="Salir">
          <IconoSalir />
          <span className="visually-hidden">Salir</span>
        </button>
      </div>
    </nav>
  );
}

function IconoBandeja() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5h16v10H9l-4 4V5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconoSalir() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M14 8l4 4-4 4M18 12H9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
