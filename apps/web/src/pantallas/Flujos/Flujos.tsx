import { useCallback, useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { ResumenDeFlujo, Sesion, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { EditorDeFlujo } from '../../componentes/flujos/EditorDeFlujo.tsx';
import { GaleriaDePlantillas } from '../../componentes/flujos/GaleriaDePlantillas.tsx';
import type { PlantillaDeFlujo } from '../../componentes/flujos/plantillas.ts';
import { irA } from '../../estado/ruta.ts';
import estilos from './Flujos.module.css';

interface Props {
  sesion: Sesion;
  flujoId: string | null;
  alSalir: () => void;
}

const ESTADOS: Record<string, string> = {
  borrador: 'Borrador',
  activo: 'Activo',
  pausado: 'En pausa',
};

/**
 * Constructor de Salesbots: lista a la izquierda, constructor a la derecha.
 *
 * La web no valida el grafo por su cuenta —no puede importar `core` y no
 * debería duplicar la regla—: la validación viaja con la simulación, que es
 * la misma llamada. Así lo que ves antes de publicar es exactamente lo que
 * decidirá el servidor al publicar.
 */
export function Flujos({ sesion, flujoId, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  const [flujos, setFlujos] = useState<ResumenDeFlujo[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  /** La galería tapa el editor mientras se elige: crear un bot es una decisión, no un botón. */
  const [eligiendo, setEligiendo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setFlujos(await api.flujos());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los flujos.');
    } finally {
      setCargando(false);
    }
  }, [api]);

  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
    void cargar();
  }, [api, cargar]);

  async function crearDesde(plantilla: PlantillaDeFlujo) {
    setCreando(true);
    setError(null);
    try {
      // El nombre se numera si ya existe: dos «Bienvenida» chocarían contra el
      // único del servidor y el error no diría nada útil.
      const usados = new Set(flujos.map((f) => f.nombre));
      let nombre = plantilla.nombre;
      for (let i = 2; usados.has(nombre); i++) nombre = `${plantilla.nombre} ${i}`;
      const { id } = await api.crearFlujo({
        nombre,
        grafo: plantilla.grafo,
        disparadores: plantilla.disparadores,
      });
      await cargar();
      setEligiendo(false);
      irA({ pantalla: 'flujos', flujoId: id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear el flujo.');
    } finally {
      setCreando(false);
    }
  }

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="flujos" alSalir={alSalir} />

      <nav className={`glass ${estilos.lista}`} aria-label="Flujos">
        <header className={estilos.cabecera}>
          <h1 className={estilos.titulo}>Bots</h1>
          <button className={estilos.nuevo} onClick={() => setEligiendo(true)} disabled={creando}>
            Nuevo flujo
          </button>
        </header>
        <p className={estilos.explicacion}>
          Un bot atiende el primer mensaje, pregunta lo que siempre preguntas y deja la conversación
          etiquetada y asignada. Tú entras cuando ya sabes de qué va.
        </p>

        {error && (
          <p className={estilos.error} role="alert">
            {error}
          </p>
        )}
        {!cargando && flujos.length === 0 && (
          <p className={estilos.vacio}>Todavía no hay ninguno. Crea el primero.</p>
        )}

        <ul className={estilos.items}>
          {flujos.map((f) => (
            <li key={f.id}>
              <button
                className={`${estilos.item} ${f.id === flujoId ? estilos.itemActivo : ''}`}
                aria-current={f.id === flujoId ? 'page' : undefined}
                onClick={() => irA({ pantalla: 'flujos', flujoId: f.id })}
              >
                <span className={estilos.itemNombre}>{f.nombre}</span>
                <span className={estilos.itemPie}>
                  <span className={`${estilos.estado} ${estilos[`estado_${f.estado}`] ?? ''}`}>
                    {ESTADOS[f.estado] ?? f.estado}
                  </span>
                  {f.version !== null && <span className={estilos.version}>v{f.version}</span>}
                  {f.ejecucionesVivas > 0 && (
                    <span className={estilos.vivas}>{f.ejecucionesVivas} en curso</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className={estilos.contenido}>
        {eligiendo ? (
          <GaleriaDePlantillas
            ocupado={creando}
            alElegir={crearDesde}
            alCerrar={() => setEligiendo(false)}
          />
        ) : flujoId ? (
          <EditorDeFlujo key={flujoId} api={api} flujoId={flujoId} alCambiar={cargar} />
        ) : (
          <div className={`glass ${estilos.sinSeleccion}`}>
            <p className={estilos.sinSeleccionTitulo}>Elige un flujo o crea uno</p>
            <p className={estilos.sinSeleccionTexto}>
              Se construye por pasos y se prueba aquí mismo, con respuestas de mentira, antes de que
              hable con nadie.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
