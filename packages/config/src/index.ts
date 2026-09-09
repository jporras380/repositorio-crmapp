/**
 * Carga y validación de la configuración (ARCH §4).
 *
 * Regla: **falla al arrancar, no en caliente.** Una variable de entorno mal
 * puesta debe impedir que el proceso levante, no aparecer tres horas después
 * como un `undefined` en mitad de un envío. Por eso `cargarConfig` valida todo
 * de golpe y lanza con la lista completa de problemas: arreglar cinco
 * variables de una vez es mejor que descubrirlas de una en una.
 *
 * Los campos marcados como secretos se registran en el redactor de
 * `@crmapp/crypto` en cuanto se cargan. A partir de ese momento, si alguno
 * aparece en cualquier log —dentro de un objeto, concatenado en un mensaje o
 * en el texto de una excepción— sale redactado.
 */
import { z } from 'zod';
import { secretos } from '@crmapp/crypto';

export class ErrorDeConfiguracion extends Error {
  readonly problemas: string[];

  constructor(problemas: string[]) {
    super(
      `Configuración inválida. El proceso no arranca:\n` +
        problemas.map((p) => `  · ${p}`).join('\n'),
    );
    this.name = 'ErrorDeConfiguracion';
    this.problemas = problemas;
  }
}

const puerto = z.coerce.number().int().min(1).max(65535);
const urlPostgres = z
  .string()
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'debe empezar por postgres:// o postgresql://',
  });

/**
 * Esquema de configuración.
 *
 * Crece con cada módulo. Lo que hoy es opcional (Stripe, IA) pasa a requerido
 * en la fase que lo usa, no antes: exigir la clave de Stripe en fase 0
 * obligaría a inventarse un valor para arrancar, y un valor inventado en una
 * variable de secreto acaba en producción.
 */
export const esquemaConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: puerto.default(3000),
  API_PUBLIC_URL: z.string().url().optional(),

  DATABASE_URL: urlPostgres,
  DATABASE_MIGRATION_URL: urlPostgres.optional(),
  // Rol `crmapp_auth`, de solo lectura sobre las tablas de identidad
  // (migracion 0008). Sin ella, iniciar sesion no encuentra al usuario: la
  // consulta corre sin inquilino y RLS no deja ver nada. Opcional para que un
  // worker, que no autentica a nadie, no tenga que definirla.
  DATABASE_AUTH_URL: urlPostgres.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  REDIS_URL: z.string().startsWith('redis'),

  // 32 bytes en base64. La validación de tamaño la hace @crmapp/crypto al
  // construir el cifrador; aquí solo se comprueba que haya algo.
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  MASTER_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),

  JWT_SECRET: z.string().min(32, 'debe tener al menos 32 caracteres'),
});

export type Config = z.infer<typeof esquemaConfig>;

/**
 * Campos que nunca deben aparecer en un log.
 *
 * Se declaran a mano y no por heurística de nombre: el redactor ya hace la
 * heurística, y esta lista es la red explícita para los valores que sabemos
 * que son secretos aunque su nombre no lo delate.
 */
const CAMPOS_SECRETOS = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUTH_URL',
  'REDIS_URL',
  'MASTER_ENCRYPTION_KEY',
  'JWT_SECRET',
] as const satisfies readonly (keyof Config)[];

export interface OpcionesDeCarga {
  /** Fuente de variables. Se inyecta en los tests. */
  env?: Record<string, string | undefined>;
  /** Registrar los secretos en el redactor de logs. Por defecto, sí. */
  registrarSecretos?: boolean;
}

export function cargarConfig(opciones: OpcionesDeCarga = {}): Config {
  const env = opciones.env ?? process.env;
  const resultado = esquemaConfig.safeParse(env);

  if (!resultado.success) {
    const problemas = resultado.error.issues.map((issue) => {
      const campo = issue.path.join('.') || '(raíz)';
      // `undefined` en Zod significa "no está definida", pero el mensaje por
      // defecto ("Required") no dice cuál ni cómo se llama.
      return `${campo}: ${issue.message}`;
    });
    throw new ErrorDeConfiguracion(problemas);
  }

  const config = resultado.data;

  if (opciones.registrarSecretos !== false) {
    secretos.registrar(...CAMPOS_SECRETOS.map((c) => config[c] as string | undefined));
  }

  return config;
}

/** Vista de la configuración apta para registrar en un log de arranque. */
export function configParaLog(config: Config): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  const ocultos = new Set<string>(CAMPOS_SECRETOS);
  for (const [clave, valor] of Object.entries(config)) {
    salida[clave] = ocultos.has(clave) ? '[REDACTADO]' : valor;
  }
  return salida;
}
