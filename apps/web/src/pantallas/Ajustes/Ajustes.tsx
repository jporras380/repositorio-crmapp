import { useEffect, useMemo, useState } from 'react';
import { crearApi } from '../../api/cliente.ts';
import type { Sesion, Yo } from '../../api/tipos.ts';
import { Barra } from '../../componentes/Barra/Barra.tsx';
import { Canales } from '../../componentes/ajustes/Canales.tsx';
import { Plantillas } from '../../componentes/ajustes/Plantillas.tsx';
import { RespuestasRapidas } from '../../componentes/ajustes/RespuestasRapidas.tsx';
import { Uso } from '../../componentes/ajustes/Uso.tsx';
import { Suscripcion } from '../../componentes/ajustes/Suscripcion.tsx';
import { Ia } from '../../componentes/ajustes/Ia.tsx';
import { Etiquetas } from '../../componentes/ajustes/Etiquetas.tsx';
import { Reparto } from '../../componentes/ajustes/Reparto.tsx';
import { Horario } from '../../componentes/ajustes/Horario.tsx';
import { irA, type Ruta } from '../../estado/ruta.ts';
import estilos from './Ajustes.module.css';

type Seccion = Extract<Ruta, { pantalla: 'ajustes' }>['seccion'];

interface Props {
  sesion: Sesion;
  seccion: Seccion;
  alSalir: () => void;
}

const SECCIONES: [Seccion, string, string][] = [
  ['canales', 'Canales', 'Números y cuentas conectadas'],
  ['etiquetas', 'Etiquetas', 'Crear, renombrar, cambiar de color y borrar'],
  ['reparto', 'Reparto', 'Asignar solas las conversaciones nuevas'],
  ['horario', 'Horario', 'Cuándo atiende el equipo y qué responder fuera'],
  ['plantillas', 'Plantillas', 'Mensajes aprobados por Meta para escribir primero'],
  ['respuestas', 'Respuestas rápidas', 'Atajos con «/» en el compositor'],
  ['ia', 'IA asistida', 'Borradores de respuesta con la clave del hotel'],
  ['uso', 'Uso del plan', 'Lo consumido este mes frente a tu plan'],
  ['suscripcion', 'Suscripción', 'Qué se paga y hasta cuándo está cubierta'],
];

/** Ajustes: menú a la izquierda, sección a la derecha. Gestionar exige rol de gestor; la API lo aplica. */
export function Ajustes({ sesion, seccion, alSalir }: Props) {
  const api = useMemo(() => crearApi(sesion.token), [sesion.token]);
  const [yo, setYo] = useState<Yo | null>(null);
  useEffect(() => {
    api
      .yo()
      .then(setYo)
      .catch(() => undefined);
  }, [api]);
  const gestor = sesion.rol !== 'agent';

  return (
    <div className={estilos.pantalla}>
      <Barra yo={yo} activa="ajustes" alSalir={alSalir} />
      <nav className={`glass ${estilos.menu}`} aria-label="Ajustes">
        <h1 className={estilos.titulo}>Ajustes</h1>
        <ul className={estilos.lista}>
          {SECCIONES.map(([id, nombre, detalle]) => (
            <li key={id}>
              <button
                className={`${estilos.item} ${seccion === id ? estilos.itemActivo : ''}`}
                aria-current={seccion === id ? 'page' : undefined}
                onClick={() => irA({ pantalla: 'ajustes', seccion: id })}
              >
                <span className={estilos.itemNombre}>{nombre}</span>
                <span className={estilos.itemDetalle}>{detalle}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className={`glass ${estilos.contenido}`}>
        {seccion === 'canales' && <Canales api={api} gestor={gestor} />}
        {seccion === 'etiquetas' && <Etiquetas api={api} gestor={gestor} />}
        {seccion === 'horario' && (
          <Horario api={api} administra={sesion.rol === 'owner' || sesion.rol === 'admin'} />
        )}
        {seccion === 'reparto' && (
          <Reparto api={api} administra={sesion.rol === 'owner' || sesion.rol === 'admin'} />
        )}
        {seccion === 'plantillas' && <Plantillas api={api} gestor={gestor} />}
        {seccion === 'respuestas' && <RespuestasRapidas api={api} gestor={gestor} />}
        {seccion === 'ia' && <Ia api={api} gestor={gestor} />}
        {seccion === 'uso' && <Uso api={api} />}
        {seccion === 'suscripcion' && <Suscripcion api={api} />}
      </main>
    </div>
  );
}
