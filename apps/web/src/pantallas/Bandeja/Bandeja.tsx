import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type {
  Etiqueta,
  FiltrosDeBandeja,
  ResumenDeConversacion,
  Sesion,
  Yo,
} from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Filtros } from '../../componentes/Filtros/Filtros.tsx';
import { ListaDeConversaciones } from '../../componentes/ListaDeConversaciones/ListaDeConversaciones.tsx';
import { Hilo } from '../../componentes/Hilo/Hilo.tsx';
import { PanelDeContacto } from '../../componentes/PanelDeContacto/PanelDeContacto.tsx';
import estilos from './Bandeja.module.css';

interface Props {
  sesion: Sesion;
  conversacionInicial: string | null;
  alSalir: () => void;
}

const CADA_MS = 10_000;

/**
 * Tres paneles (Kommo): lista, hilo, contacto. La bandeja no decide nada:
 * pide, pinta y vuelve a pedir. Sondeo cada 10 s hasta que exista WebSocket.
 */
export function Bandeja({ sesion, conversacionInicial, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [filtros, setFiltros] = useState<FiltrosDeBandeja>({});
  const [items, setItems] = useState<ResumenDeConversacion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  // La conversación abierta vive en la URL (#c=<id>): se puede recargar y compartir.
  const [seleccionadaId, setSeleccionadaIdEstado] = useState<string | null>(conversacionInicial);
  const setSeleccionadaId = useCallback((id: string | null) => {
    setSeleccionadaIdEstado(id);
    history.replaceState(null, '', id ? `#c=${id}` : location.pathname);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const version = useRef(0);

  const cargarLista = useCallback(
    async (silencioso = false) => {
      const v = ++version.current;
      if (!silencioso) setCargando(true);
      try {
        const p = await api.conversaciones(filtros);
        if (v !== version.current) return; // llegó tarde: hay una petición más nueva
        setItems(p.items);
        setCursor(p.siguienteCursor);
        setError(null);
      } catch (e) {
        if (e instanceof ErrorDeApi && e.estado === 401) return alSalir();
        setError(e instanceof Error ? e.message : 'No se pudo cargar la bandeja.');
      } finally {
        if (v === version.current) setCargando(false);
      }
    },
    [api, filtros, alSalir],
  );

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    api
      .etiquetas()
      .then(setEtiquetas)
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    void cargarLista();
    const id = setInterval(() => void cargarLista(true), CADA_MS);
    return () => clearInterval(id);
  }, [cargarLista]);

  async function cargarMas() {
    if (!cursor) return;
    const p = await api.conversaciones({ ...filtros, cursor });
    setItems((prev) => [...prev, ...p.items]);
    setCursor(p.siguienteCursor);
  }

  async function nuevaEtiqueta(nombre: string, color: string | null) {
    await api.crearEtiqueta(nombre, color);
    setEtiquetas(await api.etiquetas());
  }

  const seleccionada = items.find((c) => c.id === seleccionadaId) ?? null;

  return (
    <div className={`${estilos.bandeja} ${seleccionada ? '' : estilos.sinSeleccion}`}>
      <Barra yo={yo} alSalir={alSalir} />

      <section className={`glass ${estilos.lista}`} aria-label="Conversaciones">
        <Filtros
          filtros={filtros}
          etiquetas={etiquetas}
          userId={sesion.userId}
          alCambiar={setFiltros}
          alCrearEtiqueta={nuevaEtiqueta}
        />
        <ListaDeConversaciones
          items={items}
          seleccionadaId={seleccionadaId}
          cargando={cargando}
          error={error}
          hayMas={cursor !== null}
          alSeleccionar={setSeleccionadaId}
          alCargarMas={cargarMas}
        />
      </section>

      <section className={`glass ${estilos.hilo}`} aria-label="Conversación">
        {seleccionada ? (
          <Hilo
            key={seleccionada.id}
            api={api}
            conversacion={seleccionada}
            alCambiar={() => void cargarLista(true)}
          />
        ) : (
          <div className={estilos.vacio}>
            <p className={estilos.vacioTitulo}>Elige una conversación</p>
            <p className={estilos.vacioTexto}>
              Las que esperan respuesta aparecen primero. Filtra por color para ver lo importante.
            </p>
          </div>
        )}
      </section>

      <aside className={`glass ${estilos.contacto}`} aria-label="Contacto" hidden={!seleccionada}>
        {seleccionada && (
          <PanelDeContacto
            api={api}
            conversacion={seleccionada}
            etiquetas={etiquetas}
            userId={sesion.userId}
            alCambiar={() => void cargarLista(true)}
          />
        )}
      </aside>
    </div>
  );
}
