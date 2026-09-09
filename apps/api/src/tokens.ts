/**
 * Tokens de inyeccion.
 *
 * Toda la inyeccion es EXPLICITA con @Inject(TOKEN) en vez de por tipo. La
 * razon es concreta: la inyeccion por tipo de NestJS necesita
 * `emitDecoratorMetadata`, y esbuild —que es lo que usa vitest— no lo soporta.
 * La alternativa seria anadir `unplugin-swc` solo para poder testear.
 *
 * Coste: constructores mas verbosos. Ganancia: el codigo que corre en los
 * tests es el mismo que corre en produccion, sin un transpilador distinto en
 * medio.
 */
export const TOKEN_DB = Symbol('BaseDeDatos');
export const TOKEN_AUTH = Symbol('AuthService');
export const TOKEN_CONFIG = Symbol('Config');
