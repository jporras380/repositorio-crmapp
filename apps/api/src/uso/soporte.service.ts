/**
 * Modo soporte: el cliente deja entrar, y solo un rato.
 *
 * La consola del operador (0040) ve cifras de todas las cuentas y ni una
 * conversación. Eso es lo que la hace defendible, y no se toca. Pero cuando un
 * cliente escribe «no me llegan los mensajes», mirar cifras no alcanza: hay
 * que ver su bandeja, y eso son conversaciones de huéspedes.
 *
 * ## Las cuatro condiciones
 *
 * 1. **Lo autoriza el cliente.** El operador pide y alguien de la cuenta
 *    aprueba. No hay forma de concederse acceso a uno mismo: la política de
 *    base de datos deja al rol del operador INSERTAR solicitudes sin aprobar,
 *    y nada más. Un permiso que uno se da solo es una llave maestra.
 * 2. **Caduca solo.** El plazo lo fija quien abre la puerta, no quien llama, y
 *    no hay forma de dejarlo abierto indefinidamente.
 * 3. **Solo lectura, garantizado por PostgreSQL.** El rol `crmapp_soporte` no
 *    tiene INSERT ni UPDATE ni DELETE. Un soporte que puede escribir puede
 *    romper, y entonces nadie sabe si el fallo era del cliente o de quien fue
 *    a ayudarle.
 * 4. **Queda en la auditoría del cliente**: quién pidió, quién aprobó, cuándo
 *    y por qué.
 *
 * ## Por qué se niega a funcionar sin su rol
 *
 * Si `DATABASE_SOPORTE_URL` no está puesta, el pool cae al de la aplicación,
 * que SÍ puede escribir. Antes que dar acceso de escritura sin querer, este
 * servicio se niega. Fallar cerrado.
 */
import type { PoolClient } from 'pg';
import type { Almacen } from '@crmapp/storage';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { contextoActual, type BaseDeDatos } from '../db.js';

/** Tope de lo que puede durar un permiso. Un día es una jornada de soporte. */
export const HORAS_MAXIMAS = 24;

/** Lo que vive una URL de adjunto. Igual que la de los medios del hilo. */
const TTL_ADJUNTO = 300;

export interface MensajeDeSoporte {
  id: string;
  /** `true` lo escribió la plataforma; `false`, el cliente. */
  deLaPlataforma: boolean;
  autor: string | null;
  cuerpo: string;
  creadoEn: Date;
  leidoEn: Date | null;
  /** Captura o vídeo adjunto (0044). La URL se firma al pedirla, no aquí. */
  medioId: string | null;
  medioMime: string | null;
  medioNombre: string | null;
}

export interface PermisoDeSoporte {
  id: string;
  motivo: string;
  pedidoPor: string | null;
  pedidoEn: Date;
  aprobadoEn: Date | null;
  expiraEn: Date | null;
  revocadoEn: Date | null;
  /** Calculado al leer: pendiente, activo o terminado. */
  estado: 'pendiente' | 'activo' | 'terminado';
}

export class SoporteService {
  readonly #db: BaseDeDatos;
  readonly #ahora: () => Date;
  /** `null` si el almacenamiento no esta configurado: sin adjuntos, con aviso. */
  readonly #almacen: Almacen | null;

