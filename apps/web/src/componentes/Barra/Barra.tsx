import type { Yo } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import estilos from './Barra.module.css';

interface Props {
  yo: Yo | null;
  activa?: 'panel' | 'bandeja' | 'clientes' | 'leads' | 'flujos' | 'ajustes';
  alSalir: () => void;
}

const ESTADOS: Record<string, { texto: string; tono: 'ok' | 'warn' | 'danger' | 'neutro' }> = {
  prueba: { texto: 'Prueba', tono: 'neutro' },
  activa: { texto: 'Activo', tono: 'ok' },
  gracia: { texto: 'Gracia: solo texto', tono: 'warn' },
  suspendida: { texto: 'Suspendido', tono: 'danger' },
};

/** Riel de navegación. Hoy una sola sección; el estado del plan siempre visible. */
export function Barra({ yo, activa = 'bandeja', alSalir }: Props) {
  const estado = yo ? (ESTADOS[yo.suscripcion] ?? { texto: yo.suscripcion, tono: 'neutro' }) : null;
  return (
    <nav className={`glass ${estilos.barra}`} aria-label="Principal">
      <div className={estilos.marca} aria-hidden="true" />
      <button
        className={`${estilos.item} ${activa === 'panel' ? estilos.activo : ''}`}
        aria-current={activa === 'panel' ? 'page' : undefined}
        title="Panel"
        onClick={() => irA({ pantalla: 'panel' })}
      >
        <IconoPanel />
        <span className="visually-hidden">Panel</span>
      </button>
      <button
        className={`${estilos.item} ${activa === 'bandeja' ? estilos.activo : ''}`}
        aria-current={activa === 'bandeja' ? 'page' : undefined}
        title="Bandeja"
        onClick={() => irA({ pantalla: 'bandeja', conversacionId: null })}
      >
        <IconoBandeja />
        <span className="visually-hidden">Bandeja</span>
      </button>
      <button
        className={`${estilos.item} ${activa === 'clientes' ? estilos.activo : ''}`}
        aria-current={activa === 'clientes' ? 'page' : undefined}
        title="Clientes"
        onClick={() => irA({ pantalla: 'clientes', clienteId: null })}
      >
        <IconoClientes />
        <span className="visually-hidden">Clientes</span>
      </button>
      <button
        className={`${estilos.item} ${activa === 'leads' ? estilos.activo : ''}`}
        aria-current={activa === 'leads' ? 'page' : undefined}
        title="Leads"
        onClick={() => irA({ pantalla: 'leads', leadId: null })}
      >
        <IconoEmbudo />
        <span className="visually-hidden">Leads</span>
      </button>
      <button
        className={`${estilos.item} ${activa === 'flujos' ? estilos.activo : ''}`}
        aria-current={activa === 'flujos' ? 'page' : undefined}
        title="Bots"
        onClick={() => irA({ pantalla: 'flujos', flujoId: null })}
      >
        <IconoBot />
        <span className="visually-hidden">Bots</span>
      </button>
      <button
        className={`${estilos.item} ${activa === 'ajustes' ? estilos.activo : ''}`}
        aria-current={activa === 'ajustes' ? 'page' : undefined}
        title="Ajustes"
        onClick={() => irA({ pantalla: 'ajustes', seccion: 'canales' })}
      >
        <IconoAjustes />
        <span className="visually-hidden">Ajustes</span>
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
function IconoPanel() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 19V11m5 8V5m5 14v-6m5 6V8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Dos personas. A 22 px, dos círculos y dos hombros. */
function IconoClientes() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3.5 19c0-2.8 2.5-4.6 5.5-4.6s5.5 1.8 5.5 4.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M16 5.6a3.2 3.2 0 0 1 0 4.8M17.5 14.8c2 .6 3.5 2.2 3.5 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Un embudo: tres trazos que se estrechan. Se lee a 22 px, que es el punto. */
function IconoEmbudo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5h16l-6 7v6l-4 2v-8L4 5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconoBot() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="4" r="1.4" fill="currentColor" />
      <path d="M9 13h.01M15 13h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function IconoAjustes() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
        stroke="currentColor"
        strokeWidth="1.5"
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
