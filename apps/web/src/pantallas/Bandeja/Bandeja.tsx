import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { crearApi, ErrorDeApi } from '../../api/cliente.ts';
import type {
  Embudo,
  Etiqueta,
  FiltrosDeBandeja,
  Miembro,
  ResumenDeConversacion,
  Sesion,
  VistaDeBandeja,
  Yo,
} from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Filtros } from '../../componentes/Filtros/Filtros.tsx';
import { ListaDeConversaciones } from '../../componentes/ListaDeConversaciones/ListaDeConversaciones.tsx';
import { Hilo } from '../../componentes/Hilo/Hilo.tsx';
import { PanelDeContacto } from '../../componentes/PanelDeContacto/PanelDeContacto.tsx';
import { Separador } from '../../componentes/Separador/Separador.tsx';
import {
  guardarPaneles,
  leerPaneles,
  LIMITES,
  type EstadoDePaneles,
} from '../../estado/paneles.ts';
import { useEventos } from '../../estado/eventos.ts';
import estilos from './Bandeja.module.css';

interface Props {
  sesion: Sesion;
  conversacionInicial: string | null;
  vistaInicial: 'sinRespuesta' | null;
  alSalir: () => void;
}

/**
 * Respaldo del flujo en vivo (PR-49). Con eventos ya no hace falta preguntar
 * cada diez segundos; esto cubre el rato en que el flujo esté caído y los
 * cambios que no pasan por el outbox (asignar, etiquetar desde otra pestaña).
 */
const CADA_MS = 60_000;

/**
 * Tres paneles (Kommo): lista, hilo, contacto. La bandeja no decide nada:
 * pide, pinta y vuelve a pedir. Lo que le dice cuándo volver a pedir es el
 * flujo de eventos en vivo, con una recarga de respaldo cada minuto.
 *
 * El reparto del espacio lo manda el agente: los separadores se arrastran y
 * los paneles laterales se pliegan (ver `estado/paneles.ts`).
 */
