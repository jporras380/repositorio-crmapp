import { useSesion } from './estado/sesion.ts';
import { useRuta } from './estado/ruta.ts';
import { Acceso } from './pantallas/Acceso/Acceso.tsx';
import { Panel } from './pantallas/Panel/Panel.tsx';
import { Bandeja } from './pantallas/Bandeja/Bandeja.tsx';
import { Ajustes } from './pantallas/Ajustes/Ajustes.tsx';
import { Flujos } from './pantallas/Flujos/Flujos.tsx';
import { Leads } from './pantallas/Leads/Leads.tsx';
import { Clientes } from './pantallas/Clientes/Clientes.tsx';
import { Hotel } from './pantallas/Hotel/Hotel.tsx';
import { Reservas } from './pantallas/Reservas/Reservas.tsx';

export function App() {
  const { sesion, iniciar, cerrar } = useSesion();
  const ruta = useRuta();
  if (!sesion) return <Acceso alEntrar={iniciar} />;
  if (ruta.pantalla === 'panel') return <Panel sesion={sesion} alSalir={cerrar} />;
  if (ruta.pantalla === 'hotel') return <Hotel sesion={sesion} alSalir={cerrar} />;
  if (ruta.pantalla === 'reservas') {
    return <Reservas sesion={sesion} reservaId={ruta.reservaId} alSalir={cerrar} />;
  }
  if (ruta.pantalla === 'clientes') {
    return <Clientes sesion={sesion} clienteId={ruta.clienteId} alSalir={cerrar} />;
  }
  if (ruta.pantalla === 'leads') {
    return <Leads sesion={sesion} leadId={ruta.leadId} alSalir={cerrar} />;
  }
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
