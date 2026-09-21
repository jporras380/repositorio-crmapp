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
  TOKEN_OPERADOR,
  TOKEN_SOPORTE,
  TOKEN_PANEL,
  TOKEN_FLUJOS,
  TOKEN_EMBUDO,
  TOKEN_CONTACTOS,
  TOKEN_HOTEL,
  TOKEN_RESERVAS,
  TOKEN_IA,
  TOKEN_HORARIO,
  TOKEN_EVENTOS,
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
import { OperadorController } from './uso/operador.controller.js';
import { SoporteController } from './uso/soporte.controller.js';
import { SoporteService } from './uso/soporte.service.js';
import { OperadorService } from './uso/operador.service.js';
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
import { HorarioService } from './horario/horario.service.js';
import { HorarioController } from './horario/horario.controller.js';
import { EventosService } from './eventos/eventos.service.js';
import { EventosController } from './eventos/eventos.controller.js';
import { clienteDeIa, type ClienteDeIa } from './ia/cliente-de-ia.js';
import type { EditorDePlantillasDeMeta } from './plantillas/editor-de-meta.js';

export interface OpcionesDeApp {
  databaseUrl: string;
  /** URL con el rol `crmapp_auth`, de solo lectura (migraciones 0008 y 0011). */
  authDatabaseUrl?: string;
  /**
   * URL con el rol `crmapp_operador` (0040): solo lectura, solo facturación y
   * salud, a través de todos los inquilinos. Sin ella, la consola del operador
   * no ve nada — que es el fallo seguro.
   */
  operadorDatabaseUrl?: string;
  /**
   * URL con el rol `crmapp_soporte` (0042): solo lectura, dentro de un
   * inquilino y solo con permiso vivo. Sin ella, el modo soporte se niega a
   * funcionar en vez de caer al rol que sí puede escribir.
   */
  soporteDatabaseUrl?: string;
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
  /** Crea y borra plantillas HSM en Meta. Se inyecta en tests. */
  editorDePlantillas?: EditorDePlantillasDeMeta;
  /** Resolver de credenciales de WABA. Se inyecta en tests. */
  credencialesWhatsapp?: (id: string) => Promise<{ wabaId: string; accessToken: string }>;
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
        OperadorController,
        SoporteController,
        PanelController,
        FlujosController,
        EmbudoController,
        ContactosController,
        HotelController,
        ReservasController,
        IaController,
        HorarioController,
        EventosController,
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
              opciones.operadorDatabaseUrl
                ? new Pool({ connectionString: opciones.operadorDatabaseUrl, max: 2 })
                : undefined,
              opciones.soporteDatabaseUrl
                ? new Pool({ connectionString: opciones.soporteDatabaseUrl, max: 2 })
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
          inject: [TOKEN_DB, TOKEN_CIFRADOR],
          useFactory: (db: BaseDeDatos, cifrador: Cifrador) =>
            new AuthService({
              db,
              cifrador,
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
          inject: [TOKEN_DB, TOKEN_ADAPTADORES, TOKEN_CANALES],
          useFactory: (
            db: BaseDeDatos,
            adaptadores: Map<string, ChannelAdapter>,
            canales: CanalesService,
          ) =>
            new PlantillasService({
              db,
              canales: adaptadores,
              credencialesWhatsapp:
                opciones.credencialesWhatsapp ?? canales.resolverCredencialesWhatsapp,
              ...(opciones.editorDePlantillas ? { editor: opciones.editorDePlantillas } : {}),
              ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
            }),
        },
        {
          provide: TOKEN_MEDIOS,
          inject: [TOKEN_DB, TOKEN_ADAPTADORES],
          useFactory: (db: BaseDeDatos, canales: Map<string, ChannelAdapter>) =>
            new MediosService({
              db,
              almacen: opciones.almacen ?? (opciones.s3 ? new AlmacenS3(opciones.s3) : null),
              canales,
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
          // Una sola escucha de PostgreSQL por proceso, compartida por todas
          // las pantallas abiertas.
          provide: TOKEN_EVENTOS,
          useFactory: () => new EventosService({ databaseUrl: opciones.databaseUrl }),
        },
        {
          provide: TOKEN_HORARIO,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) => new HorarioService({ db }),
        },
        {
          provide: TOKEN_IA,
          inject: [TOKEN_DB, TOKEN_CIFRADOR, TOKEN_BANDEJA],
          useFactory: (db: BaseDeDatos, cifrador: Cifrador, bandeja: BandejaService) =>
            new IaService({
              db,
              cifrador,
              bandeja,
              // En tests se inyecta uno falso para todos los proveedores; en
              // producción, el que toque según lo que haya elegido el hotel.
              clientePara: opciones.clienteDeIa ? () => opciones.clienteDeIa! : clienteDeIa,
            }),
        },
        {
          provide: TOKEN_USO,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new UsoService({ db, ...(opciones.ahora ? { ahora: opciones.ahora } : {}) }),
        },
        {
          provide: TOKEN_OPERADOR,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new OperadorService({ db, ...(opciones.ahora ? { ahora: opciones.ahora } : {}) }),
        },
        {
          provide: TOKEN_SOPORTE,
          inject: [TOKEN_DB],
          useFactory: (db: BaseDeDatos) =>
            new SoporteService({ db, ...(opciones.ahora ? { ahora: opciones.ahora } : {}) }),
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
        TOKEN_OPERADOR,
        TOKEN_SOPORTE,
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
