import {
  Body,
  Controller,
  Delete,
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
import { TOKEN_IA } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { MODELOS_DE_IA } from './cliente-de-ia.js';
import type { IaService } from './ia.service.js';

const Ajustes = z.object({
  activa: z.boolean().optional(),
  modelo: z.enum(MODELOS_DE_IA).optional(),
  instrucciones: z.string().max(8000).optional(),
  // Las claves de Anthropic empiezan por `sk-ant-`; se valida la forma para
  // no llamar al proveedor con lo que claramente no es una clave.
  clave: z
    .string()
    .trim()
    .regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, 'clave de API de Anthropic (empieza por sk-ant-)')
    .optional(),
});

type Req = { contexto?: unknown };

@Controller('v1')
@UseGuards(AuthGuard)
export class IaController {
  constructor(@Inject(TOKEN_IA) private readonly ia: IaService) {}

  @Get('ia/ajustes')
  ajustes(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.ia.ajustes());
  }

  /** PUT: la clave viaja en el cuerpo, nunca en la URL, y ninguna respuesta la devuelve. */
  @Put('ia/ajustes')
  guardar(@Req() req: Req, @Body() body: unknown) {
    const r = Ajustes.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () => this.ia.guardarAjustes(r.data));
  }

  @Delete('ia/clave')
  borrarClave(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.ia.borrarClave());
  }

  @Post('conversaciones/:id/sugerencia')
  @HttpCode(200)
  sugerir(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.ia.sugerir(id));
  }
}
