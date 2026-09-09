/**
 * Esquema Drizzle.
 *
 * Estas definiciones DUPLICAN el SQL de `migrations/`. La duplicación es
 * deliberada — el SQL manda porque necesita particionado, RLS y funciones que
 * ningún generador declarativo modela (ADR-001) — pero una duplicación sin
 * vigilancia se convierte en mentira en la primera migración que alguien
 * olvide reflejar aquí.
 *
 * Por eso existe `test/drift.test.ts`, que compara estas definiciones contra
 * el catálogo real de PostgreSQL y falla si divergen. Sin ese test, este
 * archivo sería una segunda fuente de verdad, que es peor que no tener ninguna.
 */
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** `bytea` para los secretos cifrados (ARCH §11). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `citext` para correos y slugs: comparación insensible a mayúsculas. */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

const creado = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const actualizado = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Inquilinos y usuarios
// ---------------------------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: citext('slug').notNull().unique(),
  status: text('status').notNull().default('active'),
  /** Politica de visibilidad entre agentes (ADR-008): all | team | assigned. */
  conversationVisibility: text('conversation_visibility').notNull().default('all'),
  createdAt: creado,
  updatedAt: actualizado,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash'),
  fullName: text('full_name').notNull(),
  avatarUrl: text('avatar_url'),
  mfaSecretId: uuid('mfa_secret_id'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: creado,
  updatedAt: actualizado,
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [uniqueIndex('memberships_tenant_user_key').on(t.tenantId, t.userId)],
);

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  createdAt: creado,
  updatedAt: actualizado,
});

export const teamMembers = pgTable('team_members', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  teamId: uuid('team_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  createdAt: creado,
});

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  teamId: uuid('team_id'),
  timezone: text('timezone').notNull(),
  schedule: jsonb('schedule').notNull().default({}),
  createdAt: creado,
  updatedAt: actualizado,
});

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  email: citext('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: creado,
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  meta: jsonb('meta').notNull().default({}),
  ip: text('ip'),
  createdAt: creado,
});

// ---------------------------------------------------------------------------
// Canales
// ---------------------------------------------------------------------------

export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    /** WABA en WhatsApp, cuenta de negocio en Instagram. No es secreto. */
    providerAccountId: text('provider_account_id'),
    status: text('status').notNull().default('disconnected'),
    quality: jsonb('quality').notNull().default({}),
    limits: jsonb('limits').notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    /** La WABA está suscrita a NUESTRA app. false = conectado pero no recibe (0014). */
    webhookSubscribed: boolean('webhook_subscribed'),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [uniqueIndex('channel_accounts_external_idx').on(t.channel, t.externalId)],
);

export const channelSecrets = pgTable('channel_secrets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  kind: text('kind').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  dekWrapped: bytea('dek_wrapped').notNull(),
  keyVersion: integer('key_version').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  createdAt: creado,
});

// ---------------------------------------------------------------------------
// Contactos (ADR-007)
// ---------------------------------------------------------------------------

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  displayName: text('display_name'),
  locale: text('locale'),
  attributes: jsonb('attributes').notNull().default({}),
  createdAt: creado,
  updatedAt: actualizado,
});

export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channel: text('channel').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    externalUserId: text('external_user_id').notNull(),
    handle: text('handle'),
    phoneE164: text('phone_e164'),
    profile: jsonb('profile').notNull().default({}),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [uniqueIndex('contact_identities_external_idx').on(t.channelAccountId, t.externalUserId)],
);

export const contactMerges = pgTable('contact_merges', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  sourceContactId: uuid('source_contact_id').notNull(),
  targetContactId: uuid('target_contact_id').notNull(),
  mergedBy: uuid('merged_by'),
  reason: text('reason').notNull(),
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
  createdAt: creado,
});

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  color: text('color'),
  createdAt: creado,
});

export const contactTags = pgTable(
  'contact_tags',
  {
    tenantId: uuid('tenant_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: creado,
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] })],
);