  constructor(o: { db: BaseDeDatos; almacen?: Almacen | null; ahora?: () => Date }) {
    this.#db = o.db;
    this.#almacen = o.almacen ?? null;
    this.#ahora = o.ahora ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Lado del operador
  // -------------------------------------------------------------------------

  /**
   * Pide entrar a una cuenta, diciendo por qué.
   *
   * El motivo es obligatorio y largo: «necesito entrar» no es algo que el
   * cliente pueda valorar, y es lo único que tiene para decidir.
   */
  async pedirAcceso(datos: { tenantId: string; motivo: string }): Promise<{ id: string }> {
    const operador = await this.#exigirOperador();
    const motivo = datos.motivo.trim();
    if (motivo.length < 10) {
      throw new ErrorDeNegocio(
        'motivo_corto',
        'Explica para qué necesitas entrar: es lo único que el cliente tiene para decidir.',
        422,
      );
    }

    return this.#db.paraInquilino(datos.tenantId, async (c) => {
      try {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO support_grants (tenant_id, requested_by, reason)
           VALUES ($1, $2, $3) RETURNING id`,
          [datos.tenantId, operador, motivo],
        );
        await c.query(
          `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
           VALUES ($1, $2, 'soporte.solicitado', 'support_grant', $3, $4)`,
          [datos.tenantId, operador, rows[0]!.id, JSON.stringify({ motivo })],
        );
        return { id: rows[0]!.id };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ErrorDeNegocio(
            'ya_hay_solicitud',
            'Esa cuenta ya tiene una solicitud pendiente de responder.',
            409,
          );
        }
        throw error;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Lado del cliente
  // -------------------------------------------------------------------------

  /**
   * Lo que el cliente ve de los accesos de soporte a su cuenta.
   *
   * Incluye los terminados: el valor del registro está en poder mirar quién
   * entró el mes pasado sin preguntarle a nadie.
   */
  async permisos(): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirContexto();
    const ahora = this.#ahora();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        id: string;
        reason: string;
        pedido_por: string | null;
        requested_at: Date;
        approved_at: Date | null;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT g.id, g.reason, u.full_name AS pedido_por, g.requested_at,
                g.approved_at, g.expires_at, g.revoked_at
           FROM support_grants g
           LEFT JOIN users u ON u.id = g.requested_by
          WHERE g.tenant_id = $1
          ORDER BY g.requested_at DESC
          LIMIT 20`,
        [ctx.tenantId],
      );
      return rows.map((f) => ({
        id: f.id,
        motivo: f.reason,
        pedidoPor: f.pedido_por,
        pedidoEn: f.requested_at,
        aprobadoEn: f.approved_at,
        expiraEn: f.expires_at,
        revocadoEn: f.revoked_at,
        estado: estadoDe(f, ahora),
      }));
    });
  }

  /**
   * El cliente abre la puerta, y dice por cuánto tiempo.
   *
   * Solo owner o admin: dejar entrar a la correspondencia de los huéspedes no
   * es una decisión que deba poder tomar cualquiera del equipo.
   */
  async aprobar(id: string, horas: number): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirGestor();
    if (!Number.isFinite(horas) || horas < 1 || horas > HORAS_MAXIMAS) {
      throw new ErrorDeNegocio(
        'plazo_invalido',
        `El acceso puede durar entre 1 y ${HORAS_MAXIMAS} horas.`,
        422,
      );
    }

    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE support_grants
            SET approved_by = $2, approved_at = now(), expires_at = now() + ($3 || ' hours')::interval
          WHERE id = $1 AND approved_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
        [id, ctx.userId, String(horas)],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio(
          'solicitud_no_pendiente',
          'Esa solicitud ya no está pendiente.',
          409,
        );
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'soporte.aprobado', 'support_grant', $3, $4)`,
        [ctx.tenantId, ctx.userId, id, JSON.stringify({ horas })],
      );
    });
    return this.permisos();
  }

  /** Cortar antes de tiempo. Sirve igual para rechazar que para echar a alguien. */
  async revocar(id: string): Promise<PermisoDeSoporte[]> {
    const ctx = this.#exigirGestor();
    await this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE support_grants SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        throw new ErrorDeNegocio('nada_que_revocar', 'Ese acceso ya estaba cerrado.', 409);
      }
      await c.query(
        `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'soporte.revocado', 'support_grant', $3)`,
        [ctx.tenantId, ctx.userId, id],
      );
    });
    return this.permisos();
  }

  // -------------------------------------------------------------------------
  // El chat (0043)
  // -------------------------------------------------------------------------

  /**
   * El hilo con soporte de la cuenta en la que se está.
   *
   * Leerlo marca como leído lo que escribió el otro lado: abrir el hilo ES
   * leerlo, y aquí sí —a diferencia de la bandeja— porque no hay nada que
   * decidir. Es tu propia conversación con quien te vende el producto.
   */
  async hilo(): Promise<MensajeDeSoporte[]> {
    const ctx = this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const mensajes = await leerHilo(c, ctx.tenantId);
      await c.query(
        `UPDATE support_messages SET read_at = now()
          WHERE tenant_id = $1 AND from_platform AND read_at IS NULL`,
        [ctx.tenantId],
      );
      return mensajes;
    });
  }

  /**
   * El cliente escribe a soporte.
   *
   * Cualquiera del equipo puede: el que se topa con el problema es quien lo
   * cuenta, y obligar a avisar al dueño para poder reportarlo solo garantiza
   * que no se reporte.
   */
  async escribir(cuerpo: string, mediaAssetId?: string | null): Promise<MensajeDeSoporte[]> {
    const ctx = this.#exigirContexto();
    const texto = cuerpo.trim();
    if (!texto && !mediaAssetId) {
      throw new ErrorDeNegocio('mensaje_vacio', 'Escribe qué te pasa o adjunta una captura.', 422);
    }

    return this.#db.enTransaccion(async (c) =>
      insertar(c, {
        tenantId: ctx.tenantId,
        autorId: ctx.userId,
        deLaPlataforma: false,
        cuerpo: texto,
        mediaAssetId: mediaAssetId ?? null,
      }),
    );
  }

  /** El hilo de una cuenta, desde la plataforma. Marca leído lo del cliente. */
  async hiloDe(tenantId: string): Promise<MensajeDeSoporte[]> {
    await this.#exigirOperador();
    return this.#db.paraInquilino(tenantId, async (c) => {
      const mensajes = await leerHilo(c, tenantId);
      await c.query(
        `UPDATE support_messages SET read_at = now()
          WHERE tenant_id = $1 AND NOT from_platform AND read_at IS NULL`,
        [tenantId],
      );
      return mensajes;
    });
  }

  /**
   * La plataforma responde.
   *
   * Entra en el contexto del inquilino con el rol de la aplicación, como al
   * subir un comprobante (0039): la respuesta tiene que quedar DENTRO de la
   * cuenta del cliente, que es donde él la va a leer.
   *
   * Responder no exige permiso de soporte: contestar a quien te escribió no
   * es entrar en su casa.
   */
  async responder(tenantId: string, cuerpo: string): Promise<MensajeDeSoporte[]> {
    const operador = await this.#exigirOperador();
    const texto = cuerpo.trim();
    if (!texto) throw new ErrorDeNegocio('mensaje_vacio', 'Escribe la respuesta.', 422);

    return this.#db.paraInquilino(tenantId, async (c) =>
      insertar(c, {
        tenantId,
        autorId: operador,
        deLaPlataforma: true,
        cuerpo: texto,
        mediaAssetId: null,
      }),
    );
  }

  /**
   * La URL firmada de una captura del hilo.
   *
   * **La condición está en el SQL, no en un `if`.** El medio tiene que estar
   * colgado de un mensaje de soporte DE ESA CUENTA; si no, no se firma. Sin
   * ese JOIN, esta ruta sería un lector universal de medios para el operador
   * —una foto de un huésped incluida— y eso es justo lo que la consola promete
   * que no puede hacer.
   *
   * El cliente no pasa por aquí: para sus propios medios ya tiene
   * `/v1/medios/:id/url`, que RLS resuelve sin preguntar nada.
   */
  async urlDeAdjunto(
    tenantId: string,
    mediaAssetId: string,
  ): Promise<{ url: string; expiraEnSegundos: number }> {
    await this.#exigirOperador();
    const almacen = this.#exigirAlmacen();

    return this.#db.paraInquilino(tenantId, async (c) => {
      const { rows } = await c.query<{ storage_key: string | null; status: string }>(
        `SELECT a.storage_key, a.status
           FROM media_assets a
           JOIN support_messages m ON m.media_asset_id = a.id
          WHERE a.id = $1 AND m.tenant_id = $2
          LIMIT 1`,
        [mediaAssetId, tenantId],
      );
      const medio = rows[0];
      // Ajeno al hilo e inexistente se contestan igual: quien pregunta no
      // averigua si el identificador existe en otra cuenta.
      if (!medio) throw new ErrorDeNegocio('medio_no_encontrado', 'El medio no existe.', 404);
      if (medio.status !== 'stored' || !medio.storage_key) {
        throw new ErrorDeNegocio('medio_no_disponible', 'La captura no está subida aún.', 409);
      }
      const url = await almacen.urlDeLectura(medio.storage_key, TTL_ADJUNTO);
      return { url, expiraEnSegundos: TTL_ADJUNTO };
    });
  }

  // -------------------------------------------------------------------------
  // Mirar la cuenta, con el permiso en la mano
  // -------------------------------------------------------------------------

  /**
   * Las conversaciones del cliente, con lo que hace falta para diagnosticar.
   *
   * No es la bandeja: es la lista de lo que está fallando. Lo que se devuelve
   * de cada hilo es el estado del último mensaje y su error, porque «no me
   * llega» y «no se envía» se contestan con eso y no leyendo lo que la gente
   * se dice.
   */
  async conversacionesDe(tenantId: string): Promise<
    {
      id: string;
      canal: string;
      estado: string;
      ultimoEntranteEn: Date | null;
      ultimoSalienteEn: Date | null;
      mensajesFallidos: number;
      ultimoError: { tipo?: string; mensaje?: string } | null;
    }[]
  > {
    await this.#exigirPermisoVivo(tenantId);

    return this.#db.comoSoporteEn(tenantId, async (c) => {
      const { rows } = await c.query<{
        id: string;
        channel: string | null;
        status: string;
        last_inbound_at: Date | null;
        last_outbound_at: Date | null;
        fallidos: string;
        ultimo_error: { tipo?: string; mensaje?: string } | null;
      }>(
        // El canal cuelga de la cuenta de canal, no de la conversación.
        `SELECT c.id, ca.channel, c.status, c.last_inbound_at, c.last_outbound_at,
                (SELECT count(*) FROM messages m
                  WHERE m.conversation_id = c.id AND m.status = 'failed') AS fallidos,
                (SELECT m.error FROM messages m
                  WHERE m.conversation_id = c.id AND m.error IS NOT NULL
                  ORDER BY m.created_at DESC LIMIT 1) AS ultimo_error
           FROM conversations c
           LEFT JOIN channel_accounts ca ON ca.id = c.channel_account_id
          ORDER BY COALESCE(c.last_inbound_at, c.created_at) DESC
          LIMIT 50`,
      );
      return rows.map((f) => ({
        id: f.id,
        canal: f.channel ?? 'desconocido',
        estado: f.status,
        ultimoEntranteEn: f.last_inbound_at,
        ultimoSalienteEn: f.last_outbound_at,
        mensajesFallidos: Number(f.fallidos),
        ultimoError: f.ultimo_error,
      }));
    });
  }

  // -------------------------------------------------------------------------

  /** Que haya un permiso aprobado, sin caducar y sin revocar. Y que sea suyo. */
  async #exigirPermisoVivo(tenantId: string): Promise<void> {
    const operador = await this.#exigirOperador();

    // Sin el rol de soporte de verdad, el pool cae al de la aplicación, que
    // puede escribir. Antes que eso, no se entra.
    if (!this.#db.soporteAislado) {
      throw new ErrorDeNegocio(
        'soporte_no_configurado',
        'El modo soporte no está configurado en este servidor.',
        503,
      );
    }

    const vivo = await this.#db.paraInquilino(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT 1 FROM support_grants
          WHERE tenant_id = $1 AND requested_by = $2
            AND approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()`,
        [tenantId, operador],
      );
      return rows.length > 0;
    });
    if (!vivo) {
      throw new ErrorDeNegocio(
        'sin_permiso_de_soporte',
        'No hay un acceso de soporte vivo para esa cuenta.',
        403,
      );
    }
  }

  async #exigirOperador(): Promise<string> {
    const ctx = this.#exigirContexto();
    const esOperador = await this.#db.deAutenticacion(async (c) => {
      const { rows } = await c.query<{ is_operator: boolean }>(
        `SELECT is_operator FROM users WHERE id = $1`,
        [ctx.userId],
      );
      return rows[0]?.is_operator === true;
    });
    // 404 y no 403: quien no es operador no tiene por qué saber que esto existe.
    if (!esOperador) throw new ErrorDeNegocio('no_encontrado', 'No existe esa ruta.', 404);
    return ctx.userId;
  }

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }

  #exigirAlmacen(): Almacen {
    if (!this.#almacen) {
      throw new ErrorDeNegocio(
        'almacenamiento_no_configurado',
        'El almacenamiento de archivos no está configurado.',
        503,
      );
    }
    return this.#almacen;
  }

  #exigirGestor() {
    const ctx = this.#exigirContexto();
    if (ctx.rol !== 'owner' && ctx.rol !== 'admin') {
      throw new ErrorDeNegocio(
        'sin_permiso',
        'Solo el dueño o un administrador deja entrar a soporte.',
        403,
      );
    }
    return ctx;
  }
}

