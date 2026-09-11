import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../../api/cliente.ts';
import type { DetalleDeLead, Etiqueta, EtapaDeEmbudo, Miembro } from '../../api/tipos.ts';
import { irA } from '../../estado/ruta.ts';
import { aCampo, aCentimos, importe as formatearImporte } from '../../vista/dinero.ts';
import { diaDeMensaje } from '../../vista/tiempo.ts';
import estilos from './FichaDeLead.module.css';

interface Props {
  api: Api;
  leadId: string;
  etapas: EtapaDeEmbudo[];
  moneda: string;
  miembros: Miembro[];
  etiquetas: Etiqueta[];
  alCerrar: () => void;
  /** Algo cambió: el tablero se recarga. */
  alCambiar: () => void | Promise<void>;
}

const HISTORIAL: Record<string, string> = {
  creado: 'Se creó',
  movido: 'Se movió',
  etapa_borrada: 'Se movió al borrarse su etapa',
};

/**
 * La ficha del lead, en cajón lateral.
 *
 * Se edita **aquí y no en la tarjeta**: una tarjeta con campos editables es
 * una tarjeta que se dispara al arrastrarla, y el tablero se lee de un
 * vistazo justamente porque las tarjetas no tienen formularios.
 *
 * Cada campo guarda al salir del foco, sin botón de guardar. Es lo correcto
 * para un panel que se cierra de un clic fuera: un «Guardar» que a veces se
 * olvida pierde trabajo, y aquí no hay nada que confirmar —son cuatro campos
 * y todos se pueden volver a cambiar.
 */
export function FichaDeLead({
  api,
  leadId,
  etapas,
  moneda,
  miembros,
  etiquetas,
  alCerrar,
  alCambiar,
}: Props) {
  const [lead, setLead] = useState<DetalleDeLead | null>(null);
  const [titulo, setTitulo] = useState('');
  const [campoImporte, setCampoImporte] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const d = await api.lead(leadId);
      setLead(d);
      setTitulo(d.titulo);
      setCampoImporte(aCampo(d.importe));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el lead.');
    }
  }, [api, leadId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function guardar(cambio: Parameters<Api['editarLead']>[1]) {
    try {
      await api.editarLead(leadId, cambio);
      await cargar();
      await alCambiar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
  }

  async function borrar() {
    try {
      await api.borrarLead(leadId);
      await alCambiar();
      alCerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo borrar.');
    }
  }

  if (!lead) {
    return (
      <aside className={`glass ${estilos.ficha}`} aria-label="Lead">
        <p className={estilos.cargando}>{error ?? 'Cargando…'}</p>
      </aside>
    );
  }

  const puestas = new Set(lead.etiquetas.map((e) => e.id));

  return (
    <aside className={`glass ${estilos.ficha}`} aria-label={`Lead: ${lead.titulo}`}>
      <header className={estilos.cabecera}>
        <div>
          <p className={estilos.contacto}>{lead.contacto.nombre ?? 'Sin nombre'}</p>
          <p className={estilos.estado} data-estado={lead.estado}>
            {lead.estado === 'abierto'
              ? 'Abierto'
              : lead.estado === 'ganado'
                ? 'Ganado'
                : 'Perdido'}
          </p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar} aria-label="Cerrar el lead">
          ×
        </button>
      </header>

      {error && <p className={estilos.error}>{error}</p>}

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Qué pide</span>
        <textarea
          className={estilos.texto}
          rows={2}
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          onBlur={() => titulo.trim() && titulo !== lead.titulo && void guardar({ titulo })}
        />
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Importe ({moneda})</span>
        <input
          className={estilos.entrada}
          inputMode="decimal"
          placeholder="0"
          value={campoImporte}
          onChange={(e) => setCampoImporte(e.target.value)}
          onBlur={() => {
            const centimos = aCentimos(campoImporte);
            setCampoImporte(aCampo(centimos));
            if (centimos !== lead.importe) void guardar({ importe: centimos });
          }}
        />
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Etapa</span>
        <select
          className={estilos.select}
          value={lead.etapaId}
          onChange={(e) => void guardar({ etapaId: e.target.value })}
        >
          {etapas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
        </select>
      </label>

      <label className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Responsable</span>
        <select
          className={estilos.select}
          value={lead.responsableId ?? ''}
          onChange={(e) => void guardar({ responsableId: e.target.value || null })}
        >
          <option value="">Sin asignar</option>
          {miembros.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nombre}
            </option>
          ))}
        </select>
      </label>

      <div className={estilos.campo}>
        <span className={estilos.etiquetaCampo}>Etiquetas</span>
        <div className={estilos.chips}>
          {etiquetas.map((e) => {
            const puesta = puestas.has(e.id);
            return (
              <button
                key={e.id}
                className={`${estilos.chip} ${puesta ? estilos.chipPuesta : ''}`}
                aria-pressed={puesta}
                ref={(n) => n?.style.setProperty('--color-etiqueta', e.color ?? '#8E8E93')}
                onClick={() =>
                  void guardar({
                    etiquetas: puesta
                      ? [...puestas].filter((id) => id !== e.id)
                      : [...puestas, e.id],
                  })
                }
              >
                {e.nombre}
              </button>
            );
          })}
          {etiquetas.length === 0 && (
            <p className={estilos.pista}>No hay etiquetas todavía. Se crean en Ajustes.</p>
          )}
        </div>
      </div>

      {lead.conversacionId && (
        <button
          className={estilos.aLaConversacion}
          onClick={() => irA({ pantalla: 'bandeja', conversacionId: lead.conversacionId })}
        >
          Abrir la conversación
        </button>
      )}

      <section className={estilos.historial} aria-label="Historial">
        <h3 className={estilos.historialTitulo}>Historial</h3>
        <ul className={estilos.lineas}>
          {lead.historial.map((h, i) => (
            <li key={i} className={estilos.linea}>
              <span className={estilos.lineaQue}>
                {HISTORIAL[h.tipo] ?? h.tipo}
                {h.desde && h.hasta ? `: ${h.desde} → ${h.hasta}` : h.hasta ? `: ${h.hasta}` : ''}
              </span>
              <span className={estilos.lineaCuando}>{diaDeMensaje(h.en)}</span>
            </li>
          ))}
          {lead.historial.length === 0 && <li className={estilos.pista}>Sin movimientos.</li>}
        </ul>
      </section>

      <footer className={estilos.pie}>
        <span className={estilos.total}>{formatearImporte(lead.importe, moneda)}</span>
        {confirmando ? (
          <span className={estilos.confirmar}>
            ¿Borrar este lead?
            <button className={estilos.borrarSi} onClick={() => void borrar()}>
              Sí, borrar
            </button>
            <button className={estilos.borrarNo} onClick={() => setConfirmando(false)}>
              No
            </button>
          </span>
        ) : (
          <button className={estilos.borrar} onClick={() => setConfirmando(true)}>
            Borrar
          </button>
        )}
      </footer>
    </aside>
  );
}