// ---------------------------------------------------------------------------
// Conversaciones y mensajes (ADR-006)
// ---------------------------------------------------------------------------

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  storageKey: text('storage_key'),
  mime: text('mime'),
  bytes: bigint('bytes', { mode: 'number' }),
  width: integer('width'),
  height: integer('height'),
  durationMs: integer('duration_ms'),
  sha256: text('sha256'),
  remoteUrl: text('remote_url'),
  remoteExpiresAt: timestamp('remote_expires_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'),
  thumbKey: text('thumb_key'),
  createdAt: creado,
  updatedAt: actualizado,
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    contactIdentityId: uuid('contact_identity_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    kind: text('kind').notNull().default('dm'),
    status: text('status').notNull().default('open'),
    assigneeUserId: uuid('assignee_user_id'),
    teamId: uuid('team_id'),
    externalThreadId: text('external_thread_id'),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    createdAt: creado,
    updatedAt: actualizado,
  },
  (t) => [
    index('conversations_bandeja_idx').on(t.tenantId, t.status, t.lastInboundAt),
    index('conversations_asignadas_idx').on(t.tenantId, t.assigneeUserId, t.status),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    direction: text('direction').notNull(),
    type: text('type').notNull(),
    body: text('body'),
    payload: jsonb('payload').notNull().default({}),
    mediaAssetId: uuid('media_asset_id'),
    externalMessageId: text('external_message_id'),
    status: text('status').notNull().default('queued'),
    error: jsonb('error'),
    sentBy: text('sent_by').notNull().default('human'),
    sentByUserId: uuid('sent_by_user_id'),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    waTemplateVersionId: uuid('wa_template_version_id'),
    quickReplyVersionId: uuid('quick_reply_version_id'),
    createdAt: creado,
  },
  // La clave primaria incluye la columna de partición porque PostgreSQL lo
  // exige en tablas particionadas. Ver ADR-006.
  (t) => [primaryKey({ columns: [t.createdAt, t.id] })],
);

export const messageKeys = pgTable(
  'message_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    channelAccountId: uuid('channel_account_id').notNull(),
    externalMessageId: text('external_message_id').notNull(),
    messageId: uuid('message_id').notNull(),
    messageCreatedAt: timestamp('message_created_at', { withTimezone: true }).notNull(),
    createdAt: creado,
  },
  (t) => [primaryKey({ columns: [t.channelAccountId, t.externalMessageId] })],
);

export const internalNotes = pgTable('internal_notes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  userId: uuid('user_id'),
  body: text('body').notNull(),
  createdAt: creado,
  updatedAt: actualizado,
});

export const conversationTags = pgTable(
  'conversation_tags',
  {
    tenantId: uuid('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: creado,
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.tagId] })],
);

// ---------------------------------------------------------------------------
// Ingesta y outbox
// ---------------------------------------------------------------------------

export const inboundEvents = pgTable('inbound_events', {
  id: uuid('id').notNull(),
  // Nullable a propósito: cuando llega el webhook todavía no sabemos de quién
  // es hasta resolver el channel_account.
  tenantId: uuid('tenant_id'),
  channel: text('channel').notNull(),
  channelAccountId: uuid('channel_account_id'),
  signatureOk: boolean('signature_ok').notNull(),
  raw: jsonb('raw').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  error: jsonb('error'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: creado,
});

export const outbox = pgTable('outbox', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: creado,
});

// ---------------------------------------------------------------------------
// Planes y suscripciones
// ---------------------------------------------------------------------------

