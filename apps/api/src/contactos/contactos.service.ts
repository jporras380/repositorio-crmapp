/**
 * Clientes (migración 0019).
 *
 * La ficha que el hotel llena a mano, frente a la identidad que trae el
 * canal. `contact_identities` guarda lo que dice WhatsApp; esto guarda lo que
 * sabe la recepción.
 *
 * ## Borrar un cliente no siempre es borrarlo
 *
 * Un contacto creado por error y sin conversaciones se borra de verdad: no
 * hay nada que conservar y dejar basura marcada sería peor. Uno que ya habló
 * con el hotel **se anonimiza**: se vacían sus datos personales y se queda la
 * fila, porque sus mensajes, sus reservas y las cuentas del mes cuelgan de
 * ella. Borrarlo en cascada sería reescribir la historia del negocio para
 * cumplir un «eliminar» que el usuario entendía como «quítalo de la lista».
 *
 * ## Importar es donde se duplican los contactos
 *
 * Un CSV de dos mil filas trae el mismo teléfono tres veces, y el archivo de
 * la competencia trae correos en mayúsculas. Por eso la unicidad la impone la
 * base (índices parciales de 0019) y aquí se resuelve como **actualización**,
 * no como error: quien importa dos veces el mismo archivo espera el mismo
 * resultado, no dos mil duplicados.
 */
import type { PoolClient } from 'pg';
import { clave, escribirCsv, leerCsv } from '@crmapp/core';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

/** Tope por importación. Más que esto es una migración, no una importación. */
const MAX_FILAS = 5000;
const LIMITE_POR_DEFECTO = 50;

export type OrigenDeContacto = 'whatsapp' | 'instagram' | 'facebook' | 'tiktok' | 'web' | 'otro';

export interface DatosDeContacto {
  nombre?: string | null;
  telefono?: string | null;
  email?: string | null;
  ciudad?: string | null;
  origen?: OrigenDeContacto;
  tipoDeHuesped?: string | null;
  notas?: string | null;
  etiquetas?: string[];
}

export interface ResumenDeContacto {
  id: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  ciudad: string | null;
  origen: string;
  tipoDeHuesped: string | null;
  etiquetas: { id: string; nombre: string; color: string | null }[];
  /** Canales por los que ha escrito. Sale de sus identidades. */
  canales: string[];
  creadoEn: Date;
  ultimaActividad: Date | null;
}

export interface FichaDeContacto extends ResumenDeContacto {
  notas: string | null;
  identidades: { canal: string; handle: string | null; telefono: string | null }[];
  conversaciones: { id: string; canal: string; estado: string; ultimoMensajeEn: Date | null }[];
  /** Historial: cada oportunidad que tuvo, ganada o no. */
  reservas: {
    id: string;
    titulo: string;
    etapa: string;
    estado: string;
    importe: number;
    creadoEn: Date;
  }[];
}

export interface FiltrosDeContactos {
  q?: string | undefined;
  origen?: string | undefined;
  etiquetaId?: string | undefined;
  cursor?: string | undefined;
  limite?: number | undefined;
}

export interface ResultadoDeImportacion {
  creados: number;
  actualizados: number;
  /** Filas que no traían ni nombre ni forma de identificarlas. */
  omitidos: number;
  errores: { linea: number; motivo: string }[];
  /** Columnas del archivo que no se reconocieron, para que se vea qué se ignoró. */
  columnasIgnoradas: string[];
}

/** Cabeceras que se aceptan para cada campo, en varias formas de escribirlas. */
const COLUMNAS: Record<string, string[]> = {
  nombre: ['nombre', 'nombrecompleto', 'name', 'cliente', 'huesped', 'contacto'],
  telefono: ['telefono', 'celular', 'movil', 'whatsapp', 'phone', 'numero'],
  email: ['email', 'correo', 'correoelectronico', 'mail'],
  ciudad: ['ciudad', 'city', 'procedencia', 'localidad'],
  origen: ['origen', 'source', 'canal', 'fuente'],
  tipoDeHuesped: ['tipodehuesped', 'tipo', 'segmento', 'guesttype'],
  notas: ['notas', 'nota', 'observaciones', 'observacion', 'comentarios'],
};

