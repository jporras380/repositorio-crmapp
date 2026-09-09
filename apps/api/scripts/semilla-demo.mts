/**
 * Datos de demostración en la base de DESARROLLO, para ver la bandeja con
 * conversaciones antes de que llegue tráfico real. Idempotente: si la cuenta
 * ya tiene la semilla, no la duplica.
 *
 *   pnpm demo:semilla            # requiere la API en marcha (pnpm dev:api)
 *
 * Usa la cuenta DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD del .env (la crea si no
 * existe, como `pnpm wa:conectar`). Escribe con el rol de migración porque
 * inserta en varias tablas de golpe; nunca se ejecuta en producción.
 */
import { Pool } from 'pg';

const base = `http://localhost:${process.env['API_PORT'] ?? '3000'}`;
function exigir(nombre: string): string {
  const v = process.env[nombre];
  if (!v) {
    console.error(`Falta ${nombre} en .env`);
    process.exit(1);
  }
  return v;
}
if (process.env['NODE_ENV'] === 'production') {
  console.error('La semilla de demo no se ejecuta en producción.');
  process.exit(1);
}

const email = exigir('DEV_LOGIN_EMAIL');
const contrasena = exigir('DEV_LOGIN_PASSWORD');

async function llamar(ruta: string, body: unknown) {
  const r = await fetch(base + ruta, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
let sesion = await llamar('/v1/sesiones', { email, contrasena });
if (sesion.status === 401) {
  sesion = await llamar('/v1/cuentas', {
    nombreDeCuenta: 'Cuenta de desarrollo',
    slug: 'dev',
    email,
    contrasena,
    nombreCompleto: 'Desarrollo',
  });
}
const tenantId = sesion.json['tenantId'];
if (typeof tenantId !== 'string') {
  console.error('No se pudo abrir sesión:', sesion.status, sesion.json);
  process.exit(1);
}

const p = new Pool({ connectionString: exigir('DATABASE_MIGRATION_URL') });
const yaHay = await p.query(
  `SELECT 1 FROM channel_accounts WHERE tenant_id = $1 AND external_id = 'pn-demo'`,
  [tenantId],
);
if (yaHay.rows.length > 0) {
  console.log('La semilla ya existe en esta cuenta. Nada que hacer.');
  await p.end();
  process.exit(0);
}
{
  const q = async <T = { id: string },>(sql: string, params: unknown[] = []) =>
    (await p.query<T>(sql, params)).rows[0]!;
  const ca = await q(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, provider_account_id, display_name, status)
     VALUES ($1,'whatsapp','pn-demo','waba-demo','Nippon Autoparts','connected') RETURNING id`,
    [tenantId],
  );
  const ig = await q(
    `INSERT INTO channel_accounts (tenant_id, channel, external_id, display_name, status)
     VALUES ($1,'instagram','ig-demo','@nipponautoparts','connected') RETURNING id`,
    [tenantId],
  );
  const tags: Record<string, string> = {};
  for (const [n, col] of [
    ['Urgente', '#ff3b30'],
    ['Cotización', '#ff9500'],
    ['Pago pendiente', '#ffcc00'],
    ['Entrega', '#34c759'],
    ['Mayorista', '#af52de'],
  ]) {
    tags[n!] = (
      await q(`INSERT INTO tags (tenant_id, name, color) VALUES ($1,$2,$3) RETURNING id`, [
        tenantId,
        n,
        col,
      ])
    ).id;
  }
  const ahora = Date.now();
  const h = (n: number) => new Date(ahora - n * 3_600_000);
  const convs: [string, string, string, number, number, string[], [string, string][]][] = [
    [
      'Lucho Ramírez',
      '+51 999 888 777',
      'whatsapp',
      0.4,
      2,
      ['Urgente', 'Cotización'],
      [
        ['in', 'Buenas, tienen el filtro de aceite GA16 para Sentra 2015?'],
        ['out', 'Hola Lucho, sí tenemos. Original Nissan a S/ 45 y alternativo a S/ 28.'],
        ['in', 'El original. Me lo pueden enviar a San Borja hoy?'],
        ['in', 'Y si tiene me indica el precio de las bujías también'],
      ],
    ],
    [
      'Carla Mendoza',
      '+51 987 654 321',
      'whatsapp',
      3,
      0,
      ['Pago pendiente'],
      [
        ['in', 'Ya hice la transferencia por las pastillas de freno, adjunto el voucher'],
        ['out', 'Recibido, Carla. Lo verificamos y te confirmamos el despacho.'],
      ],
    ],
    [
      'Taller Los Andes',
      '+51 912 345 678',
      'whatsapp',
      5,
      1,
      ['Mayorista', 'Entrega'],
      [
        ['in', 'Necesitamos 12 amortiguadores KYB para Hilux, hay stock?'],
        ['out', 'Tenemos 8 en tienda y 4 llegan el jueves. ¿Les sirve parcial?'],
        ['in', 'Sí, manden los 8 mañana temprano por favor'],
      ],
    ],
    [
      '@repuestos_jr',
      null,
      'instagram',
      9,
      1,
      [],
      [['in', 'Hola, hacen envíos a provincia? Estoy en Trujillo']],
    ],
    [
      'Rosa Quispe',
      '+51 955 111 222',
      'whatsapp',
      27,
      0,
      ['Entrega'],
      [
        ['in', 'Gracias, llegó todo bien 👍'],
        ['out', 'Qué bueno, Rosa. Cualquier cosa nos escribes.'],
      ],
    ],
    [
      'Miguel Torres',
      '+51 933 444 555',
      'whatsapp',
      30,
      0,
      ['Cotización'],
      [['in', 'Cuánto está el kit de embrague para Yaris 2012?']],
    ],
  ];
  for (const [nombre, tel, canal, haceHoras, noLeidos, etiquetas, mensajes] of convs) {
    const cuenta = canal === 'whatsapp' ? ca.id : ig.id;
    const contacto = await q(
      `INSERT INTO contacts (tenant_id, display_name) VALUES ($1,$2) RETURNING id`,
      [tenantId, nombre],
    );
    const ident = await q(
      `INSERT INTO contact_identities (tenant_id, contact_id, channel, channel_account_id, external_user_id, handle, phone_e164)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        tenantId,
        contacto.id,
        canal,
        cuenta,
        `u-${nombre}`,
        tel ?? nombre,
        tel ? tel.replace(/\s/g, '') : null,
      ],
    );
    const ultimoIn = h(haceHoras);
    const conv = await q(
      `INSERT INTO conversations (tenant_id, contact_identity_id, contact_id, channel_account_id, status, last_inbound_at, session_expires_at, unread_count)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7) RETURNING id`,
      [
        tenantId,
        ident.id,
        contacto.id,
        cuenta,
        ultimoIn,
        new Date(ultimoIn.getTime() + 24 * 3_600_000),
        noLeidos,
      ],
    );
    let t = ultimoIn.getTime() - mensajes.length * 4 * 60_000;
    for (const [dir, texto] of mensajes) {
      t += 4 * 60_000;
      await p.query(
        `INSERT INTO messages (tenant_id, conversation_id, channel_account_id, direction, type, body, status, sent_by, created_at)
         VALUES ($1,$2,$3,$4,'text',$5,$6,$7,$8)`,
        [
          tenantId,
          conv.id,
          cuenta,
          dir === 'in' ? 'inbound' : 'outbound',
          texto,
          dir === 'in' ? 'delivered' : 'read',
          'human',
          new Date(t),
        ],
      );
    }
    for (const e of etiquetas) {
      await p.query(
        `INSERT INTO conversation_tags (tenant_id, conversation_id, tag_id) VALUES ($1,$2,$3)`,
        [tenantId, conv.id, tags[e]],
      );
    }
  }
  await p.end();
  console.log('Semilla creada: 6 conversaciones, 5 etiquetas, 2 canales de demo.');
}
