import { useSesion } from './estado/sesion.ts';
import { irA, useRuta } from './estado/ruta.ts';
import { Acceso } from './pantallas/Acceso/Acceso.tsx';
import { Alta } from './pantallas/Alta/Alta.tsx';
import { Panel } from './pantallas/Panel/Panel.tsx';
import { Operador } from './pantallas/Operador/Operador.tsx';
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
  // El alta va ANTES de la comprobación de sesión: quien todavía no es cliente
  // no tiene ninguna, y mandarlo al formulario de acceso es cerrarle la puerta
  // a la única persona a la que queremos venderle.
  if (!sesion && ruta.pantalla === 'alta') {
    return (
      <Alta
        alEntrar={iniciar}
        alVolver={() => irA({ pantalla: 'bandeja', conversacionId: null })}
      />
    );
  }
  if (!sesion) return <Acceso alEntrar={iniciar} alRegistrarse={() => irA({ pantalla: 'alta' })} />;
  if (ruta.pantalla === 'panel') return <Panel sesion={sesion} alSalir={cerrar} />;
  if (ruta.pantalla === 'operador') return <Operador sesion={sesion} alSalir={cerrar} />;
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
  // Con sesión, `#alta` no tiene sentido: ya es cliente. Cae a la bandeja en
  // vez de enseñarle una página de precios de algo que ya compró.
  if (ruta.pantalla === 'alta') {
    return (
      <Bandeja sesion={sesion} conversacionInicial={null} vistaInicial={null} alSalir={cerrar} />
    );
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
