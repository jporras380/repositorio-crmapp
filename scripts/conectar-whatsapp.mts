/**
 * Conecta el número de prueba de Meta a una cuenta local, leyendo TODO del
 * `.env` (gitignored). Existe para que ninguna credencial pase por el chat ni
 * por el historial de la terminal.
 *
 *   pnpm wa:conectar
 *
 * Requiere la API arrancada (`pnpm dev:api`) y en `.env`:
 *   DEV_WA_PHONE_NUMBER_ID, DEV_WA_WABA_ID, DEV_WA_ACCESS_TOKEN, META_APP_SECRET,
 *   DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD (la cuenta se crea si no existe).
 */
const base = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;

function exigir(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    console.error(`Falta ${nombre} en .env`);
    process.exit(1);
  }
  return v;
}

const email = exigir('DEV_LOGIN_EMAIL');
const contrasena = exigir('DEV_LOGIN_PASSWORD');
const cuerpo = {
  phoneNumberId: exigir('DEV_WA_PHONE_NUMBER_ID'),
  wabaId: exigir('DEV_WA_WABA_ID'),
  accessToken: exigir('DEV_WA_ACCESS_TOKEN'),
  appSecret: exigir('META_APP_SECRET'),
  displayName: 'Número de prueba de Meta',
};

async function llamar(ruta: string, body: unknown, token?: string) {
  const r = await fetch(base + ruta, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

// 1. Sesión: iniciar, y si no existe la cuenta, crearla.
let sesion = await llamar('/v1/sesiones', { email, contrasena });
if (sesion.status === 401) {
  sesion = await llamar('/v1/cuentas', {
    nombreDeCuenta: 'Cuenta de desarrollo',
    slug: 'dev',
    email,
    contrasena,
    nombreCompleto: 'Desarrollo',
  });
  console.log(`Cuenta creada (${sesion.status}).`);
}
const token = sesion.json['token'];
if (typeof token !== 'string') {
  console.error('No se pudo abrir sesión:', sesion.status, sesion.json['mensaje'] ?? sesion.json);
  process.exit(1);
}

// 2. Conectar. La API verifica contra Meta antes de guardar (cifrado).
const r = await llamar('/v1/canales/whatsapp', cuerpo, token);
if (r.status >= 200 && r.status < 300) {
  console.log('Conectado:', JSON.stringify(r.json));
} else if (r.status === 409) {
  console.log('Ese número ya estaba conectado en esta cuenta. Nada que hacer.');
} else {
  console.error(
    'Fallo al conectar:',
    r.status,
    r.json['codigo'] ?? '',
    r.json['mensaje'] ?? r.json,
  );
  process.exit(1);
}
