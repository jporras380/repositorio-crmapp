import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_OPERADOR, TOKEN_SOPORTE } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { OperadorService } from './operador.service.js';
import type { SoporteService } from './soporte.service.js';

const Soporte = z.object({
  tenantId: z.string().uuid(),
  /** Obligatorio y largo: es lo único que el cliente tiene para decidir. */
  motivo: z.string().trim().min(10).max(500),
});

const Mensaje = z.object({ cuerpo: z.string().trim().min(1).max(4000) });

/** Los datos de cobro de la plataforma (0048). Todo opcional: se guarda lo que llega. */
const DatosDeCobro = z
  .object({
    banco: z.string().trim().max(80).nullable(),
    tipo_de_cuenta: z.string().trim().max(40).nullable(),
    numero_de_cuenta: z.string().trim().max(40).nullable(),
    cci: z.string().trim().max(40).nullable(),
    titular: z.string().trim().max(120).nullable(),
    documento_titular: z.string().trim().max(20).nullable(),
    numero_billetera: z.string().trim().max(20).nullable(),
    titular_billetera: z.string().trim().max(120).nullable(),
    nota: z.string().trim().max(500).nullable(),
  })
  .partial();

const SolesDePlan = z.object({
  codigoDePlan: z.string().trim().min(1).max(40),
  /** `null` quita el importe: el plan vuelve a no tener precio en soles. */
  centimos: z.number().int().positive().nullable(),
});

