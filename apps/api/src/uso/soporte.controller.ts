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
import { TOKEN_SOPORTE } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { HORAS_MAXIMAS, type SoporteService } from './soporte.service.js';

/**
 * El cuerpo puede ir vacío SI hay captura: mandar una imagen sin texto es una
 * forma legítima de decir «mira esto». Lo que no se acepta es un mensaje sin
 * ninguna de las dos cosas, y eso lo comprueba el `refine`.
 */
const Mensaje = z
  .object({
    cuerpo: z.string().trim().max(4000),
    mediaAssetId: z.string().uuid().optional(),
  })
  .refine((m) => m.cuerpo.length > 0 || m.mediaAssetId !== undefined);

const Aprobacion = z.object({ horas: z.number().int().min(1).max(HORAS_MAXIMAS) });

type Req = { contexto?: unknown };

/**
 * El lado del CLIENTE del modo soporte: ver quién pide entrar, abrir y cerrar.
 *
 * Va bajo `/v1/cuenta` y no bajo `/v1/operador` a propósito: esto es de la
 * cuenta del hotel, no de la plataforma. Quien decide es quien recibe.
 */
@Controller('v1/cuenta/soporte')
@UseGuards(AuthGuard)
export class SoporteController {
  constructor(@Inject(TOKEN_SOPORTE) private readonly soporte: SoporteService) {}

  /** Quién ha pedido entrar, quién entró, y cuándo. Cualquiera del equipo lo ve. */
  @Get()
  permisos(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.soporte.permisos());
  }

  /** El hilo con soporte técnico. Abrirlo marca como leído lo que respondieron. */
  @Get('mensajes')
  hilo(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.soporte.hilo());
  }

  /** Escribir a soporte. Cualquiera del equipo: el que se topa lo cuenta. */
  @Post('mensajes')
  @HttpCode(201)
  escribir(@Req() req: Req, @Body() body: unknown) {
    const r = Mensaje.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio('mensaje_vacio', 'Escribe qué te pasa o adjunta una captura.', 422);
    }
    return conContextoDePeticion(req, () =>
      this.soporte.escribir(r.data.cuerpo, r.data.mediaAssetId ?? null),
    );
  }

  @Post(':id/aprobar')
  @HttpCode(200)
  aprobar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const r = Aprobacion.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'plazo_invalido',
        `El acceso puede durar entre 1 y ${HORAS_MAXIMAS} horas.`,
        422,
      );
    }
    return conContextoDePeticion(req, () => this.soporte.aprobar(id, r.data.horas));
  }

  /** Sirve igual para rechazar una solicitud que para echar a alguien ya dentro. */
  @Post(':id/revocar')
  @HttpCode(200)
  revocar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.soporte.revocar(id));
  }
}
