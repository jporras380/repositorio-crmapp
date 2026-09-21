/**
 * CLI de migraciones.
 *
 * Usa DATABASE_MIGRATION_URL, no DATABASE_URL: las migraciones corren con el
 * rol dueño de las tablas y la aplicación con otro que no lo es (ADR-005).
 */
import { migrar, revertir } from './migrate.js';
import { Client } from 'pg';

const comando = process.argv[2];
const url = process.env['DATABASE_MIGRATION_URL'];

if (!url) {
  console.error('Falta DATABASE_MIGRATION_URL. Ver .env.example.');
  process.exit(1);
}

const log = (m: string) => console.log(m);

try {
  switch (comando) {
    case 'migrate': {
      const aplicadas = await migrar(url, { log });
      console.log(aplicadas.length ? `\n${aplicadas.length} migración(es).` : 'Nada pendiente.');
      break;
    }

    case 'rollback': {
      const pasos = Number(process.argv[3] ?? 1);
      const revertidas = await revertir(url, { pasos, log });
      console.log(
        revertidas.length ? `\n${revertidas.length} revertida(s).` : 'Nada que revertir.',
      );
      break;
    }

    case 'dev-role':
    case 'dev-roles': {
      // Solo desarrollo. En producción los roles reciben credenciales por otra
      // vía: una contraseña en una migración sería un secreto en el repositorio.
      // Cuatro roles: aplicación (RLS), autenticación (solo lectura de
      // identidad, 0008), relay del outbox (0006) y operador de la plataforma
      // (solo lectura de facturación y salud, 0040).
      const password = process.env['DEV_APP_PASSWORD'] ?? 'crmapp_dev';
      const client = new Client({ connectionString: url });
      await client.connect();
      const { rows } = await client.query<{ datname: string }>(
        'SELECT current_database() AS datname',
      );
      for (const rol of ['crmapp_app', 'crmapp_auth', 'crmapp_relay', 'crmapp_operador']) {
        await client.query(`ALTER ROLE ${rol} LOGIN PASSWORD '${password}'`);
        await client.query(`GRANT CONNECT ON DATABASE "${rows[0]!.datname}" TO ${rol}`);
        console.log(`${rol} puede conectarse a ${rows[0]!.datname}.`);
      }
      await client.end();
      break;
    }

    default:
      console.error('Uso: cli.ts <migrate|rollback [pasos]|dev-roles>');
      process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
