import { Module, type DynamicModule } from '@nestjs/common';
import { Pool } from 'pg';
import { Cifrador, parsearClaveMaestra } from '@crmapp/crypto';
import {
  AdaptadorSandbox,
  AdaptadorWhatsapp,
  IngestaSandbox,
  IngestaWhatsapp,
  type AdaptadorDeIngesta,
  type ChannelAdapter,
} from '@crmapp/channels';
import { AlmacenS3, type Almacen, type ConfigDeS3 } from '@crmapp/storage';
import { BaseDeDatos } from './db.js';
import {
  TOKEN_AUTH,
  TOKEN_BANDEJA,
  TOKEN_CANALES,
  TOKEN_CIFRADOR,
  TOKEN_DB,
  TOKEN_INGESTA,
  TOKEN_MEDIOS,
} from './tokens.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { IngestaService, type ResolverCuenta } from './webhooks/ingesta.service.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { BandejaService } from './bandeja/bandeja.service.js';
import { BandejaController } from './bandeja/bandeja.controller.js';
import {
  CanalesService,
  verificadorGraph,
  type VerificadorDeCredenciales,
} from './canales/canales.service.js';
import { CanalesController } from './canales/canales.controller.js';
import { MediosService } from './medios/medios.service.js';
import { MediosController } from './medios/medios.controller.js';

export interface OpcionesDeApp {
  databaseUrl: string;
  /** URL con el rol `crmapp_auth`, de solo lectura (migraciones 0008 y 0011). */
  authDatabaseUrl?: string;
  jwtSecret: string;
  poolMax?: number;
  ahora?: () => Date;
  /** Token del reto de alta de webhook. */
  webhookVerifyToken?: string;
  /**
   * Clave maestra (base64, 32 bytes) y su versión. Sin ella no hay conexión
   * BYO: los secretos de canal no se pueden cifrar. Obligatoria.
   */
  masterKey: string;
  masterKeyVersion?: number;
  /** Verificación de credenciales contra Meta. Se inyecta en tests. */
  verificarCredenciales?: VerificadorDeCredenciales;
  /**
   * Sandbox en vez de canal real. Solo para tests y demos sin Meta. En
   * producción el valor por defecto es el adaptador real de WhatsApp.
   */
  modoSandbox?: boolean;
  /** Sobrescriben los adaptadores por completo. Para tests. */
  adaptadoresDeIngesta?: Map<string, AdaptadorDeIngesta>;
  canales?: Map<string, ChannelAdapter>;
  resolverCuenta?: ResolverCuenta;
  /** S3 real (MinIO/R2). Sin `s3` ni `almacen`, las rutas de medios responden 503. */
  s3?: ConfigDeS3;
  /** Sobrescribe el almacén por completo. Para tests. */
  almacen?: Almacen;
}

@Module({})
export class AppModule {
  /**
   * Módulo construido con `forRoot` y no con providers estáticos.
   *
   * Los tests necesitan apuntar a otra base y controlar el reloj. Con
   * providers que leen `process.env` al importarse, cada test tendría que
   * manipular variables de entorno globales, y dos tests en paralelo se
   * pisarían.
   */
  static forRoot(opciones: OpcionesDeApp): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        WebhooksController,
        BandejaController,
        CanalesController,
        MediosController,
      ],
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
          provide: TOKEN_CIFRADOR,
          useFactory: () => {
            const version = opciones.masterKeyVersion ?? 1;
            return new Cifrador({
              versionActual: version,
              claves: { [version]: parsearClaveMaestra(opciones.masterKey) },
            });
          },
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
          provide: TOKEN_CANALES,
          inject: [TOKEN_DB, TOKEN_CIFRADOR],
          useFactory: (db: BaseDeDatos, cifrador: Cifrador) =>
            new CanalesService({
              db,
              cifrador,
              verificar: opciones.verificarCredenciales ?? verificadorGraph(),
            }),
        },
        {
          provide: TOKEN_INGESTA,
          inject: [TOKEN_DB, TOKEN_CANALES],
          useFactory: (db: BaseDeDatos, canales: CanalesService) =>
            new IngestaService({
              db,
              adaptadores:
                opciones.adaptadoresDeIngesta ??
                (opciones.modoSandbox
                  ? new Map<string, AdaptadorDeIngesta>([
                      ['whatsapp', new IngestaSandbox('whatsapp')],
                      ['instagram', new IngestaSandbox('instagram')],
                    ])
                  : new Map<string, AdaptadorDeIngesta>([['whatsapp', new IngestaWhatsapp()]])),
              // Por defecto, la resolución real: cuenta y app secret desde la
              // base, descifrados con la clave maestra.
              resolverCuenta: opciones.resolverCuenta ?? canales.resolverCuenta,
              verifyToken: opciones.webhookVerifyToken ?? '',
            }),
        },
        {
          provide: TOKEN_BANDEJA,
          inject: [TOKEN_DB, TOKEN_CANALES],
          useFactory: (db: BaseDeDatos, canales: CanalesService) =>
            new BandejaService({
              db,
              canales:
                opciones.canales ??
                (opciones.modoSandbox
                  ? new Map<string, ChannelAdapter>([
                      ['whatsapp', new AdaptadorSandbox({ canal: 'whatsapp' })],
                      ['instagram', new AdaptadorSandbox({ canal: 'instagram' })],
                    ])
                  : new Map<string, ChannelAdapter>([
                      [
                        'whatsapp',
                        new AdaptadorWhatsapp({
                          resolverCredenciales: canales.resolverCredencialesWhatsapp,
                        }),
                      ],
                    ])),
              ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
            }),
        },
        {
          provide: TOKEN_MEDIOS,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new MediosService({
              db,
              almacen: opciones.almacen ?? (opciones.s3 ? new AlmacenS3(opciones.s3) : null),
            }),
        },
        AuthGuard,
      ],
      exports: [
        TOKEN_DB,
        TOKEN_AUTH,
        TOKEN_INGESTA,
        TOKEN_BANDEJA,
        TOKEN_CANALES,
        TOKEN_CIFRADOR,
        TOKEN_MEDIOS,
      ],
    };
  }
}
