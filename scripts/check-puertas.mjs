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
import { readdirSync, readFileSync } from 'node:fs';

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

  // --- Rutas de la API sin pantalla ---------------------------------------
  //
  // Las tres que había aquí —pedir acceso de soporte, ver qué falla y subir
  // el comprobante— se resolvieron en PR-95. Queda una.
  'PATCH /v1/cuenta/visibilidad-conversaciones':
    'DEUDA (PR-96): la política de quién ve las conversaciones de quién ' +
    '(ADR-008) se cambia por API y no tiene ajuste en pantalla. Es un ajuste ' +
    'del CLIENTE, no de la consola, y por eso no entró en PR-95.',

  // Estas dos no son deuda: son decisiones.
  'GET /v1/eventos':
    'Flujo de eventos en vivo. Va con `fetch` en estado/eventos.ts y no por ' +
    'el cliente, porque hace falta poner cabeceras y `EventSource` no deja.',
  'GET /webhooks/*': 'Lo llama Meta, no el navegador.',
  'POST /webhooks/*': 'Ídem.',
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

// Un solo recorrido del árbol para las dos guardas de estilos: la de tokens y
// la de clases. Recorrerlo dos veces costaría el doble y se separarían el día
// que alguien añadiera una carpeta a excluir en una sola de las dos.
const hojas = [];
const fuentesWeb = [];
{
  const recorrer = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.turbo') continue;
      const ruta = `${dir}/${e.name}`;
      if (e.isDirectory()) recorrer(ruta);
      else if (e.name.endsWith('.css')) hojas.push(ruta);
      else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) fuentesWeb.push(ruta);
    }
  };
  recorrer('apps');
  recorrer('packages');
}

// --- 3. Tokens de CSS usados y nunca declarados ---------------------------
//
// El reverso del mismo fallo. `var(--surface-2)` sin declarar no rompe nada:
// CSS lo resuelve a vacío y sigue pintando. El campo se queda transparente y
// nadie se entera. Se encontró con siete usos repartidos en cinco hojas, y
// uno llevaba desde 0030. Un `var()` CON valor de respaldo sí es una decisión
// —«usa esto si no hay token»— y no se marca.
{
  // Algunos tokens no los declara ninguna hoja porque su valor vive en la
  // base: el color de una etiqueta o de una etapa lo pone el componente con
  // `setProperty`. Eso es una declaración igual de válida, solo que en JS.
  const declarados = new Set();
  for (const fuente of fuentesWeb) {
    for (const m of readFileSync(fuente, 'utf8').matchAll(/setProperty\(\s*'(--[\w-]+)'/g)) {
      declarados.add(m[1]);
    }
  }
  const usados = new Map();
  for (const hoja of hojas) {
    const texto = readFileSync(hoja, 'utf8');
    for (const m of texto.matchAll(/(--[\w-]+)\s*:/g)) declarados.add(m[1]);
    // Solo `var(--x)` a secas: con coma hay respaldo y es deliberado.
    for (const m of texto.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!usados.has(m[1])) usados.set(m[1], hoja);
    }
  }
  for (const [token, hoja] of usados) {
    if (!declarados.has(token) && !PERMITIDOS[token]) {
      fallos.push(`token CSS "${token}" se usa en ${hoja} y no lo declara nadie`);
    }
  }
}

// --- 4. Clases de CSS Modules que no existen en su hoja --------------------
//
// El mismo fallo silencioso que los tokens, un nivel más arriba.
// `estilos.sesiones` cuando la hoja importada no tiene `.sesiones` devuelve
// `undefined`, React lo pinta como `class="undefined"` y el bloque sale sin
// estilo: una lista con viñetas en medio de una pantalla que no tiene ninguna.
// No falla, no avisa, y se descubre mirando una captura.
//
// Pasó de verdad: un componente nuevo usó cinco clases que vivían en la hoja
// de OTRA pantalla, porque el nombre encajaba.
{
  const claseDeHoja = new RegExp('[.]([A-Za-z_][A-Za-z0-9_-]*)(?=[^{}]*[{])', 'g');
  const importaHoja = /import\s+(\w+)\s+from\s+'(\.[^']*\.module\.css)'/g;

  for (const fuente of fuentesWeb) {
    if (!fuente.endsWith('.tsx')) continue;
    const texto = readFileSync(fuente, 'utf8');
    const carpeta = fuente.slice(0, fuente.lastIndexOf('/'));

    const importadas = new Map();
    for (const m of texto.matchAll(importaHoja)) {
      const ruta = `${carpeta}/${m[2].replace(/^\.\//, '')}`;
      try {
        const clases = new Set(
          [...readFileSync(ruta, 'utf8').matchAll(claseDeHoja)].map((c) => c[1]),
        );
        importadas.set(m[1], { ruta, clases });
      } catch {
        fallos.push(`${fuente} importa ${m[2]}, que no existe`);
      }
    }
    // Con dos hojas importadas no se sabe a cuál pertenece cada clase; esas
    // pantallas quedan fuera en vez de inventarse un fallo.
    if (importadas.size !== 1) continue;

    const [variable, hoja] = [...importadas][0];
    const uso = new RegExp('(?:^|[^A-Za-z0-9_])' + variable + '[.]([A-Za-z0-9_]+)', 'g');
    for (const m of texto.matchAll(uso)) {
      if (!hoja.clases.has(m[1]) && !PERMITIDOS[m[1]]) {
        fallos.push(`${fuente} usa "${variable}.${m[1]}" y ${hoja.ruta} no declara esa clase`);
      }
    }
  }
}

