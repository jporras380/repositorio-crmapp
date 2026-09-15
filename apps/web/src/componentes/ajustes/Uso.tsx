import { useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { ResumenDeUso } from '../../api/tipos.ts';
import estilos from './ajustes.module.css';

interface Props {
  api: Api;
}

const METRICA: Record<string, string> = {
  'messages.inbound': 'Mensajes recibidos',
  'messages.outbound': 'Mensajes entregados',
  'templates.sent': 'Plantillas enviadas',
  'conversations.opened': 'Conversaciones abiertas',
  'media.stored_bytes': 'Archivos almacenados',
  'bot.runs': 'Ejecuciones de bot',
  'ai.suggestions': 'Sugerencias de IA (las paga el hotel con su clave)',
};
const LIMITE: Record<string, string> = {
  conversaciones_mes: 'Conversaciones al mes',
  agentes: 'Agentes',
  canales: 'Canales',
  bot_runs_mes: 'Ejecuciones de bot al mes',
  creditos_ia_mes: 'Créditos de IA al mes',
};

function formatearBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** El porcentaje se pasa como propiedad personalizada: es dato, no estilo. */
function ancho(porcentaje: number) {
  return (nodo: HTMLElement | null) =>
    nodo?.style.setProperty('--porcentaje', `${Math.min(100, porcentaje)}%`);
}

/** Consumo del mes frente al plan. Solo informa: qué pasa al superar un límite lo decide la API. */
export function Uso({ api }: Props) {
  const [uso, setUso] = useState<ResumenDeUso | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .uso()
      .then(setUso)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, [api]);

  if (error) {
    return (
      <p className={`${estilos.aviso} ${estilos.aviso_error}`} role="alert">
        {error}
      </p>
    );
  }
  if (!uso) return <p className={estilos.descripcion}>Cargando…</p>;

  // Primero lo que ya se mide; lo que aún no tiene métrica va debajo.
  const limites = Object.entries(uso.limites)
    .filter(([, v]) => v.limite !== null)
    .sort(([, a], [, b]) => Number(b.usado !== null) - Number(a.usado !== null));

  return (
    <section className={estilos.seccion}>
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Uso del plan</h2>
          <p className={estilos.descripcion}>
            Periodo {uso.periodo}
            {uso.plan ? ` · plan ${uso.plan}` : ''}. Se actualiza al instante con cada mensaje.
          </p>
        </div>
      </header>

      <div className={estilos.tarjetas}>
        {limites.map(([clave, v]) => {
          const pct = v.usado === null || !v.limite ? 0 : (v.usado / v.limite) * 100;
          const tono = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : '';
          return (
            <div key={clave} className={estilos.barraUso}>
              <div className={estilos.barraUsoCabecera}>
                <span>{LIMITE[clave] ?? clave}</span>
                <span>
                  {v.usado === null ? 'sin medir' : v.usado.toLocaleString('es')} /{' '}
                  {v.limite?.toLocaleString('es')}
                </span>
              </div>
              <div
                className={estilos.barraUsoPista}
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`${estilos.barraUsoRelleno} ${tono ? estilos[`barraUsoRelleno_${tono}`] : ''}`}
                  ref={ancho(pct)}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className={estilos.metricas}>
        {Object.entries(uso.uso).map(([m, valor]) => (
          <div key={m} className={estilos.metrica}>
            <span className={estilos.metricaValor}>
              {m === 'media.stored_bytes' ? formatearBytes(valor) : valor.toLocaleString('es')}
            </span>
            <span className={estilos.metricaNombre}>{METRICA[m] ?? m}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
