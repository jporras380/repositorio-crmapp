import { useState } from 'react';
import type { Etiqueta, Miembro, SimulacionDeFlujo } from '../../api/tipos.ts';
import estilos from './Simulador.module.css';

interface Props {
  simulacion: SimulacionDeFlujo | null;
  respuestas: string[];
  usuarios: Miembro[];
  etiquetas: Etiqueta[];
  alCambiarRespuestas: (r: string[]) => void;
}

const FINALES: Record<SimulacionDeFlujo['final'], string> = {
  fin: 'El flujo termina aquí.',
  esperando: 'El flujo queda esperando.',
  sin_respuestas: 'Aquí espera respuesta. Escribe una para seguir.',
  limite_de_pasos: 'Demasiados pasos seguidos: revisa si hay un bucle.',
};

/**
 * Prueba del flujo sin enviar nada.
 *
 * Se pinta como una conversación porque es lo que hay que juzgar: no si el
 * grafo es correcto —de eso avisan los problemas— sino si lo que dice el bot
 * suena a alguien con quien uno querría hablar. Leer eso en una lista de nodos
 * no se puede.
 *
 * Las respuestas son de mentira y el recorrido lo calcula el servidor con el
 * mismo código que usaría el motor. Nada de esto toca la base ni la cola.
 */
export function Simulador({
  simulacion,
  respuestas,
  usuarios,
  etiquetas,
  alCambiarRespuestas,
}: Props) {
  const [borrador, setBorrador] = useState('');
  const nombreDeUsuario = (id: string) => usuarios.find((u) => u.id === id)?.nombre ?? 'alguien';
  const nombreDeEtiqueta = (id: string) =>
    etiquetas.find((e) => e.id === id)?.nombre ?? 'sin elegir';

  return (
    <aside className={`glass ${estilos.simulador}`} aria-label="Prueba del flujo">
      <header className={estilos.cabecera}>
        <h2 className={estilos.titulo}>Prueba</h2>
        <p className={estilos.subtitulo}>Respuestas de mentira. No se envía nada.</p>
      </header>

      <div className={estilos.conversacion} role="log">
        {(simulacion?.pasos ?? []).map((paso, i) => (
          <div key={i} className={estilos.grupo}>
            {paso.entrada !== undefined && (
              <p className={`${estilos.burbuja} ${estilos.contacto}`}>{paso.entrada}</p>
            )}
            {paso.efectos.map((efecto, j) => {
              if (efecto.tipo === 'enviar_texto') {
                return (
                  <p key={j} className={`${estilos.burbuja} ${estilos.bot}`}>
                    {efecto.texto}
                  </p>
                );
              }
              const texto =
                efecto.tipo === 'etiquetar'
                  ? `Pone la etiqueta «${nombreDeEtiqueta(efecto.etiquetaId)}»`
                  : efecto.tipo === 'asignar'
                    ? `Asigna la conversación a ${nombreDeUsuario(efecto.usuarioId)}`
                    : 'Cierra la conversación';
              return (
                <p key={j} className={estilos.accion}>
                  {texto}
                </p>
              );
            })}
          </div>
        ))}
        {simulacion && <p className={estilos.final}>{FINALES[simulacion.final]}</p>}
        {!simulacion && <p className={estilos.final}>Preparando la prueba…</p>}
      </div>

      <form
        className={estilos.compositor}
        onSubmit={(e) => {
          e.preventDefault();
          if (!borrador.trim()) return;
          alCambiarRespuestas([...respuestas, borrador.trim()]);
          setBorrador('');
        }}
      >
        <input
          className={estilos.entrada}
          value={borrador}
          placeholder="Responde como lo haría el contacto"
          aria-label="Respuesta de prueba"
          onChange={(e) => setBorrador(e.target.value)}
        />
        <button className={estilos.enviar} type="submit">
          Responder
        </button>
      </form>
      {respuestas.length > 0 && (
        <button className={estilos.reiniciar} onClick={() => alCambiarRespuestas([])}>
          Empezar de nuevo
        </button>
      )}
    </aside>
  );
}
