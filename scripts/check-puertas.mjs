/**
 * Guarda de «lo declarado y sin usar».
 *
 * En un solo día aparecieron siete fallos de la misma familia: una capacidad,
 * una columna o un endpoint que existía, estaba probado, y **no lo usaba
 * nadie**. Ninguno rompía nada de forma ruidosa; todos hacían daño en
 * silencio:
 *
 * - `limitesDeMedios`: un vídeo de 38 MB viajaba hasta Meta para fallar allí.
 * - `requiereUrlPublicaParaMedios`: las fotos salían y no llegaban.
 * - `last_event_at`: la pantalla decía «sin eventos» con el canal recibiendo.
 * - `respuestasPrivadasPorComentario`: se podía gastar dos veces algo que solo
 *   se puede usar una, y no se recupera.
 * - `aplazar` y el deshacer de la fusión: función entera sin ningún botón.
 *
 * Los encontró un barrido a mano. Esta guarda lo hace en cada build, para que
 * no dependa de que a alguien se le ocurra buscarlos.
 *
 * ## Cómo se acalla un hallazgo
 *
 * En `PERMITIDOS`, con el motivo escrito. No hay forma de silenciarlo sin
 * decir por qué: una lista de excepciones sin razones vuelve a ser el
 * problema que esta guarda resuelve.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Lo que puede estar declarado y sin usar, y por qué.
 *
 * Cada entrada es una decisión, no un olvido. Si algo entra aquí «de momento»,
 * va también a [[01-ESTADO]] como deuda con nombre.
 */
const PERMITIDOS = {
  // --- Columnas de la base -------------------------------------------------
  provider_customer_id: 'Cobro manual (ADR-011): no hay pasarela que rellene esto.',
  provider_subscription_id: 'Ídem.',
  mfa_secret_id: 'Segundo factor: decidido y sin construir.',
  avatar_url: 'Foto del agente. La bandeja usa iniciales a propósito.',
  thumb_key: 'Miniaturas de medios: no se generan todavía.',
  duration_ms: 'Duración de audio y vídeo: no se lee del archivo todavía.',
  remote_url: 'URL del proveedor antes de descargar; solo la usa la descarga.',
  remote_expires_at: 'Ídem.',
  is_public: 'Vistas guardadas compartidas entre el equipo: pendiente.',
  paused_until:
    'Hasta cuándo pausó Meta una plantilla. Enviar ya se bloquea por `status`; ' +
    'esto solo enriquecería el mensaje.',
  merged_by: 'Se escribe al fusionar; solo se lee en auditoría manual.',
  source_contact_id: 'Ídem.',
  target_contact_id: 'Ídem.',
  reverted_at: 'Ídem.',

  // --- Métodos del cliente web --------------------------------------------
  borrarTipo: 'DEUDA: se pueden crear tipos de habitación y no borrarlos.',
  ejecucionesDeFlujo: 'DEUDA: no se puede ver qué hace un bot ahora mismo.',
};

const fallos = [];

function grepTodo(patron, rutas, incluye) {
  try {
    return execFileSync('grep', ['-rho', ...incluye, '-e', patron, ...rutas], {
      encoding: 'utf8',
    }).split(/\s+/);
  } catch {
    // grep devuelve 1 cuando no encuentra nada: no es un error.
    return [];
  }
}

// --- 1. Columnas declaradas en Drizzle que no usa ningún código -------------
{
  const esquema = readFileSync('packages/db/src/schema/index.ts', 'utf8');
  // Solo los constructores de COLUMNA: `index('…')` y `uniqueIndex('…')`
  // declaran nombres de índice, que no son columnas de nadie.
  const TIPOS = 'text|uuid|integer|bigint|boolean|jsonb|timestamp|char|date|citext|bytea|tsvector';
  const deColumna = new RegExp(`(?:${TIPOS})\\('([a-z_]+)'`, 'g');
  const columnas = [...new Set([...esquema.matchAll(deColumna)].map((m) => m[1]))].filter(
    (c) => !['id', 'created_at', 'updated_at'].includes(c),
  );
  for (const col of columnas) {
    const fuera = grepTodo(
      col,
      ['apps', 'packages'],
      ['--include=*.ts', '--include=*.tsx', '--exclude=index.ts'],
    );
    // `--exclude=index.ts` deja fuera el propio esquema, que no cuenta como
    // uso; pero también otros `index.ts` legítimos, así que se miran aparte.
    const enOtrosIndex = grepTodo(col, ['apps'], ['--include=index.ts']);
    if (fuera.length === 0 && enOtrosIndex.length === 0 && !PERMITIDOS[col]) {
      fallos.push(`columna "${col}" declarada en el esquema y sin usar en ningún sitio`);
    }
  }
}

// --- 2. Métodos del cliente web que no llama ningún componente -------------
{
  const cliente = readFileSync('apps/web/src/api/cliente.ts', 'utf8');
  const metodos = [...new Set([...cliente.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]))];
  const llamadas = new Set(
    grepTodo('[.][a-zA-Z]*(', ['apps/web/src'], ['--include=*.ts', '--include=*.tsx'])
      .filter((l) => l.startsWith('.'))
      .map((l) => l.slice(1, -1)),
  );
  for (const m of metodos) {
    if (!llamadas.has(m) && !PERMITIDOS[m]) {
      fallos.push(`api.${m}() existe en el cliente web y no la llama ningún componente`);
    }
  }
}

console.log('== Guarda de lo declarado y sin usar ==\n');
if (fallos.length === 0) {
  console.log('OK: check-puertas.mjs sin hallazgos.');
  process.exit(0);
}
for (const f of fallos) {
  console.log(`FALLO: ${f}`);
  console.log('       Úsalo, bórralo, o anótalo en PERMITIDOS de scripts/check-puertas.mjs');
  console.log('       con el motivo escrito.');
}
console.log(`\n${fallos.length} hallazgo(s).`);
process.exit(1);
