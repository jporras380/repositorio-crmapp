/**
 * La otra puerta: registrar un mensaje que **no envió el CRM**.
 *
 * `puerta.ts` es por donde SALE un mensaje, y todo lo que sale pasa por sus
 * comprobaciones —ventana de 24 h, suscripción, capacidades— y por el outbox
 * que lo entrega. La guarda de arquitectura (ARCH §9) prohíbe insertar un
 * saliente en cualquier otro sitio, precisamente para que nada se envíe
 * saltándose eso.
 *
 * Pero con la coexistencia de WhatsApp (ADR-015) hay salientes que el CRM no
 * envía, solo se entera de ellos:
 *
 * - los **ecos**: lo que el hotel responde desde la app del celular;
 * - el **historial**: lo que se escribió antes de conectar el canal.
 *
 * No hay nada que comprobar ni que entregar: ya ocurrieron. Viven aquí, y no
 * en el worker, para que la regla siga siendo verdad sin excepciones: **todo
 * saliente se inserta en este paquete**. Hay dos puertas, y se distinguen por
 * lo único que importa —esta no escribe `mensaje.enviar` en el outbox—. Un
 * mensaje que entra por aquí no puede acabar enviándose.
 */
import type { PoolClient } from 'pg';

export interface MensajeAjeno {
  id: string;
  tenantId: string;
  conversationId: string;
  channelAccountId: string;
  tipo: string;
  texto: string | null;
  payload: Record<string, unknown>;
  /** Clave del proveedor. Quien llama ya reservó la idempotencia con ella. */
  externalMessageId: string;
  /** Cuándo ocurrió de verdad. En un eco, ahora; en el historial, hace meses. */
  creadoEn: Date;
  mediaAssetId?: string | null;
}

/**
 * Lo que el negocio envió por fuera del CRM, desde la app de su canal.
 *
 * Es de una persona (`sent_by = 'human'`) sin usuario: alguien del hotel lo
 * escribió, pero no con sesión aquí.
 */
export async function registrarSalienteAjeno(
  c: PoolClient,
  m: MensajeAjeno & { estado: 'sent' | 'delivered' | 'read' | 'failed' },
): Promise<void> {
  await insertar(c, m, 'outbound', m.estado);
}

/**
 * Un mensaje del historial importado, lo escribiera quien lo escribiera.
 *
 * La dirección viene del proveedor, tal cual. Lo del negocio queda con el
 * estado que tuvo en su día; lo de la otra persona, como entregado.
 */
export async function registrarDelHistorial(
  c: PoolClient,
  m: MensajeAjeno & {
    direccion: 'inbound' | 'outbound';
    estado?: 'sent' | 'delivered' | 'read' | 'failed' | undefined;
  },
): Promise<void> {
  await insertar(c, m, m.direccion, m.direccion === 'inbound' ? 'delivered' : (m.estado ?? 'sent'));
}

async function insertar(
  c: PoolClient,
  m: MensajeAjeno,
  direccion: 'inbound' | 'outbound',
  estado: string,
): Promise<void> {
  await c.query(
    `INSERT INTO messages
       (id, tenant_id, conversation_id, channel_account_id, direction, type, body, payload,
        external_message_id, status, sent_by, created_at, media_asset_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'human', $11, $12)`,
    [
      m.id,
      m.tenantId,
      m.conversationId,
      m.channelAccountId,
      direccion,
      m.tipo,
      m.texto,
      JSON.stringify(m.payload),
      m.externalMessageId,
      estado,
      m.creadoEn,
      m.mediaAssetId ?? null,
    ],
  );
}
