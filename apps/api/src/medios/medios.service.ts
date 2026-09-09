/**
 * Medios para la bandeja: URL de lectura firmada y subida directa desde el
 * navegador.
 *
 * La API nunca hace de proxy de bytes. Leer y subir van con URL firmadas de
 * vida corta contra el almacén; la API solo autoriza (RLS decide si el medio
 * es tuyo) y firma. Un proxy de imágenes por la API sería el primer cuello de
 * botella del producto y no aportaría nada.
 */
import { claveDeMedio, tipoDeMedio, type Almacen } from '@crmapp/storage';
import { contextoActual, type BaseDeDatos } from '../db.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';

const TTL_LECTURA = 5 * 60;
const TAMANO_MAXIMO_SUBIDA = 100 * 1024 * 1024;

const MIMES_PERMITIDOS = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'application/pdf',
]);

export interface OpcionesDeMedios {
  db: BaseDeDatos;
  /** `null` si el almacenamiento no está configurado: las rutas responden 503. */
  almacen: Almacen | null;
}

export class MediosService {
  readonly #db: BaseDeDatos;
  readonly #almacen: Almacen | null;

  constructor(o: OpcionesDeMedios) {
    this.#db = o.db;
    this.#almacen = o.almacen;
  }

  /** URL firmada de lectura de un medio ya almacenado. */
  async urlDeLectura(
    mediaAssetId: string,
  ): Promise<{ url: string; expiraEnSegundos: number; mime: string | null }> {
    const almacen = this.#exigirAlmacen();
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{
        status: string;
        storage_key: string | null;
        mime: string | null;
      }>(`SELECT status, storage_key, mime FROM media_assets WHERE id = $1`, [mediaAssetId]);
      const m = rows[0];
      // RLS: un medio ajeno no existe desde aquí. Misma respuesta que inexistente.
      if (!m) throw new ErrorDeNegocio('medio_no_encontrado', 'El medio no existe.', 404);
      if (m.status !== 'stored' || !m.storage_key) {
        throw new ErrorDeNegocio(
          'medio_no_disponible',
          m.status === 'failed'
            ? 'No se pudo descargar el medio del proveedor.'
            : 'El medio todavía se está procesando.',
          m.status === 'failed' ? 410 : 409,
        );
      }
      const url = await almacen.urlDeLectura(m.storage_key, TTL_LECTURA);
      return { url, expiraEnSegundos: TTL_LECTURA, mime: m.mime };
    });
  }

  /**
   * Prepara una subida directa desde el navegador.
   *
   * Crea el `media_asset` en `pending` y devuelve la URL firmada de PUT. El
   * navegador sube los bytes al almacén sin pasar por la API; después el
   * agente envía el mensaje con `mediaAssetId`. La API confirma en ese momento
   * que el objeto existe.
   */
  async prepararSubida(datos: { mime: string; bytes: number; nombre?: string | undefined }) {
    const almacen = this.#exigirAlmacen();
    const ctx = this.#exigirContexto();

    const mime = datos.mime.toLowerCase();
    if (!MIMES_PERMITIDOS.has(mime)) {
      throw new ErrorDeNegocio(
        'tipo_no_permitido',
        `Tipo de archivo no permitido: ${datos.mime}.`,
        415,
      );
    }
    if (datos.bytes <= 0 || datos.bytes > TAMANO_MAXIMO_SUBIDA) {
      throw new ErrorDeNegocio(
        'tamano_no_permitido',
        'El archivo supera los 100 MB o está vacío.',
        413,
      );
    }

    return this.#db.enTransaccion(async (c) => {
      const id = await this.#db.nuevoId(c);
      const clave = claveDeMedio(ctx.tenantId, id, mime);
      await c.query(
        `INSERT INTO media_assets (id, tenant_id, kind, storage_key, mime, bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [id, ctx.tenantId, tipoDeMedio(mime), clave, mime, datos.bytes],
      );
      const urlDeSubida = await almacen.urlDeSubida(clave, mime);
      return { mediaAssetId: id, urlDeSubida, expiraEnSegundos: 10 * 60 };
    });
  }

  /**
   * Confirma que el objeto subido existe y marca el medio como `stored`.
   * Devuelve una URL de lectura firmada, que es lo que el canal necesita para
   * enviarlo por enlace.
   */
  async confirmarSubida(
    mediaAssetId: string,
  ): Promise<{ mediaAssetId: string; urlDeLectura: string; mime: string }> {
    const almacen = this.#exigirAlmacen();
    this.#exigirContexto();
    return this.#db.enTransaccion(async (c) => {
      const { rows } = await c.query<{ storage_key: string; mime: string; status: string }>(
        `SELECT storage_key, mime, status FROM media_assets WHERE id = $1 FOR UPDATE`,
        [mediaAssetId],
      );
      const m = rows[0];
      if (!m) throw new ErrorDeNegocio('medio_no_encontrado', 'El medio no existe.', 404);
      if (m.status !== 'stored') {
        if (!(await almacen.existe(m.storage_key))) {
          throw new ErrorDeNegocio(
            'subida_incompleta',
            'El archivo todavía no está en el almacén.',
            409,
          );
        }
        await c.query(
          `UPDATE media_assets SET status = 'stored', updated_at = now() WHERE id = $1`,
          [mediaAssetId],
        );
      }
      const url = await almacen.urlDeLectura(m.storage_key, 60 * 60);
      return { mediaAssetId, urlDeLectura: url, mime: m.mime };
    });
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

  #exigirContexto() {
    const ctx = contextoActual();
    if (!ctx) throw new ErrorDeNegocio('sin_sesion', 'Se requiere sesión.', 401);
    return ctx;
  }
}
