/**
 * Secretos de canal: tokens y app secrets de cada cuenta, cifrados con
 * envelope encryption (ARCH §11, @crmapp/crypto).
 *
 * Vive en `db` y no en la API porque lo usan dos procesos: la API para
 * guardar y para verificar webhooks, y el worker para enviar. Ninguno de los
 * dos debe escribir SQL contra `channel_secrets` a mano: el formato en base
 * —ciphertext, DEK envuelta, versión de clave— es un detalle de este archivo.
 *
 * Los valores nunca se registran en logs. El redactor de @crmapp/crypto los
 * tapa por nombre de campo, pero además aquí no se pasan a ningún logger.
 */
import type { Pool, PoolClient } from 'pg';
import type { Cifrador } from '@crmapp/crypto';
import { withSystemTransaction } from './client.js';

export type TipoDeSecreto = 'access_token' | 'app_secret' | 'webhook_secret' | 'refresh_token';

export interface SecretoAGuardar {
  tenantId: string;
  channelAccountId: string;
  kind: TipoDeSecreto;
  valor: string;
  expiraEn?: Date | null;
}

/** Inserta o reemplaza el secreto. Cada guardado genera DEK nueva. */
export async function guardarSecretoDeCanal(
  c: PoolClient,
  cifrador: Cifrador,
  s: SecretoAGuardar,
): Promise<void> {
  const { ciphertext, dekWrapped, keyVersion } = cifrador.cifrar(s.valor);
  await c.query(
    `INSERT INTO channel_secrets
       (tenant_id, channel_account_id, kind, ciphertext, dek_wrapped, key_version, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_account_id, kind) DO UPDATE
        SET ciphertext = EXCLUDED.ciphertext,
            dek_wrapped = EXCLUDED.dek_wrapped,
            key_version = EXCLUDED.key_version,
            expires_at = EXCLUDED.expires_at,
            rotated_at = now()`,
    [
      s.tenantId,
      s.channelAccountId,
      s.kind,
      ciphertext,
      dekWrapped,
      keyVersion,
      s.expiraEn ?? null,
    ],
  );
}

/** Devuelve el valor en claro, o `null` si no existe. */
export async function leerSecretoDeCanal(
  c: PoolClient,
  cifrador: Cifrador,
  channelAccountId: string,
  kind: TipoDeSecreto,
): Promise<string | null> {
  const { rows } = await c.query<{ ciphertext: Buffer; dek_wrapped: Buffer; key_version: number }>(
    `SELECT ciphertext, dek_wrapped, key_version
       FROM channel_secrets WHERE channel_account_id = $1 AND kind = $2`,
    [channelAccountId, kind],
  );
  const f = rows[0];
  if (!f) return null;
  return cifrador.descifrarTexto({
    ciphertext: f.ciphertext,
    dekWrapped: f.dek_wrapped,
    keyVersion: f.key_version,
  });
}

export async function borrarSecretosDeCanal(
  c: PoolClient,
  channelAccountId: string,
): Promise<void> {
  await c.query(`DELETE FROM channel_secrets WHERE channel_account_id = $1`, [channelAccountId]);
}

// ---------------------------------------------------------------------------
// Resolvers sin inquilino. Requieren el pool del rol `crmapp_auth`
// (migraciones 0008 y 0011): lectura acotada que cruza inquilinos.
// ---------------------------------------------------------------------------

export interface CuentaDeWebhook {
  channelAccountId: string;
  tenantId: string;
  /** App secret con el que verificar la firma del webhook. */
  secreto: string;
}

/**
 * Un webhook llega sin inquilino: solo trae el identificador externo de la
 * cuenta (phone_number_id en WhatsApp). Esto lo resuelve a cuenta + secreto.
 * Devuelve `null` si no se conoce o está desconectada.
 */
