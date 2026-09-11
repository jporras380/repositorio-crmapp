/**
 * El grafo de un Salesbot y sus transiciones.
 *
 * Estos tests son baratos y valen mucho: aquí se decide lo que el bot le dice
 * a un cliente real. Lo que se prueba no es que el código haga lo que hace,
 * sino las reglas que costaría dinero equivocar — el bucle sin espera, la
 * condición que lee la respuesta del contexto y las dos salidas distintas de
 * una espera (contestó / no contestó).
 */
import { describe, expect, it } from 'vitest';
import {
  contiene,
  decidirPaso,
  simular,
  validarGrafo,
  type Grafo,
  type Nodo,
} from '../src/flujos.js';

/** Flujo de calificación: el criterio de salida de la fase 3, en pequeño. */
const CALIFICAR: Grafo = {
  inicio: 'saludo',
  nodos: [
    {
      id: 'saludo',
      tipo: 'mensaje',
      texto: '¡Hola! ¿Buscas repuestos para tu taller?',
      siguiente: 'espera',
    },
    {
      id: 'espera',
      tipo: 'esperar_respuesta',
      segundos: 3600,
      siguiente: 'ramas',
      alExpirar: 'sin_respuesta',
    },
    {
      id: 'ramas',
      tipo: 'condicion',
      casos: [
        { contiene: ['sí', 'si', 'claro'], siguiente: 'etiqueta' },
        { contiene: ['no'], siguiente: 'despedida' },
      ],
      siNo: 'humano',
    },
    { id: 'etiqueta', tipo: 'etiquetar', etiquetaId: 'tag-lead', siguiente: 'humano' },
    { id: 'humano', tipo: 'asignar', usuarioId: 'u-ventas', siguiente: 'fin' },
    { id: 'despedida', tipo: 'mensaje', texto: 'Gracias, quedamos por aquí.', siguiente: 'fin' },
    { id: 'sin_respuesta', tipo: 'etiquetar', etiquetaId: 'tag-frio', siguiente: 'fin' },
    { id: 'fin', tipo: 'fin' },
  ],
};

describe('validarGrafo', () => {
  it('un flujo de calificación completo no tiene problemas', () => {
    expect(validarGrafo(CALIFICAR)).toEqual([]);
  });

  it('detecta el bucle que enviaría mensajes sin parar', () => {
    const g: Grafo = {
      inicio: 'a',
      nodos: [
        { id: 'a', tipo: 'mensaje', texto: 'hola', siguiente: 'b' },
        { id: 'b', tipo: 'mensaje', texto: 'otra vez', siguiente: 'a' },
      ],
    };
    expect(validarGrafo(g).map((p) => p.codigo)).toContain('bucle_sin_espera');
  });

  it('un bucle QUE ESPERA es legítimo: es un recordatorio, no spam', () => {
    const g: Grafo = {
      inicio: 'pregunta',
      nodos: [
        { id: 'pregunta', tipo: 'mensaje', texto: '¿Sigues ahí?', siguiente: 'espera' },
        {
          id: 'espera',
          tipo: 'esperar_respuesta',
          segundos: 86_400,
          siguiente: 'fin',
          alExpirar: 'pregunta',
        },
        { id: 'fin', tipo: 'fin' },
      ],
    };
    expect(validarGrafo(g)).toEqual([]);
  });

  it('destinos inexistentes, inicio desconocido y pasos huérfanos', () => {
    const g: Grafo = {
      inicio: 'no_existe',
      nodos: [
        { id: 'a', tipo: 'mensaje', texto: 'hola', siguiente: 'fantasma' },
        { id: 'suelto', tipo: 'fin' },
      ],
    };
    const codigos = validarGrafo(g).map((p) => p.codigo);
    expect(codigos).toContain('inicio_desconocido');
    expect(codigos).toContain('destino_desconocido');
    expect(codigos).toContain('inalcanzable');
  });

  it('rechaza mensajes vacíos, esperas imposibles y condiciones sin casos', () => {
    const g: Grafo = {
      inicio: 'a',
      nodos: [
        { id: 'a', tipo: 'mensaje', texto: '   ', siguiente: 'b' },
        { id: 'b', tipo: 'esperar_respuesta', segundos: 0, siguiente: 'c', alExpirar: null },
        { id: 'c', tipo: 'condicion', casos: [], siNo: null },
      ],
    };
    const codigos = validarGrafo(g).map((p) => p.codigo);
    expect(codigos).toEqual(
      expect.arrayContaining(['texto_vacio', 'espera_invalida', 'condicion_vacia']),
    );
  });

  it('una espera de más de 30 días no es una espera, es un flujo olvidado', () => {
    const g: Grafo = {
      inicio: 'a',
      nodos: [
        {
          id: 'a',
          tipo: 'esperar_respuesta',
          segundos: 40 * 86_400,
          siguiente: null,
          alExpirar: null,
        },
      ],
    };
    expect(validarGrafo(g).map((p) => p.codigo)).toContain('espera_invalida');
  });
});

