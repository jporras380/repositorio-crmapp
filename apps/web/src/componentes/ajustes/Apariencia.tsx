import { useState } from 'react';
import {
  guardarApariencia,
  leerApariencia,
  sistemaPideMenosTransparencia,
  type Apariencia as Preferencia,
  type Tema,
  type Vidrio,
} from '../../vista/apariencia.ts';
import estilos from './Apariencia.module.css';

/**
 * Cómo se ve esto.
 *
 * ## Por qué hay un nivel «Sólido» y no solo un interruptor
 *
 * El aspecto de vidrio cuesta contraste, y cuánto cuesta depende de dónde se
 * mire: no es lo mismo el PC del mostrador con el ventanal detrás que un
 * portátil de noche. Un interruptor obliga a elegir entre bonito e ilegible;
 * tres niveles dejan quedarse en medio, que es donde está casi todo el mundo.
 *
 * ## Por qué se dice lo que cuesta cada nivel
 *
 * «Cristal» se ve mejor en una captura y peor en una jornada. Ofrecerlo sin
 * decirlo sería vender lo bonito y callar la letra pequeña.
 *
 * ## Se guarda en el navegador, no en la cuenta
 *
 * Es una preferencia del aparato. El motivo largo está en
 * `src/vista/apariencia.ts`.
 */

const TEMAS: [Tema, string, string][] = [
  ['auto', 'Automático', 'Sigue a tu sistema: claro de día, oscuro de noche'],
  ['claro', 'Claro', 'Siempre claro, aunque el sistema esté en oscuro'],
  ['oscuro', 'Oscuro', 'Siempre oscuro. Cansa menos con poca luz'],
];

const VIDRIOS: [Vidrio, string, string][] = [
  ['solido', 'Sólido', 'Sin transparencia. El texto se lee mejor que de ninguna otra forma'],
  ['vidrio', 'Vidrio', 'Lo de siempre: se intuye el fondo sin estorbar'],
  ['cristal', 'Cristal', 'Como el panel de un iPhone. Más bonito y algo menos legible'],
];

export function Apariencia() {
  const [pref, setPref] = useState<Preferencia>(() => leerApariencia());
  const [guardado, setGuardado] = useState(false);
  const sistemaPideMenos = sistemaPideMenosTransparencia();

  function cambiar(cambio: Partial<Preferencia>) {
    const nueva = { ...pref, ...cambio };
    setPref(nueva);
    guardarApariencia(nueva);
    setGuardado(true);
  }

  return (
    <div className={estilos.apariencia}>
      <section className={estilos.bloque}>
        <h3 className={estilos.titulo}>Tema</h3>
        <p className={estilos.pista}>Se aplica al momento, sin recargar.</p>
        <Opciones
          nombre="tema"
          opciones={TEMAS}
          elegida={pref.tema}
          alElegir={(v) => cambiar({ tema: v })}
        />
      </section>

      <section className={estilos.bloque}>
        <h3 className={estilos.titulo}>Transparencia</h3>
        <p className={estilos.pista}>
          Cuánto se ve el fondo a través de los paneles. Más transparencia se ve mejor; menos se lee
          mejor.
        </p>
        <Opciones
          nombre="vidrio"
          opciones={VIDRIOS}
          elegida={pref.vidrio}
          alElegir={(v) => cambiar({ vidrio: v })}
        />

        {/* Solo sale a quien le afecta: para los demás sería ruido. */}
        {sistemaPideMenos && (
          <p className={estilos.nota}>
            Tu sistema pide menos transparencia y el CRM lo respeta mientras no elijas aquí. Si
            eliges «Cristal», mandas tú.
          </p>
        )}
      </section>

      {guardado && (
        <p className={estilos.aviso} role="status">
          Guardado en este navegador. En otro ordenador vuelve a elegirlo.
        </p>
      )}
    </div>
  );
}

/**
 * Los tres niveles como botones de radio de verdad.
 *
 * Con `<input type="radio">` las flechas del teclado recorren el grupo y un
 * lector de pantalla dice «2 de 3». Unos `<button>` con aspecto de pestañas no
 * hacen ninguna de las dos cosas, y esta pantalla es justo la que va a abrir
 * quien tiene problemas para ver.
 */
function Opciones<T extends string>({
  nombre,
  opciones,
  elegida,
  alElegir,
}: {
  nombre: string;
  opciones: [T, string, string][];
  elegida: T;
  alElegir: (v: T) => void;
}) {
  return (
    <div className={estilos.opciones}>
      {opciones.map(([valor, titulo, detalle]) => (
        <label
          key={valor}
          className={`${estilos.opcion} ${elegida === valor ? estilos.opcionElegida : ''}`}
        >
          <input
            className="visually-hidden"
            type="radio"
            name={nombre}
            value={valor}
            checked={elegida === valor}
            onChange={() => alElegir(valor)}
          />
          <span className={estilos.opcionTitulo}>{titulo}</span>
          <span className={estilos.opcionDetalle}>{detalle}</span>
        </label>
      ))}
    </div>
  );
}
