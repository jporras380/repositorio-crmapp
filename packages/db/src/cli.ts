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

    case 'dev-role': {
      // Solo desarrollo. En producción el rol recibe credenciales por otra vía:
      // una contraseña en una migración sería un secreto en el repositorio.
      const password = process.env['DEV_APP_PASSWORD'] ?? 'crmapp_dev';
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.query(`ALTER ROLE crmapp_app LOGIN PASSWORD '${password}'`);
      const { rows } = await client.query<{ datname: string }>(
        'SELECT current_database() AS datname',
      );
      await client.query(`GRANT CONNECT ON DATABASE "${rows[0]!.datname}" TO crmapp_app`);
      await client.end();
      console.log(`crmapp_app puede conectarse a ${rows[0]!.datname}.`);
      break;
    }

    default:
      console.error('Uso: cli.ts <migrate|rollback [pasos]|dev-role>');
      process.exit(1);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