describe('decidirPaso', () => {
  const nodo = (id: string): Nodo => CALIFICAR.nodos.find((n) => n.id === id)!;

  it('un mensaje describe el envío, no lo hace', () => {
    const paso = decidirPaso(nodo('saludo'), { tipo: 'entrar' });
    expect(paso.efectos).toEqual([
      { tipo: 'enviar_texto', texto: '¡Hola! ¿Buscas repuestos para tu taller?' },
    ]);
    expect(paso.siguiente).toBe('espera');
  });

  it('al entrar en una espera, el flujo se duerme en el mismo nodo', () => {
    const paso = decidirPaso(nodo('espera'), { tipo: 'entrar' });
    expect(paso.espera).toEqual({ segundos: 3600, motivo: 'respuesta' });
    expect(paso.siguiente).toBe('espera');
  });

  it('contestar y no contestar llevan a sitios distintos', () => {
    expect(decidirPaso(nodo('espera'), { tipo: 'respuesta', texto: 'sí' }).siguiente).toBe('ramas');
    expect(decidirPaso(nodo('espera'), { tipo: 'expiro' }).siguiente).toBe('sin_respuesta');
  });

  it('la condición lee la respuesta del CONTEXTO, no de la entrada', () => {
    // Es el caso real: la condición llega un paso después de la espera, con
    // entrada `entrar`. Si solo mirara la entrada, todo caería por «si no».
    const paso = decidirPaso(
      nodo('ramas'),
      { tipo: 'entrar' },
      { ultimaRespuesta: 'Claro que sí' },
    );
    expect(paso.siguiente).toBe('etiqueta');
  });

  it('sin respuesta que evaluar, la condición cae por la rama de escape', () => {
    expect(decidirPaso(nodo('ramas'), { tipo: 'entrar' }).siguiente).toBe('humano');
  });

  it('el fin puede cerrar la conversación, y solo si se le pide', () => {
    expect(decidirPaso({ id: 'f', tipo: 'fin' }, { tipo: 'entrar' }).efectos).toEqual([]);
    expect(
      decidirPaso({ id: 'f', tipo: 'fin', cerrarConversacion: true }, { tipo: 'entrar' }).efectos,
    ).toEqual([{ tipo: 'cerrar_conversacion' }]);
  });
});

describe('la pausa', () => {
  const conPausa = (segundos: number): Grafo => ({
    inicio: 'saludo',
    nodos: [
      { id: 'saludo', tipo: 'mensaje', texto: 'Hola', siguiente: 'respira' },
      { id: 'respira', tipo: 'pausa', segundos, siguiente: 'segundo' },
      { id: 'segundo', tipo: 'mensaje', texto: '¿En qué te ayudamos?', siguiente: 'fin' },
      { id: 'fin', tipo: 'fin' },
    ],
  });

  it('duerme al entrar y sigue al despertar, sin esperar a nadie', () => {
    const nodo = conPausa(5).nodos[1]!;
    const dormir = decidirPaso(nodo, { tipo: 'entrar' });
    expect(dormir.espera).toEqual({ segundos: 5, motivo: 'pausa' });
    expect(dormir.siguiente).toBe('respira');
    expect(decidirPaso(nodo, { tipo: 'expiro' }).siguiente).toBe('segundo');
  });

  it('una respuesta del contacto NO la adelanta: la pausa la manda el reloj', () => {
    const nodo = conPausa(5).nodos[1]!;
    expect(decidirPaso(nodo, { tipo: 'respuesta', texto: 'hola?' }).siguiente).toBe('segundo');
    expect(decidirPaso(nodo, { tipo: 'respuesta', texto: 'hola?' }).efectos).toEqual([]);
  });

  it('más de 24 horas no es una pausa: mientras dura, el hilo está sordo', () => {
    expect(validarGrafo(conPausa(3600)).length).toBe(0);
    expect(validarGrafo(conPausa(86_401))[0]?.codigo).toBe('pausa_invalida');
    expect(validarGrafo(conPausa(0))[0]?.codigo).toBe('pausa_invalida');
  });

  it('un bucle con pausas SIGUE siendo spam: más lento no es no', () => {
    const g: Grafo = {
      inicio: 'a',
      nodos: [
        { id: 'a', tipo: 'mensaje', texto: '¿Sigues ahí?', siguiente: 'p' },
        { id: 'p', tipo: 'pausa', segundos: 3600, siguiente: 'a' },
      ],
    };
    expect(validarGrafo(g).some((x) => x.codigo === 'bucle_sin_espera')).toBe(true);
  });

  it('en la simulación no hace perder el tiempo: se pinta el paso y sigue', () => {
    const r = simular(conPausa(3600), []);
    expect(r.pasos.map((p) => p.nodoId)).toEqual(['saludo', 'respira', 'segundo', 'fin']);
    expect(r.final).toBe('fin');
  });
});

describe('contiene', () => {
  it('ignora acentos y mayúsculas: quien escribe desde el móvil pone «si»', () => {
    expect(contiene('SÍ, me interesa', 'si')).toBe(true);
    expect(contiene('si claro', 'sí')).toBe(true);
    expect(contiene('para nada', 'sí')).toBe(false);
  });
});

describe('simular (modo prueba sin envío real)', () => {
  it('recorre el flujo con respuestas de mentira y dice qué habría hecho', () => {
    const s = simular(CALIFICAR, ['sí, busco filtros']);
    expect(s.final).toBe('fin');
    const efectos = s.pasos.flatMap((p) => p.efectos);
    expect(efectos).toEqual([
      { tipo: 'enviar_texto', texto: '¡Hola! ¿Buscas repuestos para tu taller?' },
      { tipo: 'etiquetar', etiquetaId: 'tag-lead' },
      { tipo: 'asignar', usuarioId: 'u-ventas' },
    ]);
  });

  it('la rama del «no» ni etiqueta ni asigna', () => {
    const efectos = simular(CALIFICAR, ['no gracias']).pasos.flatMap((p) => p.efectos);
    expect(efectos.map((e) => e.tipo)).toEqual(['enviar_texto', 'enviar_texto']);
  });

  it('si se acaban las respuestas, el flujo queda esperando; no inventa una', () => {
    expect(simular(CALIFICAR, []).final).toBe('sin_respuestas');
  });
});
