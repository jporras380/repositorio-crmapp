/**
 * Fusionar dos fichas del mismo cliente, y poder deshacerlo.
 *
 * Es la deuda P-08, la más antigua con nombre. El caso es diario en un hotel:
 * el mismo huésped escribe por WhatsApp en marzo y por Instagram en julio, o
 * desde dos números. Son dos fichas, y quien atiende ve media historia sin
 * saber que falta la otra mitad.
 *
 * ## Lo que se mueve, y lo que no
 *
 * Se mueve **todo lo que apunta al contacto**: identidades de canal,
 * conversaciones, etiquetas, leads y reservas. Los mensajes no se tocan:
 * cuelgan de la conversación, y la conversación ya cambió de dueño.
 *
 * Los datos de la ficha (teléfono, correo, ciudad…) se **rellenan, no se
 * pisan**: lo que el destino ya tiene escrito manda, y del origen solo se toma
 * lo que faltaba. Fusionar no puede perder un dato que alguien escribió.
 *
 * ## Por qué se puede deshacer
 *
 * Mover el historial de un cliente es de las operaciones más caras de
 * equivocarse: si se fusionan dos huéspedes distintos, quien atienda leerá
 * conversaciones de otra persona. Por eso el origen **no se borra** —se marca
 * a dónde fue— y se anota qué filas se movieron exactamente. Sin esa lista,
 * deshacer sería adivinar cuál de las diez conversaciones del destino venía
 * del origen.
 */
import type { PoolClient } from 'pg';

/** Tablas que apuntan a un contacto. El orden no importa: todo va en una transacción. */
const TABLAS = ['contact_identities', 'conversations', 'contact_tags', 'leads', 'reservations'];

/** Qué se movió, por tabla: `{ conversations: ['id1', 'id2'], … }`. */
export type Movido = Record<string, string[]>;

/** Campos de la ficha que se rellenan desde el origen si el destino los tiene vacíos. */
const CAMPOS_RELLENABLES = [
  'display_name',
  'phone',
  'email',
  'city',
  'photo_url',
  'guest_type',
  'notes',
  'locale',
];

/**
 * Mueve del origen al destino y devuelve lo movido.
 *
 * `contact_tags` puede chocar —las dos fichas con la misma etiqueta— y ahí se
 * borra la del origen en vez de moverla: la etiqueta ya está donde tiene que
 * estar, y un choque no puede tumbar la fusión entera.
 */
export async function moverPertenencias(
  c: PoolClient,
  origenId: string,
  destinoId: string,
): Promise<Movido> {
  const movido: Movido = {};
  for (const tabla of TABLAS) {
    if (tabla === 'contact_tags') {
      // Sin `id` propio en la clave: se resuelve por (contacto, etiqueta).
      const { rows } = await c.query<{ tag_id: string }>(
        `UPDATE contact_tags SET contact_id = $2
          WHERE contact_id = $1
            AND tag_id NOT IN (SELECT tag_id FROM contact_tags WHERE contact_id = $2)
        RETURNING tag_id`,
        [origenId, destinoId],
      );
      await c.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [origenId]);
      movido[tabla] = rows.map((r) => r.tag_id);
      continue;
    }
    const { rows } = await c.query<{ id: string }>(
      `UPDATE ${tabla} SET contact_id = $2 WHERE contact_id = $1 RETURNING id`,
      [origenId, destinoId],
    );
    movido[tabla] = rows.map((r) => r.id);
  }
  return movido;
}

/** Devuelve cada fila movida a donde estaba. */
export async function devolverPertenencias(
  c: PoolClient,
  movido: Movido,
  origenId: string,
): Promise<void> {
  for (const tabla of TABLAS) {
    const ids = movido[tabla] ?? [];
    if (ids.length === 0) continue;
    if (tabla === 'contact_tags') {
      await c.query(
        `UPDATE contact_tags SET contact_id = $2 WHERE contact_id <> $2 AND tag_id = ANY($1::uuid[])`,
        [ids, origenId],
      );
      continue;
    }
    await c.query(`UPDATE ${tabla} SET contact_id = $2 WHERE id = ANY($1::uuid[])`, [
      ids,
      origenId,
    ]);
  }
}

/**
 * Mueve al destino los datos que le faltan y el origen sí tiene.
 *
 * **Mueve, no copia.** El teléfono y el correo llevan un índice único por
 * inquilino: copiarlos dejaría el mismo correo en las dos fichas y la fusión
 * moriría con un error de clave duplicada. Y conceptualmente es lo correcto —
 * el dato pasa a ser del destino, porque son la misma persona.
 *
 * Lo que el destino ya tenía escrito **no se pisa nunca**: fusionar no puede
 * borrar un dato que alguien escribió a mano.
 *
 * Devuelve lo movido, campo a valor, para poder devolverlo tal cual.
 */
export async function moverDatosQueFaltan(
  c: PoolClient,
  origenId: string,
  destinoId: string,
): Promise<Record<string, string | null>> {
  const campos = CAMPOS_RELLENABLES.join(', ');
  const { rows } = await c.query<Record<string, string | null> & { id: string }>(
    `SELECT id, ${campos} FROM contacts WHERE id = ANY($1::uuid[])`,
    [[origenId, destinoId]],
  );
  const origen = rows.find((r) => r.id === origenId);
  const destino = rows.find((r) => r.id === destinoId);
  if (!origen || !destino) return {};

  const aMover = CAMPOS_RELLENABLES.filter(
    (campo) => (destino[campo] ?? null) === null && (origen[campo] ?? null) !== null,
  );
  if (aMover.length === 0) return {};

  const puestos = Object.fromEntries(aMover.map((campo) => [campo, origen[campo] ?? null]));

  // Primero se vacía el origen y luego se rellena el destino: al revés, los
  // dos tendrían el mismo correo a la vez y saltaría el índice único.
  await c.query(
    `UPDATE contacts SET ${aMover.map((campo) => `${campo} = NULL`).join(', ')}, updated_at = now()
      WHERE id = $1`,
    [origenId],
  );
  await c.query(
    `UPDATE contacts SET ${aMover.map((campo, i) => `${campo} = $${i + 2}`).join(', ')},
            updated_at = now()
      WHERE id = $1`,
    [destinoId, ...aMover.map((campo) => puestos[campo])],
  );
  return puestos;
}

/** Devuelve al origen los datos que la fusión le había quitado. */
export async function devolverDatos(
  c: PoolClient,
  origenId: string,
  destinoId: string,
  puestos: Record<string, string | null>,
): Promise<void> {
  const campos = Object.keys(puestos);
  if (campos.length === 0) return;
  // Mismo orden que al mover, y por el mismo motivo: el índice único.
  await c.query(
    `UPDATE contacts SET ${campos.map((campo) => `${campo} = NULL`).join(', ')}, updated_at = now()
      WHERE id = $1`,
    [destinoId],
  );
  await c.query(
    `UPDATE contacts SET ${campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ')},
            updated_at = now()
      WHERE id = $1`,
    [origenId, ...campos.map((campo) => puestos[campo])],
  );
}
