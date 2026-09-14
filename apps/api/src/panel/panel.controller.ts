import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { TOKEN_PANEL } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import type { ClaveDePeriodo, PanelService } from './panel.service.js';

const PERIODOS = new Set<string>(['24h', '7d', '30d']);

type Req = { contexto?: unknown };

@Controller('v1/panel')
@UseGuards(AuthGuard)
export class PanelController {
  constructor(@Inject(TOKEN_PANEL) private readonly panel: PanelService) {}

  /** Estado operativo de la bandeja. Lo accionable primero. */
  @Get()
  resumen(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.panel.resumen());
  }

  /** Cómo fue el periodo: ventanas móviles de 24 h, 7 o 30 días. */
  @Get('informe')
  informe(@Req() req: Req, @Query('periodo') periodo = '7d') {
    if (!PERIODOS.has(periodo)) {
      throw new ErrorDeNegocio('periodo_invalido', 'El periodo es 24h, 7d o 30d.', 400);
    }
    return conContextoDePeticion(req, () => this.panel.informe(periodo as ClaveDePeriodo));
  }
}
