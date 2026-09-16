import { useEffect, useRef, useState } from 'react';
import estilos from './Emojis.module.css';

/**
 * Panel de emojis, sin dependencias.
 *
 * ## Por qué a mano y no una librería
 *
 * Las librerías de emoji pesan entre 300 KB y 1,5 MB porque traen **todos** los
 * emojis con sus nombres en varios idiomas, sus tonos de piel y a menudo sus
 * imágenes. Un agente de hotel usa treinta. Cargar un megabyte en cada visita
 * para eso es un coste que paga el cliente en cada apertura del CRM, y una
 * dependencia más que mantener.
 *
 * Los emojis se pintan con la fuente del sistema: en Windows, Android e iOS
 * todos tienen los suyos y se ven como los ve el cliente en su móvil. Eso es
 * más honesto que un set propio de imágenes que no se parece a lo que llega.
 *
 * ## Qué se pierde
 *
 * No hay buscador ni tonos de piel, y la lista está elegida a mano para un
 * hotel. Quien necesite un emoji que no está puede escribirlo con el teclado
 * del sistema (Win+. en Windows), que es lo que ya hacía.
 */

const GRUPOS: { nombre: string; emojis: string[] }[] = [
  {
    nombre: 'Gestos y caras',
    emojis: [
      '🙂',
      '😀',
      '😃',
      '😄',
      '😉',
      '😊',
      '😍',
      '🥰',
      '😎',
      '🤗',
      '🙏',
      '👍',
      '👌',
      '👏',
      '🤝',
      '💪',
      '🙌',
      '👋',
      '😅',
      '😂',
      '🤔',
      '😕',
      '😢',
      '😴',
      '🤩',
      '😇',
    ],
  },
  {
    nombre: 'Hotel y viaje',
    emojis: [
      '🏨',
      '🛏️',
      '🏊',
      '🌴',
      '🏖️',
      '☀️',
      '🌙',
      '🧳',
      '🚗',
      '✈️',
      '🗺️',
      '📍',
      '🔑',
      '🛎️',
      '🚿',
      '❄️',
      '📶',
      '🅿️',
      '🐶',
      '🌊',
    ],
  },
  {
    nombre: 'Comida',
    emojis: [
      '🍽️',
      '🍳',
      '☕',
      '🥤',
      '🍹',
      '🍺',
      '🍷',
      '🥗',
      '🍗',
      '🍕',
      '🍰',
      '🎂',
      '🍫',
      '🍉',
      '🥑',
      '🐟',
    ],
  },
  {
    nombre: 'Trato y pagos',
    emojis: [
      '✅',
      '❌',
      '⚠️',
      '❤️',
      '🎉',
      '🎁',
      '💳',
      '💵',
      '🧾',
      '📅',
      '⏰',
      '📞',
      '📩',
      '📷',
      '⭐',
      '💯',
    ],
  },
];

const CLAVE_RECIENTES = 'crmapp.emojis.recientes';
const MAX_RECIENTES = 16;

function leerRecientes(): string[] {
  try {
    const crudo = localStorage.getItem(CLAVE_RECIENTES);
    const lista: unknown = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    // Navegador con el almacenamiento bloqueado: se pierde el histórico, no
    // el panel.
    return [];
  }
}

function guardarRecientes(lista: string[]): void {
  try {
    localStorage.setItem(CLAVE_RECIENTES, JSON.stringify(lista));
  } catch {
    // Ídem: no pasa nada.
  }
}

interface Props {
  alElegir: (emoji: string) => void;
  alCerrar: () => void;
}

export function Emojis({ alElegir, alCerrar }: Props) {
  const [recientes, setRecientes] = useState<string[]>(leerRecientes);
  const panel = useRef<HTMLDivElement>(null);

  // Se cierra al pulsar fuera o con Escape: es un panel flotante, y quedarse
  // abierto tapando el hilo es lo que más molesta de estos paneles.
  useEffect(() => {
    const fuera = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) alCerrar();
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') alCerrar();
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', tecla);
    };
  }, [alCerrar]);

  function elegir(emoji: string) {
    const nuevas = [emoji, ...recientes.filter((e) => e !== emoji)].slice(0, MAX_RECIENTES);
    setRecientes(nuevas);
    guardarRecientes(nuevas);
    alElegir(emoji);
  }

  const grupos = recientes.length > 0 ? [{ nombre: 'Los que más usas', emojis: recientes }] : [];

  return (
    <div className={`glass ${estilos.panel}`} ref={panel} role="dialog" aria-label="Emojis">
      {[...grupos, ...GRUPOS].map((g) => (
        <section key={g.nombre} className={estilos.grupo}>
          <h3 className={estilos.titulo}>{g.nombre}</h3>
          <div className={estilos.rejilla}>
            {g.emojis.map((e) => (
              <button
                key={`${g.nombre}-${e}`}
                type="button"
                className={estilos.emoji}
                onClick={() => elegir(e)}
                aria-label={`Emoji ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
