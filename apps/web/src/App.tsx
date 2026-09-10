import { useSesion } from './estado/sesion.ts';
import { useRuta } from './estado/ruta.ts';
import { Acceso } from './pantallas/Acceso/Acceso.tsx';
import { Panel } from './pantallas/Panel/Panel.tsx';
import { Bandeja } from './pantallas/Bandeja/Bandeja.tsx';
import { Ajustes } from './pantallas/Ajustes/Ajustes.tsx';
import { Flujos } from './pantallas/Flujos/Flujos.tsx';

export function App() {
  const { sesion, iniciar, cerrar } = useSesion();
  const ruta = useRuta();
  if (!sesion) return <Acceso alEntrar={iniciar} />;
  if (ruta.pantalla === 'panel') return <Panel sesion={sesion} alSalir={cerrar} />;
  if (ruta.pantalla === 'flujos') {
    return <Flujos sesion={sesion} flujoId={ruta.flujoId} alSalir={cerrar} />;
  }
  if (ruta.pantalla === 'ajustes') {
    return <Ajustes sesion={sesion} seccion={ruta.seccion} alSalir={cerrar} />;
  }
  return (
    <Bandeja
      sesion={sesion}
      conversacionInicial={ruta.conversacionId}
      vistaInicial={ruta.vista ?? null}
      alSalir={cerrar}
    />
  );
}
