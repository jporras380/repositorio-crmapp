import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
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

  /** Todas las cuentas: qué se les debe cobrar y si van bien. */
  @Get('cuentas')
  cuentas(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.operador.cuentas());
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
