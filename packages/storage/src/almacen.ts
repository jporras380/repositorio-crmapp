/**
 * Almacenamiento de objetos (ARCH §12): MinIO en desarrollo, R2 en producción,
 * ambos por la API de S3.
 *
 * Dos decisiones que condicionan todo lo demás:
 *
 * - **Las claves van por inquilino** (`tenants/<id>/media/...`). El borrado
 *   por solicitud del titular y la retención (P-07) se convierten en un
 *   borrado por prefijo en vez de una lista de claves sueltas.
 * - **Nada es público.** Se sirve con URL firmadas de vida corta. Instagram
 *   exige URL pública para los medios salientes: una URL firmada lo es
 *   mientras dura, y eso basta para que Meta la descargue.
 */
import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface Almacen {
  guardar(clave: string, datos: Buffer, mime: string): Promise<void>;
  /** URL de lectura firmada. Por defecto cinco minutos. */
  urlDeLectura(clave: string, ttlSegundos?: number): Promise<string>;
  /** URL para que el navegador suba directamente, sin pasar por la API. */
  urlDeSubida(clave: string, mime: string, ttlSegundos?: number): Promise<string>;
  existe(clave: string): Promise<boolean>;
  borrar(clave: string): Promise<void>;
}

export interface ConfigDeS3 {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const TTL_LECTURA = 5 * 60;
const TTL_SUBIDA = 10 * 60;

export class AlmacenS3 implements Almacen {
  readonly #cliente: S3Client;
  readonly #bucket: string;

  constructor(config: ConfigDeS3) {
    this.#bucket = config.bucket;
    this.#cliente = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // MinIO y R2 resuelven el bucket por ruta, no por subdominio. Sin esto,
      // el SDK intenta `bucket.localhost:9000` y falla el DNS.
      forcePathStyle: true,
    });
  }

  async guardar(clave: string, datos: Buffer, mime: string): Promise<void> {
    await this.#cliente.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: clave, Body: datos, ContentType: mime }),
    );
  }

  urlDeLectura(clave: string, ttlSegundos = TTL_LECTURA): Promise<string> {
    return getSignedUrl(this.#cliente, new GetObjectCommand({ Bucket: this.#bucket, Key: clave }), {
      expiresIn: ttlSegundos,
    });
  }

  urlDeSubida(clave: string, mime: string, ttlSegundos = TTL_SUBIDA): Promise<string> {
    return getSignedUrl(
      this.#cliente,
      new PutObjectCommand({ Bucket: this.#bucket, Key: clave, ContentType: mime }),
      { expiresIn: ttlSegundos },
    );
  }

  async existe(clave: string): Promise<boolean> {
    try {
      await this.#cliente.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: clave }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return false;
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async borrar(clave: string): Promise<void> {
    await this.#cliente.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: clave }));
  }
}

/**
 * Almacén en memoria para tests de la API y del worker.
 *
 * Solo `packages/storage` habla con MinIO de verdad. Los demás paquetes
 * prueban su lógica contra esto, y así no necesitan un MinIO en CI para
 * comprobar que un mensaje enlaza bien su medio.
 */
export class AlmacenEnMemoria implements Almacen {
  readonly objetos = new Map<string, { datos: Buffer; mime: string }>();

  async guardar(clave: string, datos: Buffer, mime: string): Promise<void> {
    this.objetos.set(clave, { datos, mime });
  }
  async urlDeLectura(clave: string, ttlSegundos = TTL_LECTURA): Promise<string> {
    return `memoria://lectura/${clave}?ttl=${ttlSegundos}`;
  }
  async urlDeSubida(clave: string, _mime: string, ttlSegundos = TTL_SUBIDA): Promise<string> {
    return `memoria://subida/${clave}?ttl=${ttlSegundos}`;
  }
  async existe(clave: string): Promise<boolean> {
    return this.objetos.has(clave);
  }
  async borrar(clave: string): Promise<void> {
    this.objetos.delete(clave);
  }
}

// ---------------------------------------------------------------------------
// Claves y utilidades
// ---------------------------------------------------------------------------

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/**
 * Clave namespaced por inquilino. La extensión sale del MIME, no del nombre
 * que diga el proveedor: el nombre lo controla quien envía y no es fiable.
 */
export function claveDeMedio(tenantId: string, mediaAssetId: string, mime: string): string {
  const ext = EXTENSION[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
  return `tenants/${tenantId}/media/${mediaAssetId}.${ext}`;
}

/** Tipo de medio para `media_assets.kind`, a partir del MIME. */
export function tipoDeMedio(mime: string): 'image' | 'video' | 'audio' | 'document' | 'sticker' {
  const m = mime.toLowerCase();
  if (m === 'image/webp') return 'sticker';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

export function sha256De(datos: Buffer): string {
  return createHash('sha256').update(datos).digest('hex');
}