// --- 5. Rutas de la API a las que no llega el cliente web -----------------
//
// El punto ciego de las otras cuatro, y costó caro: la guarda 2 vigila
// métodos del cliente web que nadie llama, pero `POST /v1/invitaciones`
// llevaba desde fase 0 **sin que existiera el método**. No había nada que
// marcar. Resultado: un cliente que pagaba un plan de diez agentes solo podía
// usar uno, porque no había pantalla para dar de alta al segundo. Lo encontró
// el usuario preguntando, no el repositorio.
//
// Se comparan caminos, no nombres: la ruta del controlador con los segmentos
// `:param` convertidos en comodín, contra cada URL del cliente web con sus
// `${...}` convertidos igual.
{
  const controladores = [];
  const recorrerApi = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const ruta = `${dir}/${e.name}`;
      if (e.isDirectory()) recorrerApi(ruta);
      else if (e.name.endsWith('.controller.ts')) controladores.push(ruta);
    }
  };
  recorrerApi('apps/api/src');

  // `/v1/x/:id/y` y `/v1/x/${id}/y` tienen que dar la misma cadena.
  //
  // Un `${...}` solo es un comodín cuando ES el segmento entero. Pegado al
  // final de uno —`/v1/conversaciones${consulta(...)}`, que añade la cadena
  // de consulta— no lo es, y tratarlo como tal convertía media API en `v1/*`
  // y callaba la guarda. Se sustituye por una marca antes de partir, porque
  // el propio interpolado puede llevar barras dentro.
  const MARCA = '\u0000';

  /**
   * Sustituye cada `${...}` por una marca, contando llaves.
   *
   * Con una expresión regular no vale: `${consulta({ ...f })}` lleva llaves
   * dentro y `[^}]*` se para en la primera, dejando un `)}` suelto que no
   * casa con nada. Eso hacía callar a la guarda justo en las rutas con
   * filtros, que son las más usadas.
   */
  const sinInterpolados = (texto) => {
    let salida = '';
    for (let i = 0; i < texto.length; i++) {
      if (texto[i] === '$' && texto[i + 1] === '{') {
        let hondo = 1;
        i += 2;
        while (i < texto.length && hondo > 0) {
          if (texto[i] === '{') hondo++;
          else if (texto[i] === '}') hondo--;
          i++;
        }
        i--;
        salida += MARCA;
      } else salida += texto[i];
    }
    return salida;
  };

  const comodines = (camino) =>
    sinInterpolados(camino)
      .split('?')[0]
      .split('/')
      .filter(Boolean)
      .map((s) => (s.startsWith(':') || s === MARCA ? '*' : s.split(MARCA).join('')))
      .join('/');

  // Todo lo que el cliente web pide, venga de comillas o de plantilla.
  const pedidas = new Set();
  // `[^(]*` y no `<[^>]*>`: el genérico puede ir anidado —`peticion<Pagina<
  // ResumenDeConversacion>>`— y una clase que excluya `>` se para en el de
  // dentro. Otra forma de que la guarda calle sin avisar.
  const enCliente = new RegExp('peticion[^(]*[(]\\s*[`\'"]([^`\'"]+)', 'g');
  const clienteWeb = readFileSync('apps/web/src/api/cliente.ts', 'utf8');
  for (const m of clienteWeb.matchAll(enCliente)) pedidas.add(comodines(m[1]));

  const deControlador = new RegExp("@Controller[(]\\s*'([^']*)'", '');
  const deMetodo = new RegExp("@(Get|Post|Patch|Put|Delete)[(]\\s*'?([^')]*)'?\\s*[)]", 'g');

  for (const ruta of controladores) {
    const texto = readFileSync(ruta, 'utf8');
    const prefijo = texto.match(deControlador)?.[1] ?? '';
    for (const m of texto.matchAll(deMetodo)) {
      const camino = comodines(`${prefijo}/${m[2] ?? ''}`);
      const nombre = `${m[1].toUpperCase()} /${camino}`;
      if (!pedidas.has(camino) && !PERMITIDOS[nombre]) {
        fallos.push(`${nombre} existe en la API y el cliente web no la pide desde ningún sitio`);
      }
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
