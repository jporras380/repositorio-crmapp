import { Module, type DynamicModule } from '@nestjs/common';
import { Pool } from 'pg';
import { Cifrador, parsearClaveMaestra } from '@crmapp/crypto';
import {
  AdaptadorFacebook,
  AdaptadorInstagram,
  AdaptadorSandbox,
  AdaptadorWhatsapp,
  IngestaFacebook,
  IngestaInstagram,
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
  TOKEN_PLANTILLAS,
  TOKEN_ADAPTADORES,
  TOKEN_USO,
  TOKEN_PANEL,
  TOKEN_FLUJOS,
  TOKEN_EMBUDO,
  TOKEN_CONTACTOS,
  TOKEN_HOTEL,
  TOKEN_RESERVAS,
  TOKEN_IA,
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
  type SuscriptorDeWebhook,
  type VerificadorDeInstagram,
} from './canales/canales.service.js';
import { CanalesController } from './canales/canales.controller.js';
import type { DescubridorDeMeta } from './canales/descubrimiento.js';
import { MediosService } from './medios/medios.service.js';
import { MediosController } from './medios/medios.controller.js';
import { PlantillasService } from './plantillas/plantillas.service.js';
import {
  PlantillasWhatsappController,
  RespuestasRapidasController,
} from './plantillas/plantillas.controller.js';
import { UsoService } from './uso/uso.service.js';
import { UsoController } from './uso/uso.controller.js';
import { PanelService } from './panel/panel.service.js';
import { PanelController } from './panel/panel.controller.js';
import { FlujosService } from './flujos/flujos.service.js';
import { FlujosController } from './flujos/flujos.controller.js';
import { EmbudoService } from './embudo/embudo.service.js';
import { EmbudoController } from './embudo/embudo.controller.js';
import { ContactosService } from './contactos/contactos.service.js';
import { ContactosController } from './contactos/contactos.controller.js';
import { HotelService } from './hotel/hotel.service.js';
import { HotelController } from './hotel/hotel.controller.js';
import { ReservasService } from './reservas/reservas.service.js';
import { ReservasController } from './reservas/reservas.controller.js';
import { IaService } from './ia/ia.service.js';
import { IaController } from './ia/ia.controller.js';
import { clienteAnthropic, type ClienteDeIa } from './ia/cliente-de-ia.js';

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
  verificarCredencialesInstagram?: VerificadorDeInstagram;
  /** Suscribe la WABA a nuestra app al conectar. Se inyecta en tests. */
  suscribir?: SuscriptorDeWebhook;
  /** Descubre cuentas con un solo token y suscribe páginas de Instagram. Se inyecta en tests. */
  descubridor?: DescubridorDeMeta;
  /** Proveedor de IA (Anthropic con la clave del hotel). Se inyecta en tests. */
  clienteDeIa?: ClienteDeIa;
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
        PlantillasWhatsappController,
        RespuestasRapidasController,
        UsoController,
        PanelController,
        FlujosController,
        EmbudoController,
        ContactosController,
        HotelController,
        ReservasController,
        IaController,
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
              ...(opciones.verificarCredencialesInstagram
                ? { verificarInstagram: opciones.verificarCredencialesInstagram }
                : {}),
              ...(opciones.suscribir ? { suscribir: opciones.suscribir } : {}),
              ...(opciones.descubridor ? { descubridor: opciones.descubridor } : {}),
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
                      ['facebook', new IngestaSandbox('facebook')],
                    ])
                  : new Map<string, AdaptadorDeIngesta>([
                      ['whatsapp', new IngestaWhatsapp()],
                      ['instagram', new IngestaInstagram()],
                      ['facebook', new IngestaFacebook()],
                    ])),
              // Por defecto, la resolución real: cuenta y app secret desde la
              // base, descifrados con la clave maestra.
              resolverCuenta: opciones.resolverCuenta ?? canales.resolverCuenta,
              verifyToken: opciones.webhookVerifyToken ?? '',
            }),
        },
        {
          // Un solo mapa de adaptadores para bandeja y plantillas: el sandbox
          // de un test debe ser la MISMA instancia en las dos.
          provide: TOKEN_ADAPTADORES,
          inject: [TOKEN_CANALES],
          useFactory: (canales: CanalesService): Map<string, ChannelAdapter> =>
            opciones.canales ??
            (opciones.modoSandbox
              ? new Map<string, ChannelAdapter>([
                  ['whatsapp', new AdaptadorSandbox({ canal: 'whatsapp' })],
                  ['instagram', new AdaptadorSandbox({ canal: 'instagram' })],
                  ['facebook', new AdaptadorSandbox({ canal: 'facebook' })],
                ])
              : new Map<string, ChannelAdapter>([
                  [
                    'whatsapp',
                    new AdaptadorWhatsapp({
                      resolverCredenciales: canales.resolverCredencialesWhatsapp,
                    }),
                  ],
                  [
                    'instagram',
                    new AdaptadorInstagram({
                      resolverCredenciales: canales.resolverCredencialesInstagram,
                    }),
                  ],
                  [
                    'facebook',
                    new AdaptadorFacebook({
                      resolverCredenciales: canales.resolverCredencialesFacebook,
                    }),
                  ],
                ])),
        },
        {
          provide: TOKEN_BANDEJA,
          inject: [TOKEN_DB, TOKEN_ADAPTADORES],
          useFactory: (db: BaseDeDatos, adaptadores: Map<string, ChannelAdapter>) =>
            new BandejaService({
              db,
              canales: adaptadores,
              ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
            }),
        },
        {
          provide: TOKEN_PLANTILLAS,
          inject: [TOKEN_DB, TOKEN_ADAPTADORES],
          useFactory: (db: BaseDeDatos, adaptadores: Map<string, ChannelAdapter>) =>
            new PlantillasService({
              db,
              canales: adaptadores,
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
        {
          provide: TOKEN_PANEL,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new PanelService({ db, ...(opciones.ahora ? { ahora: opciones.ahora } : {}) }),
        },
        {
          provide: TOKEN_FLUJOS,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) => new FlujosService({ db }),
        },
        {
          provide: TOKEN_EMBUDO,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) => new EmbudoService({ db }),
        },
        {
          provide: TOKEN_CONTACTOS,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) => new ContactosService({ db }),
        },
        {
          provide: TOKEN_HOTEL,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) => new HotelService({ db, ahora: opciones.ahora }),
        },
        {
          // La reserva recibe el MISMO servicio de hotel que usa el cotizador:
          // es lo que garantiza que el precio reservado es el cotizado.
          provide: TOKEN_RESERVAS,
          inject: [TOKEN_DB, TOKEN_HOTEL],
          useFactory: (db: BaseDeDatos, hotel: HotelService) => new ReservasService({ db, hotel }),
        },
        {
          provide: TOKEN_IA,
          inject: [TOKEN_DB, TOKEN_CIFRADOR, TOKEN_BANDEJA],
          useFactory: (db: BaseDeDatos, cifrador: Cifrador, bandeja: BandejaService) =>
            new IaService({
              db,
              cifrador,
              bandeja,
              cliente: opciones.clienteDeIa ?? clienteAnthropic(),
            }),
        },
        {
          provide: TOKEN_USO,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new UsoService({ db, ...(opciones.ahora ? { ahora: opciones.ahora } : {}) }),
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
        TOKEN_PLANTILLAS,
        TOKEN_USO,
        TOKEN_PANEL,
        TOKEN_FLUJOS,
        TOKEN_EMBUDO,
        TOKEN_CONTACTOS,
        TOKEN_HOTEL,
        TOKEN_RESERVAS,
      ],
    };
  }
}
