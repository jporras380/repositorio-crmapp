import { MapaDelFlujo } from './MapaDelFlujo.tsx';
import { PLANTILLAS, type PlantillaDeFlujo } from './plantillas.ts';
import estilos from './GaleriaDePlantillas.module.css';

interface Props {
  ocupado: boolean;
  alElegir: (p: PlantillaDeFlujo) => void;
  alCerrar: () => void;
}

const GRUPOS: PlantillaDeFlujo['grupo'][] = ['Atender', 'Calificar', 'Recuperar'];

/**
 * Con qué empieza un bot.
 *
 * Cada tarjeta enseña el **mapa real** de su plantilla, no un dibujo: es el
 * mismo componente que verás al editarlo, así que lo que eliges es
 * exactamente lo que sale. Un catálogo con ilustraciones bonitas y flujos
 * distintos por dentro es la forma más rápida de perder la confianza del
 * usuario en la primera pantalla.
 */
export function GaleriaDePlantillas({ ocupado, alElegir, alCerrar }: Props) {
  return (
    <section className={`glass ${estilos.galeria}`} aria-label="Plantillas de bot">
      <header className={estilos.cabecera}>
        <div>
          <h2 className={estilos.titulo}>Crear un bot</h2>
          <p className={estilos.subtitulo}>
            Empieza por una plantilla y cámbiala a tu gusto. Todas se pueden probar antes de
            activarlas, y ninguna habla con nadie hasta que la actives.
          </p>
        </div>
        <button className={estilos.cerrar} onClick={alCerrar} disabled={ocupado}>
          Cancelar
        </button>
      </header>

      {GRUPOS.map((grupo) => {
        const dentro = PLANTILLAS.filter((p) => p.grupo === grupo);
        if (dentro.length === 0) return null;
        return (
          <div key={grupo} className={estilos.grupo}>
            <h3 className={estilos.grupoTitulo}>{grupo}</h3>
            <ul className={estilos.tarjetas}>
              {dentro.map((p) => (
                <li key={p.id}>
                  <button
                    className={estilos.tarjeta}
                    disabled={ocupado}
                    onClick={() => alElegir(p)}
                  >
                    <span className={estilos.tarjetaNombre}>{p.nombre}</span>
                    <span className={estilos.tarjetaResumen}>{p.resume}</span>
                    <span className={estilos.tarjetaMapa} aria-hidden="true">
                      <MapaDelFlujo
                        grafo={p.grafo}
                        seleccionado={null}
                        alSeleccionar={() => undefined}
                        ajustado
                      />
                    </span>
                    <span className={estilos.tarjetaDisparador}>
                      {p.disparadores.some((d) => d.tipo === 'palabra_clave')
                        ? `Arranca con: ${(p.disparadores.find((d) => d.tipo === 'palabra_clave')?.palabras ?? []).join(', ')}`
                        : 'Arranca con el primer mensaje'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
