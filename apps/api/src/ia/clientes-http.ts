/**
 * Los proveedores que no traen SDK: Gemini, GPT y Grok.
 *
 * Van con `fetch` a pelo y a propósito. Tres SDK oficiales serían tres
 * dependencias grandes, tres cadencias de actualización y tres formas de
 * romperse, para usar de cada una un solo endpoint. Lo que se necesita —una
 * petición, un JSON, un texto— cabe en unas líneas.
 *
 * ## Lo que estas dos formas tienen en común
 *
 * OpenAI y xAI hablan el mismo protocolo: xAI publicó su API como compatible
 * con la de OpenAI, así que es la misma implementación cambiando la URL. Si
 * algún día dejan de serlo, se parte en dos y ya está — el cambio queda
 * encerrado aquí.
 *
 * Gemini habla otro idioma (`contents`, `parts`, `systemInstruction`) y tiene
 * su propia función.
 */
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { ClienteDeIa, PeticionDeSugerencia } from './cliente-de-ia.js';

/** Igual que el cliente de Anthropic: una respuesta de chat es corta. */
const MAXIMO_DE_SALIDA = 2000;
const TIMEOUT_MS = 60_000;

/**
 * Traduce el código HTTP del proveedor a un error que la pantalla sabe contar.
 *
 * Los cuatro casos que le pasan a una persona de verdad: la clave está mal, la
 * clave no llega a ese modelo, el modelo no existe, o se acabó la cuota. Todo
 * lo demás es «no respondió», que es lo único honesto que se puede decir.
 */
function traducirHttp(estado: number, cuerpo: string, proveedor: string): never {
  if (estado === 401 || estado === 403) {
    throw new ErrorDeNegocio(
      'ia_clave_rechazada',
      `${proveedor} rechazó la clave de API. Revisa que esté completa y activa.`,
      422,
    );
  }
  if (estado === 404) {
    throw new ErrorDeNegocio(
      'ia_modelo_no_encontrado',
      'Ese modelo no existe para esta clave. Comprueba el nombre exacto.',
      422,
    );
  }
  if (estado === 429) {
    throw new ErrorDeNegocio(
      'ia_limite',
      `La cuenta de ${proveedor} del hotel alcanzó su límite de uso. Prueba en un momento.`,
      429,
    );
  }
  if (estado === 400) {
    // Un 400 suele ser el modelo mal escrito o un parámetro que ese modelo no
    // admite. Se enseña recortado: el cuerpo entero es ilegible para quien no
    // escribió la petición, pero sin nada no hay por dónde empezar.
    throw new ErrorDeNegocio(
      'ia_peticion_invalida',
      `${proveedor} rechazó la petición: ${cuerpo.slice(0, 200)}`,
      422,
    );
  }
  throw new ErrorDeNegocio(
    'ia_no_disponible',
    `${proveedor} no respondió (${estado}). Prueba de nuevo en un momento.`,
    503,
  );
}

/** Una petición con tope de tiempo: sin esto, un proveedor colgado cuelga al agente. */
async function pedir(url: string, init: RequestInit, proveedor: string): Promise<unknown> {
  const corte = AbortSignal.timeout(TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(url, { ...init, signal: corte });
  } catch {
    throw new ErrorDeNegocio(
      'ia_no_disponible',
      `No se pudo hablar con ${proveedor}. Prueba de nuevo en un momento.`,
      503,
    );
  }
  const texto = await r.text();
  if (!r.ok) traducirHttp(r.status, texto, proveedor);
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErrorDeNegocio('ia_no_disponible', `${proveedor} devolvió algo ilegible.`, 502);
  }
}

function exigirTexto(texto: string | undefined): string {
  const limpio = (texto ?? '').trim();
  if (!limpio) throw new ErrorDeNegocio('ia_vacia', 'La IA no devolvió ningún texto.', 502);
  return limpio;
}

// ---------------------------------------------------------------------------
// OpenAI y xAI (el mismo protocolo)
// ---------------------------------------------------------------------------

interface RespuestaDeChat {
  choices?: { message?: { content?: string } }[];
}

export function clienteCompatibleOpenai(opciones: {
  baseUrl: string;
  proveedor: string;
}): ClienteDeIa {
  const { baseUrl, proveedor } = opciones;

  return {
    async verificar({ apiKey, modelo }) {
      // Se pregunta por el modelo concreto y no por la lista entera: con la
      // lista, una clave válida daría por bueno un modelo inexistente, y el
      // fallo saldría al primer borrador delante de un cliente.
      await pedir(
        `${baseUrl}/models/${encodeURIComponent(modelo)}`,
        { headers: { authorization: `Bearer ${apiKey}` } },
        proveedor,
      );
    },

    async sugerir({ apiKey, modelo, sistema, mensaje }: PeticionDeSugerencia) {
      const json = (await pedir(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: modelo,
            max_completion_tokens: MAXIMO_DE_SALIDA,
            messages: [
              { role: 'system', content: sistema },
              { role: 'user', content: mensaje },
            ],
          }),
        },
        proveedor,
      )) as RespuestaDeChat;
      return exigirTexto(json.choices?.[0]?.message?.content);
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

interface RespuestaDeGemini {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export function clienteGemini(): ClienteDeIa {
  // La clave va en cabecera y no en la URL: una clave en la ruta acaba en los
  // registros del servidor, del proxy y del navegador.
  const cabeceras = (apiKey: string) => ({ 'x-goog-api-key': apiKey });

  return {
    async verificar({ apiKey, modelo }) {
      await pedir(
        `${GEMINI}/models/${encodeURIComponent(modelo)}`,
        { headers: cabeceras(apiKey) },
        'Google',
      );
    },

    async sugerir({ apiKey, modelo, sistema, mensaje }: PeticionDeSugerencia) {
      const json = (await pedir(
        `${GEMINI}/models/${encodeURIComponent(modelo)}:generateContent`,
        {
          method: 'POST',
          headers: { ...cabeceras(apiKey), 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sistema }] },
            contents: [{ role: 'user', parts: [{ text: mensaje }] }],
            generationConfig: { maxOutputTokens: MAXIMO_DE_SALIDA },
          }),
        },
        'Google',
      )) as RespuestaDeGemini;
      const texto = json.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .trim();
      return exigirTexto(texto);
    },
  };
}