const ORIGENES = new Set(['whatsapp', 'instagram', 'facebook', 'tiktok', 'web', 'otro']);

export class ContactosService {
  readonly #db: BaseDeDatos;

  constructor(opciones: { db: BaseDeDatos }) {
    this.#db = opciones.db;
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async listar(
    filtros: FiltrosDeContactos = {},
  ): Promise<{ items: ResumenDeContacto[]; siguienteCursor: string | null }> {
    this.#exigirContexto();
    const limite = Math.min(Math.max(filtros.limite ?? LIMITE_POR_DEFECTO, 1), 200);
    return this.#db.enTransaccion(async (c) => {
      const params: unknown[] = [];
      const p = (v: unknown) => `$${params.push(v)}`;
      const donde = ['ct.anonymized_at IS NULL'];

      if (filtros.q) {
        const patron = `%${filtros.q.trim()}%`;
        const i = p(patron);
        donde.push(
          `(ct.display_name ILIKE ${i} OR ct.phone ILIKE ${i} OR ct.email::text ILIKE ${i} OR ct.city ILIKE ${i})`,
        );
      }
      if (filtros.origen) donde.push(`ct.source = ${p(filtros.origen)}`);
      if (filtros.etiquetaId) {
        donde.push(
          `EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = ct.id AND t.tag_id = ${p(filtros.etiquetaId)})`,
        );
      }
      if (filtros.cursor) {
        const cur = decodificarCursor(filtros.cursor);
        donde.push(`(ct.created_at, ct.id) < (${p(cur.t)}::timestamptz, ${p(cur.id)}::uuid)`);
      }

      const { rows } = await c.query<FilaDeContacto>(
        `SELECT ct.id, ct.display_name, ct.phone, ct.email::text AS email, ct.city,
                ct.source, ct.guest_type, ct.created_at,
                (SELECT max(cv.last_inbound_at) FROM conversations cv WHERE cv.contact_id = ct.id)
                  AS ultima_actividad,
                (SELECT array_agg(DISTINCT ci.channel) FROM contact_identities ci
                  WHERE ci.contact_id = ct.id) AS canales
           FROM contacts ct
          WHERE ${donde.join(' AND ')}
          ORDER BY ct.created_at DESC, ct.id DESC
          LIMIT ${limite + 1}`,
        params,
      );

      const hayMas = rows.length > limite;
      const pagina = rows.slice(0, limite);
      const etiquetas = await this.#etiquetasDe(
        c,
        pagina.map((f) => f.id),
      );
      const ultimo = pagina.at(-1);
      return {
        items: pagina.map((f) => resumen(f, etiquetas.get(f.id) ?? [])),
        siguienteCursor:
          hayMas && ultimo
            ? codificarCursor({ t: ultimo.created_at.toISOString(), id: ultimo.id })
            : null,
      };
    });
  }

  async ficha(id: string): Promise<FichaDeContacto> {
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<FilaDeContacto & { notes: string | null }>(
        `SELECT ct.id, ct.display_name, ct.phone, ct.email::text AS email, ct.city,
                ct.source, ct.guest_type, ct.notes, ct.created_at,
                (SELECT max(cv.last_inbound_at) FROM conversations cv WHERE cv.contact_id = ct.id)
                  AS ultima_actividad,
                (SELECT array_agg(DISTINCT ci.channel) FROM contact_identities ci
                  WHERE ci.contact_id = ct.id) AS canales
           FROM contacts ct
          WHERE ct.id = $1 AND ct.anonymized_at IS NULL`,
        [id],
      );
      const f = rows[0];
      if (!f) throw new ErrorDeNegocio('contacto_no_encontrado', 'Ese cliente no existe.', 404);

      const { rows: identidades } = await c.query<{
        channel: string;
        handle: string | null;
        phone_e164: string | null;
      }>(
        `SELECT channel, handle, phone_e164 FROM contact_identities
          WHERE contact_id = $1 ORDER BY created_at`,
        [id],
      );
      const { rows: conversaciones } = await c.query<{
        id: string;
        canal: string;
        status: string;
        last_inbound_at: Date | null;
      }>(
        `SELECT cv.id, ca.channel AS canal, cv.status, cv.last_inbound_at
           FROM conversations cv
           JOIN channel_accounts ca ON ca.id = cv.channel_account_id
          WHERE cv.contact_id = $1
          ORDER BY cv.last_inbound_at DESC NULLS LAST
          LIMIT 20`,
        [id],
      );
      // El «historial de reservas» que pide la ficha: las ESTANCIAS, no las
      // oportunidades del embudo. Una consulta que no llegó a reservar vive en
      // el embudo; aquí se ve lo que el huésped reservó de verdad, con fechas.
      const { rows: reservas } = await c.query<{
        id: string;
        title: string;
        etapa: string;
        status: string;
        amount_cents: string;
        created_at: Date;
      }>(
        `SELECT r.id,
                r.room_type_name || ' · ' || to_char(r.check_in, 'DD/MM/YYYY')
                  || ' → ' || to_char(r.check_out, 'DD/MM/YYYY') AS title,
                r.status AS etapa, r.status, r.total_cents AS amount_cents, r.created_at
           FROM reservations r
          WHERE r.contact_id = $1
          ORDER BY r.check_in DESC
          LIMIT 50`,
        [id],
      );
      const etiquetas = await this.#etiquetasDe(c, [id]);

      return {
        ...resumen(f, etiquetas.get(id) ?? []),
        notas: f.notes,
        identidades: identidades.map((i) => ({
          canal: i.channel,
          handle: i.handle,
          telefono: i.phone_e164,
        })),
        conversaciones: conversaciones.map((cv) => ({
          id: cv.id,
          canal: cv.canal,
          estado: cv.status,
          ultimoMensajeEn: cv.last_inbound_at,
        })),
        reservas: reservas.map((r) => ({
          id: r.id,
          titulo: r.title,
          etapa: r.etapa,
          estado: r.status,
          importe: Number(r.amount_cents),
          creadoEn: r.created_at,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  async crear(datos: DatosDeContacto): Promise<{ id: string }> {
    const ctx = this.#exigirContexto();
    if (!datos.nombre?.trim() && !datos.telefono?.trim() && !datos.email?.trim()) {
      throw new ErrorDeNegocio(
        'contacto_vacio',
        'Un cliente necesita al menos nombre, teléfono o correo.',
        422,
      );
    }
    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      await c
        .query(
          `INSERT INTO contacts (id, tenant_id, display_name, phone, email, city, source, guest_type, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            ctx.tenantId,
            limpiar(datos.nombre),
            telefonoNormalizado(datos.telefono),
            limpiar(datos.email),
            limpiar(datos.ciudad),
            datos.origen ?? 'otro',
            limpiar(datos.tipoDeHuesped),
            limpiar(datos.notas),
          ],
        )
        .catch(duplicado);
      if (datos.etiquetas) await this.#ponerEtiquetas(c, ctx.tenantId, id, datos.etiquetas);
      return { id };
    });
  }

  async editar(id: string, datos: DatosDeContacto): Promise<void> {
    const ctx = this.#exigirContexto();
    await this.#db.enTransaccion(async (c) => {
      const { rowCount } = await c
        .query(
          `UPDATE contacts
              SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
                  phone        = CASE WHEN $4::boolean THEN $5 ELSE phone END,
                  email        = CASE WHEN $6::boolean THEN $7 ELSE email END,
                  city         = CASE WHEN $8::boolean THEN $9 ELSE city END,
                  source       = COALESCE($10, source),
                  guest_type   = CASE WHEN $11::boolean THEN $12 ELSE guest_type END,
                  notes        = CASE WHEN $13::boolean THEN $14 ELSE notes END,
                  updated_at   = now()
            WHERE id = $1 AND anonymized_at IS NULL`,
          [
            id,
            datos.nombre !== undefined,
            limpiar(datos.nombre),
            datos.telefono !== undefined,
            telefonoNormalizado(datos.telefono),
            datos.email !== undefined,
            limpiar(datos.email),
            datos.ciudad !== undefined,
            limpiar(datos.ciudad),
            datos.origen ?? null,
            datos.tipoDeHuesped !== undefined,
            limpiar(datos.tipoDeHuesped),
            datos.notas !== undefined,
            limpiar(datos.notas),
          ],
        )
        .catch(duplicado);
      if (rowCount === 0) {
        throw new ErrorDeNegocio('contacto_no_encontrado', 'Ese cliente no existe.', 404);
      }
      if (datos.etiquetas) await this.#ponerEtiquetas(c, ctx.tenantId, id, datos.etiquetas);
    });
  }

  /**
   * Borra o anonimiza, según lo que cuelgue del contacto. Devuelve qué hizo,
   * porque la interfaz tiene que poder decirlo con palabras distintas.
   */
  async borrar(id: string): Promise<{ accion: 'borrado' | 'anonimizado' }> {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'permiso_insuficiente',
        'Solo el propietario o un administrador puede borrar clientes.',
        403,
      );
    }
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ conversaciones: string; reservas: string }>(
        `SELECT (SELECT count(*) FROM conversations WHERE contact_id = $1) AS conversaciones,
                (SELECT count(*) FROM leads WHERE contact_id = $1) AS reservas
           FROM contacts WHERE id = $1 AND anonymized_at IS NULL`,
        [id],
      );
      const f = rows[0];
      if (!f) throw new ErrorDeNegocio('contacto_no_encontrado', 'Ese cliente no existe.', 404);
      const tieneHistoria = Number(f.conversaciones) > 0 || Number(f.reservas) > 0;

      if (!tieneHistoria) {
        await c.query(`DELETE FROM contacts WHERE id = $1`, [id]);
      } else {
        await c.query(
          `UPDATE contacts
              SET display_name = 'Cliente eliminado', phone = NULL, email = NULL,
                  city = NULL, photo_url = NULL, guest_type = NULL, notes = NULL,
                  attributes = '{}'::jsonb, anonymized_at = now(), updated_at = now()
            WHERE id = $1`,
          [id],
        );
        // Las identidades son el rastro más personal que queda: el número de
        // teléfono y el @ del perfil. Se van con la persona.
        await c.query(
          `UPDATE contact_identities SET handle = NULL, phone_e164 = NULL,
                  profile = '{}'::jsonb, updated_at = now()
            WHERE contact_id = $1`,
          [id],
        );
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'contacto.eliminado', 'contact', $3, $4)`,
        [
          ctx.tenantId,
          ctx.userId,
          id,
          JSON.stringify({ accion: tieneHistoria ? 'anonimizado' : 'borrado' }),
        ],
      );
      return { accion: tieneHistoria ? 'anonimizado' : 'borrado' };
    });
  }

  // -------------------------------------------------------------------------
  // Importar y exportar
  // -------------------------------------------------------------------------

  /**
   * Importa un CSV. Nunca falla entero: cada fila que no entra se cuenta y se
   * explica con su número de línea. Un archivo de dos mil filas que se cae en
   * la 1.999 y no guarda nada es peor que no tener importación.
   */
  async importar(
    csv: string,
    opciones: { prefijo?: string | undefined } = {},
  ): Promise<ResultadoDeImportacion> {
    const ctx = this.#exigirContexto();
    const tabla = leerCsv(csv);
    if (tabla.cabeceras.length === 0) {
      throw new ErrorDeNegocio('csv_vacio', 'El archivo no tiene ninguna columna.', 422);
    }
    if (tabla.filas.length > MAX_FILAS) {
      throw new ErrorDeNegocio(
        'csv_demasiado_grande',
        `El archivo trae ${tabla.filas.length} filas y el tope son ${MAX_FILAS}. Pártelo.`,
        413,
      );
    }

    // Qué columna del archivo es cada campo nuestro.
    const posicion = new Map<string, number>();
    const reconocidas = new Set<number>();
    for (const [campo, nombres] of Object.entries(COLUMNAS)) {
      const i = tabla.cabeceras.findIndex((cab) => nombres.includes(clave(cab)));
      if (i >= 0) {
        posicion.set(campo, i);
        reconocidas.add(i);
      }
    }
    if (!posicion.has('nombre') && !posicion.has('telefono') && !posicion.has('email')) {
      throw new ErrorDeNegocio(
        'csv_sin_columnas_utiles',
        'No se reconoce ninguna columna. Hacen falta al menos «nombre», «teléfono» o «correo».',
        422,
        { columnas: tabla.cabeceras },
      );
    }

    const resultado: ResultadoDeImportacion = {
      creados: 0,
      actualizados: 0,
      omitidos: 0,
      errores: [],
      columnasIgnoradas: tabla.cabeceras.filter((_, i) => !reconocidas.has(i)),
    };
    const valor = (fila: string[], campo: string) => {
      const i = posicion.get(campo);
      const v = i === undefined ? '' : (fila[i] ?? '').trim();
      return v === '' ? null : v;
    };

    await this.#db.enTransaccion(async (c) => {
      for (const [n, fila] of tabla.filas.entries()) {
        const linea = n + 2; // +1 por la cabecera, +1 porque nadie cuenta desde cero
        const nombre = valor(fila, 'nombre');
        const telefono = telefonoNormalizado(valor(fila, 'telefono'), opciones.prefijo);
        const email = valor(fila, 'email');
        if (!nombre && !telefono && !email) {
          resultado.omitidos++;
          continue;
        }
        const origenCrudo = (valor(fila, 'origen') ?? '').toLowerCase();
        const origen = ORIGENES.has(origenCrudo) ? origenCrudo : 'otro';

        try {
          // Actualizar y no fallar: importar dos veces el mismo archivo tiene
          // que dar el mismo resultado, no dos mil duplicados.
          const { rows } = await c.query<{ id: string; nuevo: boolean }>(
            `WITH encontrado AS (
               SELECT id FROM contacts
                WHERE anonymized_at IS NULL
                  AND (($2::text IS NOT NULL AND phone = $2)
                    OR ($3::citext IS NOT NULL AND email = $3))
                LIMIT 1
             ), actualizado AS (
               UPDATE contacts SET
                 display_name = COALESCE($1, display_name),
                 phone        = COALESCE($2, phone),
                 email        = COALESCE($3, email),
                 city         = COALESCE($4, city),
                 guest_type   = COALESCE($5, guest_type),
                 notes        = COALESCE($6, notes),
                 updated_at   = now()
                WHERE id = (SELECT id FROM encontrado)
                RETURNING id
             ), creado AS (
               INSERT INTO contacts (tenant_id, display_name, phone, email, city, source, guest_type, notes)
               SELECT $7, $1, $2, $3, $4, $8, $5, $6
                WHERE NOT EXISTS (SELECT 1 FROM encontrado)
               RETURNING id
             )
             SELECT id, false AS nuevo FROM actualizado
             UNION ALL
             SELECT id, true AS nuevo FROM creado`,
            [
              nombre,
              telefono,
              email,
              valor(fila, 'ciudad'),
              valor(fila, 'tipoDeHuesped'),
              valor(fila, 'notas'),
              ctx.tenantId,
              origen,
            ],
          );
          if (rows[0]?.nuevo) resultado.creados++;
          else resultado.actualizados++;
        } catch (e) {
          const codigo = (e as { code?: string }).code;
          resultado.errores.push({
            linea,
            motivo:
              codigo === '23505'
                ? 'El teléfono o el correo ya están en otro cliente.'
                : 'No se pudo guardar esta fila.',
          });
        }
      }
    });
    return resultado;
  }

  /** Exporta lo mismo que se ve en la lista, con los filtros puestos. */
  async exportar(filtros: FiltrosDeContactos = {}): Promise<string> {
    const cabeceras = [
      'nombre',
      'telefono',
      'correo',
      'ciudad',
      'origen',
      'tipo de huesped',
      'canales',
      'etiquetas',
      'alta',
    ];
    const filas: string[][] = [];
    let cursor: string | null = null;
    // Se pagina por dentro: exportar no puede depender de que quepa todo en
    // una consulta, y tampoco puede traerse la tabla entera a memoria de golpe.
    do {
      const pagina: { items: ResumenDeContacto[]; siguienteCursor: string | null } =
        await this.listar({ ...filtros, limite: 200, ...(cursor ? { cursor } : {}) });
      for (const x of pagina.items) {
        filas.push([
          x.nombre ?? '',
          x.telefono ?? '',
          x.email ?? '',
          x.ciudad ?? '',
          x.origen,
          x.tipoDeHuesped ?? '',
          x.canales.join(' '),
          x.etiquetas.map((e) => e.nombre).join(' | '),
          x.creadoEn.toISOString().slice(0, 10),
        ]);
      }
      cursor = pagina.siguienteCursor;
    } while (cursor && filas.length < MAX_FILAS);
    return escribirCsv(cabeceras, filas);
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  async #etiquetasDe(
    c: PoolClient,
    ids: string[],
  ): Promise<Map<string, { id: string; nombre: string; color: string | null }[]>> {
    const mapa = new Map<string, { id: string; nombre: string; color: string | null }[]>();
    if (ids.length === 0) return mapa;
    const { rows } = await c.query<{
      contact_id: string;
      id: string;
      name: string;
      color: string | null;
    }>(
      `SELECT ct.contact_id, t.id, t.name, t.color
         FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ANY($1::uuid[])
        ORDER BY t.name`,
      [ids],
    );
    for (const r of rows) {
      const lista = mapa.get(r.contact_id) ?? [];
      lista.push({ id: r.id, nombre: r.name, color: r.color });
      mapa.set(r.contact_id, lista);
    }
    return mapa;
  }

  async #ponerEtiquetas(
    c: PoolClient,
    tenantId: string,
    contactId: string,
    etiquetas: string[],
  ): Promise<void> {
    await c.query(`DELETE FROM contact_tags WHERE contact_id = $1`, [contactId]);
    for (const tagId of etiquetas) {
      await c.query(
        `INSERT INTO contact_tags (tenant_id, contact_id, tag_id)
         SELECT $1, $2, id FROM tags WHERE id = $3
         ON CONFLICT DO NOTHING`,
        [tenantId, contactId, tagId],
      );
    }
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

interface FilaDeContacto {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  source: string;
  guest_type: string | null;
  created_at: Date;
  ultima_actividad: Date | null;
  canales: string[] | null;
}

function resumen(
  f: FilaDeContacto,
  etiquetas: { id: string; nombre: string; color: string | null }[],
): ResumenDeContacto {
  return {
    id: f.id,
    nombre: f.display_name,
    telefono: f.phone,
    email: f.email,
    ciudad: f.city,
    origen: f.source,
    tipoDeHuesped: f.guest_type,
    etiquetas,
    canales: f.canales ?? [],
    creadoEn: f.created_at,
    ultimaActividad: f.ultima_actividad,
  };
}

const limpiar = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Normaliza un teléfono lo justo: fuera espacios, guiones y paréntesis, y
 * `00` inicial a `+`.
 *
 * **No se inventa el prefijo del país.** Si el archivo trae «999111222», eso
 * es lo que se guarda, salvo que quien importa diga explícitamente con qué
 * prefijo completar — y esa decisión se toma en la pantalla, a la vista, no
 * aquí adivinando que todo el mundo es de Perú.
 */
export function telefonoNormalizado(
  v: string | null | undefined,
  prefijo?: string | undefined,
): string | null {
  const s = (v ?? '').replace(/[\s()\-.]/g, '').trim();
  if (!s) return null;
  const conMas = s.startsWith('00') ? `+${s.slice(2)}` : s;
  if (conMas.startsWith('+')) return conMas;
  if (prefijo && /^\d{6,}$/.test(conMas)) {
    return `${prefijo.startsWith('+') ? prefijo : `+${prefijo}`}${conMas}`;
  }
  return conMas;
}

function duplicado(e: { code?: string; constraint?: string }): never {
  if (e.code === '23505') {
    const cual = e.constraint?.includes('email') ? 'correo' : 'teléfono';
    throw new ErrorDeNegocio('contacto_duplicado', `Ya hay otro cliente con ese ${cual}.`, 409);
  }
  throw e;
}

function codificarCursor(c: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodificarCursor(cursor: string): { t: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof c.t !== 'string' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new ErrorDeNegocio('cursor_invalido', 'El cursor de paginación no es válido.', 400);
  }
}
