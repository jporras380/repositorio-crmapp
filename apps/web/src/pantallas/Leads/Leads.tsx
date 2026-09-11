import { useCallback, useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { Embudo, Etiqueta, Miembro, Sesion, Tablero as Datos, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Etapas } from '../../componentes/leads/Etapas.tsx';
import { FichaDeLead } from '../../componentes/leads/FichaDeLead.tsx';
import { Tablero } from '../../componentes/leads/Tablero.tsx';
import { irA } from '../../estado/ruta.ts';
import { importe as formatearImporte } from '../../vista/dinero.ts';
import estilos from './Leads.module.css';

interface Props {
  sesion: Sesion;
  leadId: string | null;
  alSalir: () => void;
}

/**
 * El embudo de ventas.
 *
 * La pantalla que abre un jefe de ventas por la mañana: en qué punto está
 * cada cliente y cuánto hay en juego. Las tarjetas no las crea nadie a mano
 * —las abre la ingesta con cada conversación nueva— así que esto es sobre
 * todo una pantalla de **mover y cerrar**, no de dar de alta.
 *
 * La búsqueda filtra en el servidor y no en el navegador, a propósito: cada
 * columna solo trae sus primeras tarjetas, así que filtrar aquí escondería
 * justo lo que no se ha traído.
 */
export function Leads({ sesion, leadId, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [embudos, setEmbudos] = useState<Embudo[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [responsable, setResponsable] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const [editandoEtapas, setEditandoEtapas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const cargar = useCallback(async () => {
    try {
      setDatos(
        await api.tablero({
          ...(busqueda.trim() ? { q: busqueda.trim() } : {}),
          ...(responsable ? { responsable } : {}),
          ...(etiqueta ? { etiqueta } : {}),
        }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el embudo.');
    } finally {
      setCargando(false);
    }
  }, [api, busqueda, responsable, etiqueta]);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    api
      .embudos()
      .then(setEmbudos)
      .catch(() => undefined);
    api
      .usuarios()
      .then(setMiembros)
      .catch(() => undefined);
    api
      .etiquetas()
      .then(setEtiquetas)
      .catch(() => undefined);
  }, [api]);

  // La búsqueda espera a que se deje de escribir: una consulta por tecla
  // contra un tablero con seis columnas es ruido caro y sin ganancia.
  useEffect(() => {
    const t = setTimeout(() => void cargar(), busqueda ? 250 : 0);
    return () => clearTimeout(t);
  }, [cargar, busqueda]);

  async function mover(id: string, etapaId: string) {
    try {
      await api.editarLead(id, { etapaId });
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo mover el lead.');
    }
  }

  const moneda = datos?.embudo.moneda ?? 'PEN';
  const etapas = embudos.find((e) => e.id === datos?.embudo.id)?.etapas ?? [];
  const totales = Object.fromEntries((datos?.columnas ?? []).map((c) => [c.etapa.id, c.total]));

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="leads" alSalir={alSalir} />

      <main className={estilos.centro}>
        <header className={`glass ${estilos.barra}`}>
          <div className={estilos.identidad}>
            <h1 className={estilos.titulo}>{datos?.embudo.nombre ?? 'Embudo'}</h1>
            <p className={estilos.resumen}>
              {datos ? `${datos.leadsAbiertos} abiertos` : '…'}
              {datos && datos.pronostico > 0 && (
                <>
                  {' · '}
                  <span className={estilos.pronostico}>
                    {formatearImporte(datos.pronostico, moneda)} en juego
                  </span>
                </>
              )}
            </p>
          </div>

          <input
            className={estilos.buscar}
            type="search"
            placeholder="Buscar por cliente o por lo que pide…"
            aria-label="Buscar leads"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />

          <select
            className={estilos.filtro}
            value={responsable}
            aria-label="Filtrar por responsable"
            onChange={(e) => setResponsable(e.target.value)}
          >
            <option value="">Todos los responsables</option>
            {miembros.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nombre}
              </option>
            ))}
          </select>

          <select
            className={estilos.filtro}
            value={etiqueta}
            aria-label="Filtrar por etiqueta"
            onChange={(e) => setEtiqueta(e.target.value)}
          >
            <option value="">Todas las etiquetas</option>
            {etiquetas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>

          <button
            className={estilos.accion}
            onClick={() => setEditandoEtapas((v) => !v)}
            aria-pressed={editandoEtapas}
          >
            Etapas
          </button>
        </header>

        {error && <p className={estilos.error}>{error}</p>}

        {editandoEtapas && datos && (
          <Etapas
            api={api}
            embudoId={datos.embudo.id}
            etapas={etapas}
            totales={totales}
            alCerrar={() => setEditandoEtapas(false)}
            alCambiar={async () => {
              setEmbudos(await api.embudos());
              await cargar();
            }}
          />
        )}

        <div className={estilos.cuerpo}>
          {cargando && <p className={estilos.cargando}>Cargando el embudo…</p>}
          {datos && (
            <Tablero
              columnas={datos.columnas}
              moneda={moneda}
              seleccionado={leadId}
              alAbrir={(id) => irA({ pantalla: 'leads', leadId: id })}
              alMover={mover}
            />
          )}

          {leadId && (
            <FichaDeLead
              api={api}
              leadId={leadId}
              etapas={etapas}
              moneda={moneda}
              miembros={miembros}
              etiquetas={etiquetas}
              alCerrar={() => irA({ pantalla: 'leads', leadId: null })}
              alCambiar={cargar}
            />
          )}
        </div>
      </main>
    </div>
  );
}
