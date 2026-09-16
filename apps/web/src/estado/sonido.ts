/**
 * El sonido de «entró un mensaje».
 *
 * ## Por qué sintetizado y no un archivo
 *
 * Un `.mp3` son bytes que descargar, una licencia que comprobar y un archivo
 * más en el despliegue. Dos notas cortas con la Web Audio API no pesan nada,
 * suenan igual en todos los navegadores modernos y funcionan sin conexión.
 *
 * ## El problema de verdad: los navegadores no dejan sonar
 *
 * Desde 2018 ningún navegador reproduce audio hasta que la persona ha
 * interactuado con la página. Un CRM que se abre y se queda quieto **no suena
 * nunca**, y el síntoma es exactamente el que se reportó: «no llega el
 * sonido». Por eso el contexto de audio se crea y se despierta con el primer
 * gesto del agente —un clic, una tecla— y no al cargar.
 *
 * Si aun así el navegador lo bloquea, no se rompe nada: el aviso del título de
 * la pestaña sigue funcionando, y ese no necesita permiso de nadie.
 */

type ContextoDeAudio = AudioContext & { resume: () => Promise<void> };

let contexto: ContextoDeAudio | null = null;
let preparando = false;

function Constructor(): typeof AudioContext | null {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Prepara el audio con el primer gesto de la persona. Idempotente: llamarlo
 * cien veces cuesta lo mismo que una.
 */
export function prepararSonido(): void {
  if (contexto || preparando) return;
  const C = Constructor();
  if (!C) return;
  preparando = true;
  try {
    contexto = new C() as ContextoDeAudio;
    // Nace `suspended` si el gesto no contó; despertarlo es barato y silencioso.
    void contexto.resume().catch(() => undefined);
  } catch {
    contexto = null;
  } finally {
    preparando = false;
  }
}

/**
 * Dos notas cortas, suaves, que se oyen sin asustar.
 *
 * Volumen bajo y menos de medio segundo: un agente que recibe cien mensajes al
 * día no puede oír cien campanas de iglesia. Una envolvente con caída suave
 * evita el chasquido que produce cortar una onda en seco.
 */
export function sonarAvisoDeMensaje(): void {
  if (!contexto || contexto.state !== 'running') return;
  try {
    const ahora = contexto.currentTime;
    for (const [i, frecuencia] of [880, 1170].entries()) {
      const oscilador = contexto.createOscillator();
      const volumen = contexto.createGain();
      oscilador.type = 'sine';
      oscilador.frequency.value = frecuencia;
      const empieza = ahora + i * 0.12;
      volumen.gain.setValueAtTime(0.0001, empieza);
      volumen.gain.exponentialRampToValueAtTime(0.09, empieza + 0.02);
      volumen.gain.exponentialRampToValueAtTime(0.0001, empieza + 0.18);
      oscilador.connect(volumen).connect(contexto.destination);
      oscilador.start(empieza);
      oscilador.stop(empieza + 0.2);
    }
  } catch {
    // Un navegador que no deja sonar no rompe la bandeja.
  }
}

/** Solo para los tests: olvida el contexto creado. */
export function olvidarSonido(): void {
  contexto = null;
  preparando = false;
}
