import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cargarConfig, configParaLog } from '@crmapp/config';
import { crearLogger } from '@crmapp/observability';
import { AppModule } from './app.module.js';
import { FiltroDeErrores } from './errores.js';

// cargarConfig lanza con la lista completa de problemas si algo falta, y
// registra los secretos en el redactor de logs. Va antes que nada.
const config = cargarConfig();
const log = crearLogger({ nivel: config.LOG_LEVEL });

const app = await NestFactory.create<NestExpressApplication>(
  AppModule.forRoot({
    databaseUrl: config.DATABASE_URL,
    ...(config.DATABASE_AUTH_URL ? { authDatabaseUrl: config.DATABASE_AUTH_URL } : {}),
    ...(config.DATABASE_OPERADOR_URL ? { operadorDatabaseUrl: config.DATABASE_OPERADOR_URL } : {}),
    ...(config.DATABASE_SOPORTE_URL ? { soporteDatabaseUrl: config.DATABASE_SOPORTE_URL } : {}),
    jwtSecret: config.JWT_SECRET,
    poolMax: config.DATABASE_POOL_MAX,
    masterKey: config.MASTER_ENCRYPTION_KEY,
    masterKeyVersion: config.MASTER_ENCRYPTION_KEY_VERSION,
    ...(config.META_WEBHOOK_VERIFY_TOKEN
      ? { webhookVerifyToken: config.META_WEBHOOK_VERIFY_TOKEN }
      : {}),
    ...(config.S3_ENDPOINT &&
    config.S3_BUCKET &&
    config.S3_ACCESS_KEY_ID &&
    config.S3_SECRET_ACCESS_KEY
      ? {
          s3: {
            endpoint: config.S3_ENDPOINT,
            region: config.S3_REGION,
            bucket: config.S3_BUCKET,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
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

// La importación de clientes manda un CSV dentro del JSON y el tope de
// express son 100 kB: un archivo de 2.000 filas ya no cabe. 2 MB cubre el
// tope de 5.000 filas del servicio y sigue siendo pequeño para un webhook.
app.useBodyParser('json', { limit: '2mb' });

app.useGlobalFilters(new FiltroDeErrores((e) => log.error('error no controlado', e as Error)));

await app.listen(config.API_PORT);
log.info('API escuchando', { puerto: config.API_PORT, config: configParaLog(config) });