/** Pendiente, activo o terminado. Se calcula al leer: un estado guardado caduca solo mal. */
function estadoDe(
  f: { approved_at: Date | null; expires_at: Date | null; revoked_at: Date | null },
  ahora: Date,
): PermisoDeSoporte['estado'] {
  if (f.revoked_at) return 'terminado';
  if (!f.approved_at) return 'pendiente';
  if (f.expires_at && f.expires_at.getTime() <= ahora.getTime()) return 'terminado';
  return 'activo';
}

/**
 * Escribe un mensaje y devuelve el hilo ya con él dentro.
 *
 * El adjunto se valida **en el propio INSERT**, con un `SELECT` sobre
 * `media_assets` en el `VALUES`: si el medio no es de esta cuenta o no está
 * subido, la fila no entra. Comprobarlo antes en una consulta aparte dejaría
 * un hueco entre la comprobación y la escritura, y sobre todo dejaría la
 * garantía en el código en vez de en la base.
 */
async function insertar(
  c: PoolClient,
  m: {
    tenantId: string;
    autorId: string;
    deLaPlataforma: boolean;
    cuerpo: string;
    mediaAssetId: string | null;
  },
): Promise<MensajeDeSoporte[]> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO support_messages (tenant_id, author_id, from_platform, body, media_asset_id)
     SELECT $1, $2, $3, $4, $5::uuid
      WHERE $5::uuid IS NULL
         OR EXISTS (SELECT 1 FROM media_assets a
                     WHERE a.id = $5::uuid AND a.tenant_id = $1 AND a.status = 'stored')
    RETURNING id`,
    [m.tenantId, m.autorId, m.deLaPlataforma, m.cuerpo, m.mediaAssetId],
  );
  if (rows.length === 0) {
    throw new ErrorDeNegocio(
      'adjunto_no_valido',
      'Esa captura no está subida o no es de esta cuenta.',
      409,
    );
  }
  return leerHilo(c, m.tenantId);
}

/** El hilo entero, con el nombre de quien escribió cada cosa y su captura. */
async function leerHilo(c: PoolClient, tenantId: string): Promise<MensajeDeSoporte[]> {
  const { rows } = await c.query<{
    id: string;
    from_platform: boolean;
    autor: string | null;
    body: string;
    created_at: Date;
    read_at: Date | null;
    media_asset_id: string | null;
    medio_mime: string | null;
    medio_nombre: string | null;
  }>(
    `SELECT m.id, m.from_platform, u.full_name AS autor, m.body, m.created_at, m.read_at,
            m.media_asset_id, a.mime AS medio_mime, a.filename AS medio_nombre
       FROM support_messages m
       LEFT JOIN users u ON u.id = m.author_id
       LEFT JOIN media_assets a ON a.id = m.media_asset_id
      WHERE m.tenant_id = $1
      ORDER BY m.created_at
      LIMIT 200`,
    [tenantId],
  );
  return rows.map((f) => ({
    id: f.id,
    deLaPlataforma: f.from_platform,
    autor: f.autor,
    cuerpo: f.body,
    creadoEn: f.created_at,
    leidoEn: f.read_at,
    medioId: f.media_asset_id,
    medioMime: f.medio_mime,
    medioNombre: f.medio_nombre,
  }));
}
