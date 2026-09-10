import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { TOKEN_USO } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import type { UsoService } from './uso.service.js';

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

  /** Consumo del mes en curso frente a los límites del plan. */
  @Get('uso')
  resumen(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.uso.resumen());
  }
}