export function crearResolverDeCuenta(poolAuth: Pool, cifrador: Cifrador) {
  return async (
    canal: string,
    externalAccountId: string | null,
  ): Promise<CuentaDeWebhook | null> => {
    if (!externalAccountId) return null;
    return withSystemTransaction(poolAuth, async (c) => {
      // Un webhook de mensajes trae el phone_number_id; uno de estado de
      // plantilla trae solo la WABA (`entry[].id`). Ambos resuelven: los
      // números de una misma WABA comparten inquilino y app secret.
      const { rows } = await c.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM channel_accounts
          WHERE channel = $1 AND (external_id = $2 OR provider_account_id = $2)
            AND status <> 'disconnected'
          ORDER BY (external_id = $2) DESC, created_at
          LIMIT 1`,
        [canal, externalAccountId],
      );
      const ca = rows[0];
      if (!ca) return null;
      const secreto = await leerSecretoDeCanal(c, cifrador, ca.id, 'app_secret');
      if (!secreto) return null;
      return { channelAccountId: ca.id, tenantId: ca.tenant_id, secreto };
    });
  };
}

export interface CredencialesDeWhatsappResueltas {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}

export class CanalNoConectado extends Error {
  constructor(channelAccountId: string, motivo: string) {
    super(`Cuenta de canal ${channelAccountId}: ${motivo}`);
    this.name = 'CanalNoConectado';
  }
}

/** Credenciales para el adaptador de WhatsApp, por cuenta de canal. */
export interface CredencialesDeInstagramResueltas {
  igUserId: string;
  accessToken: string;
}

export interface CredencialesDeFacebookResueltas {
  pageId: string;
  accessToken: string;
}

/** Facebook: `external_id` es el id de la página y el token (de página) va cifrado. */
export function crearResolverDeCredencialesFacebook(poolAuth: Pool, cifrador: Cifrador) {
  return async (channelAccountId: string): Promise<CredencialesDeFacebookResueltas> => {
    return withSystemTransaction(poolAuth, async (c) => {
      const { rows } = await c.query<{ external_id: string; status: string }>(
        `SELECT external_id, status FROM channel_accounts WHERE id = $1 AND channel = 'facebook'`,
        [channelAccountId],
      );
      const ca = rows[0];
      if (!ca) throw new CanalNoConectado(channelAccountId, 'no existe');
      if (ca.status === 'disconnected')
        throw new CanalNoConectado(channelAccountId, 'desconectada');
      const token = await leerSecretoDeCanal(c, cifrador, channelAccountId, 'access_token');
      if (!token) throw new CanalNoConectado(channelAccountId, 'sin token guardado');
      return { pageId: ca.external_id, accessToken: token };
    });
  };
}

/** Igual que el de WhatsApp: `external_id` es el IG User y el token va cifrado en `channel_secrets`. */
export function crearResolverDeCredencialesInstagram(poolAuth: Pool, cifrador: Cifrador) {
  return async (channelAccountId: string): Promise<CredencialesDeInstagramResueltas> => {
    return withSystemTransaction(poolAuth, async (c) => {
      const { rows } = await c.query<{ external_id: string; status: string }>(
        `SELECT external_id, status FROM channel_accounts WHERE id = $1 AND channel = 'instagram'`,
        [channelAccountId],
      );
      const ca = rows[0];
      if (!ca) throw new CanalNoConectado(channelAccountId, 'no existe');
      if (ca.status === 'disconnected')
        throw new CanalNoConectado(channelAccountId, 'desconectada');
      const token = await leerSecretoDeCanal(c, cifrador, channelAccountId, 'access_token');
      if (!token) throw new CanalNoConectado(channelAccountId, 'sin token guardado');
      return { igUserId: ca.external_id, accessToken: token };
    });
  };
}

export function crearResolverDeCredencialesWhatsapp(poolAuth: Pool, cifrador: Cifrador) {
  return async (channelAccountId: string): Promise<CredencialesDeWhatsappResueltas> => {
    return withSystemTransaction(poolAuth, async (c) => {
      const { rows } = await c.query<{
        external_id: string;
        provider_account_id: string | null;
        status: string;
      }>(`SELECT external_id, provider_account_id, status FROM channel_accounts WHERE id = $1`, [
        channelAccountId,
      ]);
      const ca = rows[0];
      if (!ca) throw new CanalNoConectado(channelAccountId, 'no existe');
      if (ca.status === 'disconnected')
        throw new CanalNoConectado(channelAccountId, 'desconectada');
      const token = await leerSecretoDeCanal(c, cifrador, channelAccountId, 'access_token');
      if (!token) throw new CanalNoConectado(channelAccountId, 'sin token guardado');
      return {
        phoneNumberId: ca.external_id,
        wabaId: ca.provider_account_id ?? '',
        accessToken: token,
      };
    });
  };
}

// ---------------------------------------------------------------------------
// Secretos del INQUILINO (0025): hoy, la clave de IA del cliente (BYOK).
// Mismo cifrado que los de canal; tabla aparte porque no cuelgan de ninguna
// cuenta de canal. Se leen y escriben con el inquilino puesto (RLS).
// ---------------------------------------------------------------------------

/**
 * Las claves de IA del hotel, una por proveedor (BYOK, P-11).
 *
 * Cerrado a propósito: `kind` es una columna de texto libre en la base, y una
 * errata —`googl_api_key`— guardaría la clave donde nadie la busca, sin fallar
 * en ningún sitio. El tipo lo convierte en un error de compilación.
 */
export type TipoDeSecretoDeInquilino =
  'anthropic_api_key' | 'google_api_key' | 'openai_api_key' | 'xai_api_key';

export async function guardarSecretoDeInquilino(
  c: PoolClient,
  cifrador: Cifrador,
  s: { tenantId: string; kind: TipoDeSecretoDeInquilino; valor: string },
): Promise<void> {
  const { ciphertext, dekWrapped, keyVersion } = cifrador.cifrar(s.valor);
  await c.query(
    `INSERT INTO tenant_secrets (tenant_id, kind, ciphertext, dek_wrapped, key_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, kind) DO UPDATE
        SET ciphertext = EXCLUDED.ciphertext,
            dek_wrapped = EXCLUDED.dek_wrapped,
            key_version = EXCLUDED.key_version,
            rotated_at = now()`,
    [s.tenantId, s.kind, ciphertext, dekWrapped, keyVersion],
  );
}

/** Valor en claro, o `null` si el inquilino no ha guardado ese secreto. */
export async function leerSecretoDeInquilino(
  c: PoolClient,
  cifrador: Cifrador,
  kind: TipoDeSecretoDeInquilino,
): Promise<string | null> {
  const { rows } = await c.query<{ ciphertext: Buffer; dek_wrapped: Buffer; key_version: number }>(
    `SELECT ciphertext, dek_wrapped, key_version FROM tenant_secrets WHERE kind = $1`,
    [kind],
  );
  const f = rows[0];
  if (!f) return null;
  return cifrador.descifrarTexto({
    ciphertext: f.ciphertext,
    dekWrapped: f.dek_wrapped,
    keyVersion: f.key_version,
  });
}

export async function borrarSecretoDeInquilino(
  c: PoolClient,
  kind: TipoDeSecretoDeInquilino,
): Promise<void> {
  await c.query(`DELETE FROM tenant_secrets WHERE kind = $1`, [kind]);
}
