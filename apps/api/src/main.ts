import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { cargarConfig, configParaLog } from '@crmapp/config';
import { crearLogger } from '@crmapp/observability';
import { AppModule } from './app.module.js';
import { FiltroDeErrores } from './errores.js';

// cargarConfig lanza con la lista completa de problemas si algo falta, y
// registra los secretos en el redactor de logs. Va antes que nada.
const config = cargarConfig();
const log = crearLogger({ nivel: config.LOG_LEVEL });

const app = await NestFactory.create(
  AppModule.forRoot({
    databaseUrl: config.DATABASE_URL,
    ...(config.DATABASE_AUTH_URL ? { authDatabaseUrl: config.DATABASE_AUTH_URL } : {}),
    jwtSecret: config.JWT_SECRET,
    poolMax: config.DATABASE_POOL_MAX,
  }),
  { logger: false },
);

app.useGlobalFilters(new FiltroDeErrores((e) => log.error('error no controlado', e as Error)));

await app.listen(config.API_PORT);
log.info('API escuchando', { puerto: config.API_PORT, config: configParaLog(config) });
