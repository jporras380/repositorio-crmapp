import { Body, Controller, Get, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_USO } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { UsoService } from './uso.service.js';

const Facturacion = z.object({
  tipo: z.enum(['boleta', 'factura']),
  // Se aceptan vacíos y se limpian en el servicio: quien borra un campo del
  // formulario manda `''`, no `null`, y rechazarlo sería un error sin motivo.
  documento: z.string().trim().max(20).nullable().default(null),
  nombre: z.string().trim().max(200).nullable().default(null),
  direccion: z.string().trim().max(300).nullable().default(null),
});

type Req = { contexto?: unknown };

@Controller('v1/cuenta')
@UseGuards(AuthGuard)
export class UsoController {
  constructor(@Inject(TOKEN_USO) private readonly uso: UsoService) {}

  /** Qué se paga y hasta cuándo está cubierto (ADR-011). Solo lectura. */
  @Get('suscripcion')
  suscripcion(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.uso.suscripcion());
  }

  /** A nombre de quién se emiten los comprobantes: factura o boleta (0039). */
  @Put('suscripcion/facturacion')
  facturacion(@Req() req: Req, @Body() body: unknown) {
    const r = Facturacion.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () => this.uso.guardarFacturacion(r.data));
  }

  /** Consumo del mes en curso frente a los límites del plan. */
  @Get('uso')
  resumen(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.uso.resumen());
  }
}