const Resolucion = z.object({
  tenantId: z.string().uuid(),
  confirmar: z.boolean(),
  nota: z.string().trim().max(500).optional(),
  cubreDesde: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cubreHasta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const Comprobante = z.object({
  tenantId: z.string().uuid(),
  mediaAssetId: z.string().uuid(),
  /** El número del comprobante emitido, para que el hotel lo reconozca. */
  numero: z.string().trim().max(40).optional(),
});

type Req = { contexto?: unknown };

/**
 * Rutas del personal de la PLATAFORMA, no de ningún hotel.
 *
 * Bajo `/v1/operador` y en su propio archivo: un camino que cruza de inquilino
 * tiene que verse en cualquier búsqueda, no esconderse entre las rutas de la
 * cuenta. Quien no es operador recibe 404, no 403 — no tiene por qué saber que
 * esto existe.
 */
@Controller('v1/operador')
@UseGuards(AuthGuard)
export class OperadorController {
  constructor(
    @Inject(TOKEN_OPERADOR) private readonly operador: OperadorService,
    @Inject(TOKEN_SOPORTE) private readonly soporte: SoporteService,
  ) {}

  /** A dónde te pagan: lo que verá el cliente en su Suscripción (0048). */
  @Get('cobro')
  datosDeCobro(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.operador.datosDeCobro());
  }

  @Put('cobro')
  @HttpCode(204)
  async guardarCobro(@Req() req: Req, @Body() body: unknown) {
    const r = DatosDeCobro.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Datos de cobro inválidos.', 400);
    await conContextoDePeticion(req, () =>
      this.operador.guardarDatosDeCobro(r.data as Record<string, string | null>),
    );
  }

  /** Publica el QR de Yape o Plin. El archivo se sube antes por la vía normal. */
  @Put('cobro/qr')
  @HttpCode(204)
  async publicarQr(@Req() req: Req, @Body() body: unknown) {
    const r = z.object({ mediaAssetId: z.string().uuid() }).safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Falta el archivo.', 400);
    await conContextoDePeticion(req, () => this.operador.publicarQr(r.data.mediaAssetId));
  }

  /** El importe en soles de un plan: los planes están en USD y Yape cobra en soles. */
  @Put('cobro/soles')
  @HttpCode(204)
  async guardarSoles(@Req() req: Req, @Body() body: unknown) {
    const r = SolesDePlan.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Falta el plan o el importe.', 400);
    await conContextoDePeticion(req, () =>
      this.operador.guardarSolesDePlan(r.data.codigoDePlan, r.data.centimos),
    );
  }

  /** Quién dice haber pagado y nadie ha mirado. */
  @Get('pagos-declarados')
  declaraciones(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.operador.declaracionesPendientes());
  }

  /** Confirmarla crea el pago de verdad; rechazarla exige decir por qué. */
  @Post('pagos-declarados/:id')
  @HttpCode(200)
  resolver(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const r = Resolucion.safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Faltan datos.', 400);
    return conContextoDePeticion(req, () =>
      this.operador.resolverDeclaracion({
        id,
        tenantId: r.data.tenantId,
        confirmar: r.data.confirmar,
        ...(r.data.nota !== undefined ? { nota: r.data.nota } : {}),
        ...(r.data.cubreDesde !== undefined ? { cubreDesde: r.data.cubreDesde } : {}),
        ...(r.data.cubreHasta !== undefined ? { cubreHasta: r.data.cubreHasta } : {}),
      }),
    );
  }

  /** Todas las cuentas: qué se les debe cobrar y si van bien. */
  @Get('cuentas')
  cuentas(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.operador.cuentas());
  }

  /**
   * El detalle de una cuenta: sus pagos sin comprobante y el acceso de
   * soporte que haya. Es lo que hace falta para ACTUAR sobre ella.
   */
  @Get('cuentas/:tenantId')
  detalle(@Req() req: Req, @Param('tenantId') tenantId: string) {
    return conContextoDePeticion(req, () => this.operador.detalleDe(tenantId));
  }

  /** Pide entrar a una cuenta. No la abre: la abre el cliente. */
  @Post('soporte')
  @HttpCode(201)
  pedirSoporte(@Req() req: Req, @Body() body: unknown) {
    const r = Soporte.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio('datos_invalidos', 'Falta la cuenta o el motivo.', 400);
    }
    return conContextoDePeticion(req, () => this.soporte.pedirAcceso(r.data));
  }

  /** El hilo de soporte de una cuenta. Leerlo lo marca como leído. */
  @Get('soporte/:tenantId/mensajes')
  hiloDe(@Req() req: Req, @Param('tenantId') tenantId: string) {
    return conContextoDePeticion(req, () => this.soporte.hiloDe(tenantId));
  }

  /** Responder. No exige permiso de soporte: contestar no es entrar. */
  @Post('soporte/:tenantId/mensajes')
  @HttpCode(201)
  responder(@Req() req: Req, @Param('tenantId') tenantId: string, @Body() body: unknown) {
    const r = Mensaje.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio('mensaje_invalido', 'Escribe la respuesta.', 422);
    }
    return conContextoDePeticion(req, () => this.soporte.responder(tenantId, r.data.cuerpo));
  }

  /**
   * La captura que mandó el cliente, firmada.
   *
   * El servicio solo la firma si cuelga de un mensaje de soporte de ESA
   * cuenta: no es un lector de medios, es el adjunto de este hilo.
   */
  @Get('soporte/:tenantId/adjuntos/:mediaAssetId')
  adjuntoDeSoporte(
    @Req() req: Req,
    @Param('tenantId') tenantId: string,
    @Param('mediaAssetId') mediaAssetId: string,
  ) {
    return conContextoDePeticion(req, () => this.soporte.urlDeAdjunto(tenantId, mediaAssetId));
  }

  /** Lo que está fallando en esa cuenta. Exige un permiso vivo. */
  @Get('soporte/:tenantId/conversaciones')
  conversacionesDeSoporte(@Req() req: Req, @Param('tenantId') tenantId: string) {
    return conContextoDePeticion(req, () => this.soporte.conversacionesDe(tenantId));
  }

  @Post('pagos/:id/comprobante')
  adjuntar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const r = Comprobante.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () =>
      this.operador.adjuntarComprobante({
        tenantId: r.data.tenantId,
        pagoId: id,
        mediaAssetId: r.data.mediaAssetId,
        ...(r.data.numero !== undefined ? { numero: r.data.numero } : {}),
      }),
    );
  }
}
