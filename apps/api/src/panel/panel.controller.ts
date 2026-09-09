import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { TOKEN_PANEL } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import type { PanelService } from './panel.service.js';

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
}
