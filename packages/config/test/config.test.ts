import { beforeEach, describe, expect, it } from 'vitest';
import { RegistroDeSecretos, redactar, secretos } from '@crmapp/crypto';
import { cargarConfig, configParaLog, ErrorDeConfiguracion } from '../src/index.js';

const MINIMO = {
  DATABASE_URL: 'postgres://crmapp:clave_larga_de_prueba@localhost:55432/crmapp',
  REDIS_URL: 'redis://localhost:6379',
  MASTER_ENCRYPTION_KEY: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDA=',
  JWT_SECRET: 'un_secreto_de_al_menos_treinta_y_dos_caracteres',
};

beforeEach(() => {
  secretos.limpiar();
});

describe('carga', () => {
  it('aplica los valores por defecto', () => {
    const c = cargarConfig({ env: MINIMO, registrarSecretos: false });
    expect(c.NODE_ENV).toBe('development');
    expect(c.API_PORT).toBe(3000);
    expect(c.DATABASE_POOL_MAX).toBe(10);
  });

  it('convierte los números que llegan como texto', () => {
    const c = cargarConfig({
      env: { ...MINIMO, API_PORT: '8080' },
      registrarSecretos: false,
    });
    expect(c.API_PORT).toBe(8080);
  });
});

describe('falla al arrancar, no en caliente', () => {
  it('lanza si falta algo obligatorio', () => {
    expect(() => cargarConfig({ env: {}, registrarSecretos: false })).toThrow(ErrorDeConfiguracion);
  });

  it('informa de TODOS los problemas de una vez', () => {
    // Arreglar cinco variables de una vez es mejor que descubrirlas de una en
    // una, cada una tras un reinicio.
    try {
      cargarConfig({ env: {}, registrarSecretos: false });
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      const e = error as ErrorDeConfiguracion;
      expect(e.problemas.length).toBeGreaterThanOrEqual(4);
      expect(e.problemas.join('\n')).toContain('DATABASE_URL');
      expect(e.problemas.join('\n')).toContain('JWT_SECRET');
    }
  });

  it('cada problema nombra su variable', () => {
    // Un error de configuración que no dice cuál variable es inútil.
    try {
      cargarConfig({ env: { ...MINIMO, API_PORT: '99999' }, registrarSecretos: false });
      expect.unreachable('debería haber lanzado');
    } catch (error) {
      expect((error as ErrorDeConfiguracion).problemas[0]).toMatch(/^API_PORT:/);
    }
  });

  it('rechaza un JWT_SECRET corto', () => {
    expect(() =>
      cargarConfig({ env: { ...MINIMO, JWT_SECRET: 'corto' }, registrarSecretos: false }),
    ).toThrow(/al menos 32 caracteres/);
  });

  it('rechaza una DATABASE_URL que no es de PostgreSQL', () => {
    expect(() =>
      cargarConfig({ env: { ...MINIMO, DATABASE_URL: 'mysql://x' }, registrarSecretos: false }),
    ).toThrow(/postgres/);
  });
});

describe('los secretos quedan registrados para el redactor', () => {
  it('cargar la configuración registra los valores sensibles', () => {
    cargarConfig({ env: MINIMO });
    expect(secretos.tamano).toBeGreaterThanOrEqual(4);
    expect(secretos.tieneAlguno(MINIMO.JWT_SECRET)).toBe(true);
  });

  it('a partir de ahí, la clave de la base no aparece ni en un log improvisado', () => {
    // La cadena entera se registra, así que también se tapa si alguien
    // registra la URL completa a mano.
    cargarConfig({ env: MINIMO });
    const salida = JSON.stringify(redactar({ mensaje: `no conecto a ${MINIMO.DATABASE_URL}` }));
    expect(salida).not.toContain('clave_larga_de_prueba');
  });

  it('se puede desactivar el registro para no ensuciar otros tests', () => {
    const registro = new RegistroDeSecretos();
    cargarConfig({ env: MINIMO, registrarSecretos: false });
    expect(secretos.tamano).toBe(0);
    expect(registro.tamano).toBe(0);
  });
});

describe('configParaLog', () => {
  it('tapa los secretos y conserva lo demás', () => {
    const c = cargarConfig({ env: MINIMO, registrarSecretos: false });
    const vista = configParaLog(c);
    expect(vista['JWT_SECRET']).toBe('[REDACTADO]');
    expect(vista['MASTER_ENCRYPTION_KEY']).toBe('[REDACTADO]');
    expect(vista['DATABASE_URL']).toBe('[REDACTADO]');
    // Lo que sirve para diagnosticar se conserva.
    expect(vista['API_PORT']).toBe(3000);
    expect(vista['NODE_ENV']).toBe('development');
  });
});
