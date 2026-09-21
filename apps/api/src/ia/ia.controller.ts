import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_IA } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import { PROVEEDORES } from './proveedores.js';
import type { IaService } from './ia.service.js';

const Ajustes = z.object({
  activa: z.boolean().optional(),
  proveedor: z.enum(PROVEEDORES).optional(),
  /*
    Texto libre y no una lista cerrada: los nombres de modelo cambian cada
    pocos meses, y una lista cerrada obligaría a desplegar el CRM para usar el
    que salió ayer. Lo que valida de verdad es el propio proveedor cuando se
    guarda la clave; aquí solo se corta lo que no puede ser un nombre.
  */
  modelo: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[A-Za-z0-9._:\/-]+$/, 'nombre de modelo')
    .optional(),
  instrucciones: z.string().max(8000).optional(),
  /*
    Antes se exigía el formato de Anthropic (`sk-ant-…`). Con cuatro
    proveedores, cada uno tiene el suyo y cambian sin avisar: comprobar la
    forma aquí rechazaría claves buenas el día que uno estrene prefijo. Se
    corta solo lo que claramente no es una clave —vacío, con espacios, absurda
    de corta— y lo demás lo dice el proveedor, que es quien lo sabe.
  */
  clave: z
    .string()
    .trim()
    .min(16, 'la clave parece incompleta')
    .max(400)
    .regex(/^\S+$/, 'una clave de API no lleva espacios')
    .optional(),
});

const ClaveABorrar = z.object({ proveedor: z.enum(PROVEEDORES).optional() });

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

  /** Sin decir cuál, borra la del proveedor en uso. */
  @Delete('ia/clave')
  borrarClave(@Req() req: Req, @Query('proveedor') proveedor?: string) {
    const r = ClaveABorrar.safeParse({ proveedor });
    if (!r.success) {
      throw new ErrorDeNegocio('proveedor_invalido', 'Ese proveedor no existe.', 422);
    }
    return conContextoDePeticion(req, () => this.ia.borrarClave(r.data.proveedor));
  }

  @Post('conversaciones/:id/sugerencia')
  @HttpCode(200)
  sugerir(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.ia.sugerir(id));
  }
}
