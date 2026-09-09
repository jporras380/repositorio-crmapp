import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_PLANTILLAS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { PlantillasService } from './plantillas.service.js';

const NuevaRapida = z.object({
  atajo: z.string().regex(/^\/[a-z0-9_-]{1,30}$/, 'atajo con forma /gracias'),
  titulo: z.string().min(1).max(80),
  cuerpo: z.string().max(4096).default(''),
  mediaAssetId: z.string().uuid().optional(),
});
const EdicionRapida = z
  .object({
    atajo: NuevaRapida.shape.atajo.optional(),
    titulo: NuevaRapida.shape.titulo.optional(),
    cuerpo: z.string().max(4096).optional(),
    // `null` quita el adjunto; ausente lo deja como está.
    mediaAssetId: z.string().uuid().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'sin cambios');

function validar<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, datos: unknown): T {
  const r = esquema.safeParse(datos);
  if (!r.success) {
    const detalle = r.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    throw new ErrorDeNegocio('datos_invalidos', detalle, 400);
  }
  return r.data;
}

type Req = { contexto?: unknown };

@Controller('v1/canales/:id/plantillas')
@UseGuards(AuthGuard)
export class PlantillasWhatsappController {
  constructor(@Inject(TOKEN_PLANTILLAS) private readonly plantillas: PlantillasService) {}

  @Get()
  listar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.plantillas.listarWhatsapp(id));
  }

  /** Trae el estado real de Meta. 200 con el recuento; el estado no se inventa aquí. */
  @Post('sincronizar')
  @HttpCode(200)
  sincronizar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.plantillas.sincronizar(id));
  }
}

@Controller('v1/respuestas-rapidas')
@UseGuards(AuthGuard)
export class RespuestasRapidasController {
  constructor(@Inject(TOKEN_PLANTILLAS) private readonly plantillas: PlantillasService) {}

  @Get()
  listar(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.plantillas.listarRapidas());
  }

  @Post()
  @HttpCode(201)
  crear(@Req() req: Req, @Body() body: unknown) {
    const d = validar(NuevaRapida, body);
    return conContextoDePeticion(req, () => this.plantillas.crearRapida(d));
  }

  @Patch(':id')
  editar(@Req() req: Req, @Param('id') id: string, @Body() body: unknown) {
    const d = validar(EdicionRapida, body);
    return conContextoDePeticion(req, () =>
      this.plantillas.editarRapida(id, {
        ...(d.atajo !== undefined ? { atajo: d.atajo } : {}),
        ...(d.titulo !== undefined ? { titulo: d.titulo } : {}),
        ...(d.cuerpo !== undefined ? { cuerpo: d.cuerpo } : {}),
        // null → sin adjunto; el servicio distingue "no tocar" de "quitar".
        ...(d.mediaAssetId !== undefined ? { mediaAssetId: d.mediaAssetId ?? undefined } : {}),
      }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async archivar(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.plantillas.archivarRapida(id));
  }
}
