import { useSesion } from './estado/sesion.ts';
import { useRuta } from './estado/ruta.ts';
import { Acceso } from './pantallas/Acceso/Acceso.tsx';
import { Bandeja } from './pantallas/Bandeja/Bandeja.tsx';
import { Ajustes } from './pantallas/Ajustes/Ajustes.tsx';

export function App() {
  const { sesion, iniciar, cerrar } = useSesion();
  const ruta = useRuta();
  if (!sesion) return <Acceso alEntrar={iniciar} />;
  if (ruta.pantalla === 'ajustes')
    return <Ajustes sesion={sesion} seccion={ruta.seccion} alSalir={cerrar} />;
  return <Bandeja sesion={sesion} conversacionInicial={ruta.conversacionId} alSalir={cerrar} />;
}