export function Bandeja({ sesion, conversacionInicial, vistaInicial, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [embudos, setEmbudos] = useState<Embudo[]>([]);
  const [vistas, setVistas] = useState<VistaDeBandeja[]>([]);
  const [filtros, setFiltros] = useState<FiltrosDeBandeja>(
    vistaInicial === 'sinRespuesta' ? { sinRespuesta: true } : {},
  );
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

  const [paneles, setPaneles] = useState<EstadoDePaneles>(leerPaneles);
  const contenedor = useRef<HTMLDivElement>(null);
  const cambiarPaneles = useCallback((cambio: Partial<EstadoDePaneles>) => {
    setPaneles((p) => {
      const nuevo = { ...p, ...cambio };
      guardarPaneles(nuevo);
      return nuevo;
    });
  }, []);
  // Los anchos viajan como variables CSS: durante el arrastre el separador las
  // escribe directamente y así no se redibuja la bandeja entera en cada píxel.
  const anchoEnVivo = useCallback((nombre: string, px: number) => {
    contenedor.current?.style.setProperty(nombre, `${px}px`);
  }, []);
  useEffect(() => {
    anchoEnVivo('--ancho-lista', paneles.anchoLista);
    anchoEnVivo('--ancho-ficha', paneles.anchoFicha);
  }, [anchoEnVivo, paneles.anchoLista, paneles.anchoFicha]);

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
    // Lo que alimenta el panel de filtros. Si algo de esto falla, el panel
    // sale con menos opciones; la bandeja sigue funcionando.
    api
      .usuarios()
      .then(setMiembros)
      .catch(() => undefined);
    api
      .embudos()
      .then(setEmbudos)
      .catch(() => undefined);
    api
      .vistas()
      .then(setVistas)
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    void cargarLista();
    const id = setInterval(() => void cargarLista(true), CADA_MS);
    return () => clearInterval(id);
  }, [cargarLista]);

  // Eventos en vivo: el aviso solo dice «algo cambió»; los datos se vuelven a
  // pedir por los endpoints de siempre, con los permisos de siempre.
  const [senalDelHilo, setSenalDelHilo] = useState(0);
  useEventos(sesion.token, (e) => {
    if (!e.tipo.startsWith('mensaje.') && !e.tipo.startsWith('comentario.')) return;
    void cargarLista(true);
    // Solo se recarga el hilo abierto si el evento es suyo: un mensaje en otra
    // conversación no tiene por qué mover lo que el agente está leyendo.
    if (e.conversacionId && e.conversacionId === seleccionadaId) {
      setSenalDelHilo((n) => n + 1);
    }
  });

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

  async function guardarVista(nombre: string) {
    // Se guarda lo que hay puesto AHORA, sin el cursor: una vista con cursor
    // apuntaría a una página concreta de hace días.
    const { cursor: _, ...resto } = filtros;
    const limpios = Object.fromEntries(
      Object.entries(resto)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    );
    await api.guardarVista(nombre, limpios);
    setVistas(await api.vistas());
  }

  async function borrarVista(id: string) {
    await api.borrarVista(id);
    setVistas(await api.vistas());
  }

  const seleccionada = items.find((c) => c.id === seleccionadaId) ?? null;
  const fichaVisible = seleccionada !== null && paneles.fichaAbierta;
  const clases = [
    estilos.bandeja,
    seleccionada ? '' : estilos.sinSeleccion,
    paneles.listaAbierta ? '' : estilos.listaPlegada,
    fichaVisible ? '' : estilos.fichaPlegada,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={clases} ref={contenedor}>
      <Barra yo={yo} activa="bandeja" alSalir={alSalir} />

      <section id="panel-lista" className={`glass ${estilos.lista}`} aria-label="Conversaciones">
        <Filtros
          filtros={filtros}
          etiquetas={etiquetas}
          userId={sesion.userId}
          miembros={miembros}
          embudos={embudos}
          vistas={vistas}
          alCambiar={setFiltros}
          alCrearEtiqueta={nuevaEtiqueta}
          alGuardarVista={guardarVista}
          alBorrarVista={borrarVista}
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

      <Separador
        etiqueta="lista de conversaciones"
        controla="panel-lista"
        valor={paneles.anchoLista}
        limites={LIMITES.lista}
        lado="inicio"
        abierto={paneles.listaAbierta}
        alMover={(px) => anchoEnVivo('--ancho-lista', px)}
        alFijar={(px) => cambiarPaneles({ anchoLista: px })}
        alAlternar={() => cambiarPaneles({ listaAbierta: !paneles.listaAbierta })}
      />

      <section className={`glass ${estilos.hilo}`} aria-label="Conversación">
        {seleccionada ? (
          <Hilo
            key={seleccionada.id}
            api={api}
            conversacion={seleccionada}
            fichaAbierta={fichaVisible}
            alAlternarFicha={() => cambiarPaneles({ fichaAbierta: !paneles.fichaAbierta })}
            alVolver={() => setSeleccionadaId(null)}
            alCambiar={() => void cargarLista(true)}
            senalDeRecarga={senalDelHilo}
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

      {fichaVisible && (
        <Separador
          etiqueta="ficha del contacto"
          controla="panel-ficha"
          valor={paneles.anchoFicha}
          limites={LIMITES.ficha}
          lado="fin"
          abierto={true}
          soloAnchas
          alMover={(px) => anchoEnVivo('--ancho-ficha', px)}
          alFijar={(px) => cambiarPaneles({ anchoFicha: px })}
          alAlternar={() => cambiarPaneles({ fichaAbierta: false })}
        />
      )}

      <aside id="panel-ficha" className={`glass ${estilos.contacto}`} aria-label="Contacto">
        {seleccionada && (
          <PanelDeContacto
            api={api}
            conversacion={seleccionada}
            etiquetas={etiquetas}
            userId={sesion.userId}
            alCerrar={() => cambiarPaneles({ fichaAbierta: false })}
            alCambiar={() => void cargarLista(true)}
          />
        )}
      </aside>
    </div>
  );
}