/**
 * Catalogo global de planes. Sin tenant_id: no pertenece a nadie.
 * Lleva RLS con una politica de lectura publica, no una excepcion del test.
 */
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey(),
  code: citext('code').notNull().unique(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').notNull().default('USD'),
  period: text('period').notNull().default('month'),
  limits: jsonb('limits').notNull().default({}),
  trialMonths: integer('trial_months').notNull().default(1),
  graceDays: integer('grace_days').notNull().default(7),
  isPublic: boolean('is_public').notNull().default(true),
  createdAt: creado,
  updatedAt: actualizado,
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().unique(),
  planId: uuid('plan_id').notNull(),
  /** Intencion declarada, NO el estado efectivo. Ver @crmapp/core. */
  status: text('status').notNull().default('trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEndsAt: timestamp('current_period_ends_at', { withTimezone: true }),
  /** Copiado del plan al crear. No se lee del plan al evaluar. */
  graceDays: integer('grace_days').notNull().default(7),
  /** Cache para listados y deteccion de transiciones. Nadie decide con esto. */
  cachedState: text('cached_state'),
  cachedStateAt: timestamp('cached_state_at', { withTimezone: true }),
  provider: text('provider'),
  providerCustomerId: text('provider_customer_id'),
  providerSubscriptionId: text('provider_subscription_id'),
  createdAt: creado,
  updatedAt: actualizado,
});

// ---------------------------------------------------------------------------
// Plantillas (0012, ARCH §5.6): dos entidades, nunca un campo `tipo`
// ---------------------------------------------------------------------------

export const quickReplies = pgTable('quick_replies', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  shortcut: citext('shortcut').notNull(),
  title: text('title').notNull(),
  currentVersionId: uuid('current_version_id'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: creado,
  updatedAt: actualizado,
});

export const quickReplyVersions = pgTable('quick_reply_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  quickReplyId: uuid('quick_reply_id').notNull(),
  version: integer('version').notNull(),
  body: text('body').notNull().default(''),
  mediaAssetId: uuid('media_asset_id'),
  createdBy: uuid('created_by'),
  createdAt: creado,
});

export const waTemplates = pgTable('wa_templates', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  channelAccountId: uuid('channel_account_id').notNull(),
  name: text('name').notNull(),
  language: text('language').notNull(),
  /** Declarada por el usuario; la efectiva la fija Meta y es la que cuesta. */
  categoryDeclared: text('category_declared'),
  categoryEffective: text('category_effective'),
  status: text('status').notNull().default('borrador'),
  metaTemplateId: text('meta_template_id'),
  qualityScore: text('quality_score'),
  rejectionReason: text('rejection_reason'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  currentVersionId: uuid('current_version_id'),
  createdAt: creado,
  updatedAt: actualizado,
});

export const waTemplateVersions = pgTable('wa_template_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  templateId: uuid('template_id').notNull(),
  version: integer('version').notNull(),
  components: jsonb('components').notNull().default([]),
  exampleParams: jsonb('example_params').notNull().default([]),
  status: text('status').notNull().default('borrador'),
  metaTemplateId: text('meta_template_id'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  createdAt: creado,
});

// ---------------------------------------------------------------------------
// Medición de uso (0013, ARCH §5.9)
// ---------------------------------------------------------------------------

/** Particionada por mes; PK (occurred_at, id). Solo inserción para la aplicación. */
export const usageEvents = pgTable('usage_events', {
  id: uuid('id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  metric: text('metric').notNull(),
  quantity: bigint('quantity', { mode: 'number' }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  dedupKey: text('dedup_key').notNull(),
  meta: jsonb('meta').notNull().default({}),
});

/** Clave de idempotencia sin particionar (ADR-006). */
export const usageEventKeys = pgTable('usage_event_keys', {
  dedupKey: text('dedup_key').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
});

/** Agregado por inquilino, métrica y mes. La factura lee esto. */
export const usageRollups = pgTable(
  'usage_rollups',
  {
    tenantId: uuid('tenant_id').notNull(),
    metric: text('metric').notNull(),
    period: date('period').notNull(),
    quantity: bigint('quantity', { mode: 'number' }).notNull().default(0),
    updatedAt: actualizado,
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.metric, t.period] })],
);
