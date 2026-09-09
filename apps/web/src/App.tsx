import { useSesion } from './estado/sesion.ts';
import { Acceso } from './pantallas/Acceso/Acceso.tsx';
import { Bandeja } from './pantallas/Bandeja/Bandeja.tsx';

/**
 * Sin enrutador todavía: hay dos pantallas y la decisión es "¿hay sesión?".
 * Se añadirá cuando exista una tercera ruta con URL propia.
 */
export function App() {
  const { sesion, iniciar, cerrar } = useSesion();
  if (!sesion) return <Acceso alEntrar={iniciar} />;
  return <Bandeja sesion={sesion} alSalir={cerrar} />;
}
