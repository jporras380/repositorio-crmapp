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
    masterKey: config.MASTER_ENCRYPTION_KEY,
    masterKeyVersion: config.MASTER_ENCRYPTION_KEY_VERSION,
    ...(config.META_WEBHOOK_VERIFY_TOKEN
      ? { webhookVerifyToken: config.META_WEBHOOK_VERIFY_TOKEN }
      : {}),
  }),
  {
    logger: false,
    // Sin esto, express descarta los bytes originales al parsear el JSON y la
    // firma HMAC del webhook nunca cuadra. Es el fallo mas comun de este
    // camino y no da ninguna pista util.
    rawBody: true,
  },
);

app.useGlobalFilters(new FiltroDeErrores((e) => log.error('error no controlado', e as Error)));

await app.listen(config.API_PORT);
log.info('API escuchando', { puerto: config.API_PORT, config: configParaLog(config) });
