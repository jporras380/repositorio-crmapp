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

export const TOKEN_INGESTA = Symbol('IngestaService');

export const TOKEN_BANDEJA = Symbol('BandejaService');

export const TOKEN_CANALES = Symbol('CanalesService');
export const TOKEN_CIFRADOR = Symbol('Cifrador');

export const TOKEN_MEDIOS = Symbol('MediosService');

export const TOKEN_PLANTILLAS = Symbol('PlantillasService');
/** Mapa canal → ChannelAdapter, compartido por bandeja y plantillas. */
export const TOKEN_ADAPTADORES = Symbol('Adaptadores');

export const TOKEN_USO = Symbol('UsoService');
