/**
 * Levanta el CRM entero con un comando.
 *
 * Existe por un motivo medido, no por comodidad: arrancar eran tres ventanas
 * (API, worker, web) más dos pasos que se olvidan (infraestructura y
 * migraciones), y el síntoma de olvidarse no se parece nunca a la causa. Un
 * día se depuró media hora un envío de imágenes que ya estaba arreglado,
 * porque el worker llevaba doce horas en marcha con el código viejo; otro, el
 * túnel «no conectaba» porque detrás no había nadie escuchando.
 *
 * Lo que NO hace, a propósito: abrir el túnel. `cloudflared` da una URL nueva
 * en cada arranque y hay que pegarla en Meta a mano. Automatizarlo a medias
 * sería peor que no hacerlo, porque daría la sensación de que ya está resuelto.
 * Se recuerda en pantalla y punto.
 *
 * Sin dependencias: `spawn` de Node basta, y una librería para pintar tres
 * prefijos de color no se paga con otra dependencia que mantener.
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';

function decir(quien, texto) {
  process.stdout.write(`[${quien}] ${texto}\n`);
}

/**
 * Ejecuta y espera. Devuelve `true` si salió bien.
 *
 * El comando va entero en una cadena y no como binario + argumentos: con
 * `shell: true`, Node avisa —con razón— de que los argumentos se concatenan
 * sin escapar. Aquí no hay nada que venga de fuera, pero un aviso que se
 * ignora hoy es el que tapa el que importa mañana.
 */
function correr(orden) {
  return spawnSync(orden, { stdio: 'inherit', shell: true }).status === 0;
}

/** ¿Responde PostgreSQL? Es la única pieza sin la que no arranca nada. */
function baseDeDatosViva() {
  const r = spawnSync('docker exec crmapp-dev-postgres-1 pg_isready -U crmapp', {
    stdio: 'ignore',
    shell: true,
  });
  return r.status === 0;
}

decir('crm', 'Comprobando la infraestructura...');
if (!baseDeDatosViva()) {
  decir('crm', 'PostgreSQL no responde: levantando Docker...');
  if (!correr('pnpm infra:up')) {
    decir(
      'crm',
      'No se pudo levantar la infraestructura. Comprueba que Docker Desktop esté abierto.',
    );
    process.exit(1);
  }
  // `docker compose up -d` vuelve antes de que PostgreSQL acepte conexiones.
  for (let intento = 0; intento < 30 && !baseDeDatosViva(); intento++) {
    await esperar(1000);
  }
  if (!baseDeDatosViva()) {
    decir('crm', 'PostgreSQL sigue sin responder tras 30 s. Mira "docker ps".');
    process.exit(1);
  }
}

decir('crm', 'Aplicando migraciones pendientes...');
if (!correr('pnpm db:migrate')) {
  decir('crm', 'Las migraciones fallaron. Se para aquí, antes de arrancar con el esquema viejo.');
  process.exit(1);
}

const procesos = [];
for (const [quien, guion] of [
  ['api', 'dev:api'],
  ['worker', 'dev:worker'],
  ['web', 'dev:web'],
]) {
  const hijo = spawn(`pnpm ${guion}`, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const flujo of [hijo.stdout, hijo.stderr]) {
    let resto = '';
    flujo.on('data', (trozo) => {
      // Se junta por líneas: si no, un log partido en dos trozos sale con el
      // prefijo en medio de una palabra.
      const lineas = (resto + trozo.toString()).split('\n');
      resto = lineas.pop() ?? '';
      for (const linea of lineas) if (linea.trim()) decir(quien, linea);
    });
  }
  hijo.on('exit', (codigo) => decir(quien, `se ha parado (código ${codigo}).`));
  procesos.push(hijo);
}

decir('crm', '');
decir('crm', 'API en http://localhost:3000 - Web en http://localhost:5173');
decir('crm', 'Los tres recargan solos al guardar código.');
decir('crm', '');
decir('crm', 'FALTA UN PASO A MANO, y no se puede automatizar:');
decir('crm', '  1. Abre el túnel:  cloudflared tunnel --url http://localhost:3000');
decir('crm', '  2. Copia la URL https://...trycloudflare.com que imprime.');
decir('crm', '  3. Pégala en Meta > WhatsApp > Configuración > Webhook.');
decir('crm', 'Esa URL CAMBIA cada vez que se abre el túnel. Sin ese paso no entra nada.');
decir('crm', '');

// Ctrl+C baja los tres: dejar un worker huérfano es la forma de acabar con dos
// workers compitiendo y con un misterio que depurar.
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    decir('crm', 'Parando todo...');
    for (const hijo of procesos) hijo.kill();
    process.exit(0);
  });
}
