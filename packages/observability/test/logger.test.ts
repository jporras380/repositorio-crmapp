/**
 * El test que el ARCH §11 pide por su nombre: inyectar un token conocido y
 * fallar si aparece en la salida.
 *
 * Está escrito buscando el secreto en la línea COMPLETA ya serializada, no
 * campo por campo. Un test que comprueba `linea.token === '[REDACTADO]'` pasa
 * mientras el mismo valor se cuela por otro sitio; buscar en el texto entero
 * es lo único que cubre los caminos que no se nos ocurrieron.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RegistroDeSecretos } from '@crmapp/crypto';
import { crearLogger } from '../src/logger.js';

const TOKEN = 'EAAG_token_de_whatsapp_muy_secreto_1234567890';
const PASSWORD = 'contrasena_de_postgres_9f3a2b';

let salida: string[];
let registro: RegistroDeSecretos;

function logger(nivel: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  return crearLogger({
    nivel,
    registro,
    escribir: (linea) => salida.push(linea),
    ahora: () => new Date('2026-09-09T10:00:00.000Z'),
  });
}

/** Todo lo escrito, concatenado. Si el secreto está en algún sitio, aparece. */
const todo = () => salida.join('\n');

beforeEach(() => {
  salida = [];
  registro = new RegistroDeSecretos();
  registro.registrar(TOKEN, PASSWORD);
});

describe('el token registrado no sale por ningún camino', () => {
  it('ni como valor de un campo cualquiera', () => {
    logger().info('enviando', { credencialDelCliente: TOKEN });
    expect(todo()).not.toContain(TOKEN);
    expect(todo()).toContain('[REDACTADO]');
  });

  it('ni concatenado dentro del mensaje', () => {
    // El caso real: alguien construye el mensaje a mano.
    logger().error(`fallo al llamar a la API con ${TOKEN}`);
    expect(todo()).not.toContain(TOKEN);
  });

  it('ni dentro de una cadena de conexión', () => {
    logger().info('conectando', {
      dsn: `postgres://crmapp:${PASSWORD}@localhost:5432/crmapp`,
    });
    expect(todo()).not.toContain(PASSWORD);
    // El resto de la URL sí se ve: es lo que hace útil el log.
    expect(todo()).toContain('localhost:5432');
  });

  it('ni en el mensaje de una excepción', () => {
    // El camino por el que se filtran credenciales en producción casi nunca
    // es logger.info({ password }); es logger.error(err) donde la librería
    // metió la cadena de conexión completa en el mensaje.
    const err = new Error(`connect ECONNREFUSED postgres://u:${PASSWORD}@db:5432`);
    logger().error('fallo de base de datos', err);
    expect(todo()).not.toContain(PASSWORD);
    expect(todo()).toContain('ECONNREFUSED');
  });

  it('ni en la causa encadenada de una excepción', () => {
    const raiz = new Error(`token ${TOKEN} rechazado`);
    const envoltorio = new Error('fallo al sincronizar plantillas', { cause: raiz });
    logger().error('sync', envoltorio);
    expect(todo()).not.toContain(TOKEN);
  });

  it('ni anidado varios niveles dentro de un objeto', () => {
    logger().info('estado', {
      canal: { cuenta: { credenciales: { valor: TOKEN } } },
    });
    expect(todo()).not.toContain(TOKEN);
  });

  it('ni dentro de un array', () => {
    logger().info('lote', { intentos: [{ auth: TOKEN }, { auth: TOKEN }] });
    expect(todo()).not.toContain(TOKEN);
  });

  it('ni en el contexto heredado de un logger derivado', () => {
    const hijo = logger().con({ tenantId: 't-1', tokenDelCanal: TOKEN });
    hijo.info('mensaje enviado');
    expect(todo()).not.toContain(TOKEN);
    expect(todo()).toContain('t-1');
  });
});

describe('redacción por nombre de campo', () => {
  it('oculta campos sensibles aunque su valor no esté registrado', () => {
    // La segunda red: un secreto que nadie registró, pero cuyo campo se llama
    // como para saber que lo es.
    logger().info('alta', {
      password: 'jamas_registrado_pero_evidente',
      accessToken: 'tampoco_registrado',
      email: 'ana@ejemplo.com',
    });
    const linea = todo();
    expect(linea).not.toContain('jamas_registrado_pero_evidente');
    expect(linea).not.toContain('tampoco_registrado');
    // Lo que no es secreto se conserva: un log que lo tapa todo es inútil.
    expect(linea).toContain('ana@ejemplo.com');
  });
});

describe('comportamiento del logger', () => {
  it('respeta el nivel mínimo', () => {
    const l = logger('warn');
    l.debug('no');
    l.info('tampoco');
    l.warn('sí');
    l.error('también');
    expect(salida).toHaveLength(2);
  });

  it('emite una línea de JSON válido por registro', () => {
    logger().info('hola', { n: 1 });
    const linea = JSON.parse(salida[0]!);
    expect(linea).toMatchObject({ nivel: 'info', mensaje: 'hola', n: 1 });
    expect(linea.ts).toBe('2026-09-09T10:00:00.000Z');
  });

  it('el logger derivado no altera al padre', () => {
    const padre = logger();
    const hijo = padre.con({ tenantId: 't-9' });
    hijo.info('del hijo');
    padre.info('del padre');
    expect(JSON.parse(salida[0]!).tenantId).toBe('t-9');
    expect(JSON.parse(salida[1]!).tenantId).toBeUndefined();
  });

  it('una referencia circular no rompe el proceso', () => {
    const objeto: Record<string, unknown> = { nombre: 'ciclo' };
    objeto['yo'] = objeto;
    expect(() => logger().info('circular', { objeto })).not.toThrow();
    expect(todo()).toContain('[CIRCULAR]');
  });

  it('no muta el objeto que le pasan', () => {
    // Un logger que modifica lo que registra provoca bugs imposibles de
    // encontrar, porque el objeto queda alterado para quien lo estaba usando.
    const datos = { password: 'secreta_de_verdad', otro: 1 };
    logger().info('prueba', datos);
    expect(datos.password).toBe('secreta_de_verdad');
  });
});
