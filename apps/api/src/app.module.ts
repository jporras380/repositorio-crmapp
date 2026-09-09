import { Module, type DynamicModule } from '@nestjs/common';
import { Pool } from 'pg';
import { BaseDeDatos } from './db.js';
import { TOKEN_AUTH, TOKEN_DB, TOKEN_INGESTA } from './tokens.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { IngestaSandbox, type AdaptadorDeIngesta } from '@crmapp/channels';
import { IngestaService, type ResolverCuenta } from './webhooks/ingesta.service.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';

export interface OpcionesDeApp {
  databaseUrl: string;
  /** URL con el rol `crmapp_auth`, de solo lectura (migracion 0008). */
  authDatabaseUrl?: string;
  jwtSecret: string;
  poolMax?: number;
  ahora?: () => Date;
  /** Token del reto de alta de webhook. */
  webhookVerifyToken?: string;
  /**
   * Adaptadores de ingesta. Por defecto, el sandbox en los tres canales: en
   * desarrollo se puede ejercitar el camino completo del webhook sin
   * credenciales de Meta, que es justo el punto del sandbox.
   */
  adaptadoresDeIngesta?: Map<string, AdaptadorDeIngesta>;
  /** Resolucion de cuenta y secreto. En fase 1 leera channel_secrets. */
  resolverCuenta?: ResolverCuenta;
}

@Module({})
export class AppModule {
  /**
   * Modulo construido con `forRoot` y no con providers estaticos.
   *
   * Los tests necesitan apuntar a otra base y controlar el reloj. Con
   * providers que leen `process.env` al importarse, cada test tendria que
   * manipular variables de entorno globales, y dos tests en paralelo se
   * pisarian.
   */
  static forRoot(opciones: OpcionesDeApp): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, WebhooksController],
      providers: [
        {
          provide: TOKEN_DB,
          useFactory: () =>
            new BaseDeDatos(
              new Pool({ connectionString: opciones.databaseUrl, max: opciones.poolMax ?? 10 }),
              opciones.authDatabaseUrl
                ? new Pool({ connectionString: opciones.authDatabaseUrl, max: 4 })
                : undefined,
            ),
        },
        {
          provide: TOKEN_AUTH,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new AuthService({
              db,
              jwtSecret: opciones.jwtSecret,
              ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
            }),
        },
        {
          provide: TOKEN_INGESTA,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new IngestaService({
              db,
              adaptadores:
                opciones.adaptadoresDeIngesta ??
                new Map<string, AdaptadorDeIngesta>([
                  ['whatsapp', new IngestaSandbox('whatsapp')],
                  ['instagram', new IngestaSandbox('instagram')],
                  ['tiktok', new IngestaSandbox('tiktok')],
                ]),
              resolverCuenta: opciones.resolverCuenta ?? (async () => null),
              verifyToken: opciones.webhookVerifyToken ?? '',
            }),
        },
        AuthGuard,
      ],
      exports: [TOKEN_DB, TOKEN_AUTH, TOKEN_INGESTA],
    };
  }
}
