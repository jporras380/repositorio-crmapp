import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Grafo } from '@crmapp/core';
import { TOKEN_FLUJOS } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { Disparador, FlujosService } from './flujos.service.js';

/**
 * El grafo se valida DOS veces y no es redundante: aquí se comprueba la forma
 * —que un nodo `mensaje` traiga texto y no un número— y en `packages/core` se
 * comprueba el sentido —que no haya un bucle que envíe sin parar—. Zod no
 * puede saber lo segundo y core no debería saber de JSON entrante.
 */
const NodoSchema = z.discriminatedUnion('tipo', [
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('mensaje'),
    texto: z.string().min(1).max(4096),
    siguiente: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('esperar_respuesta'),
    segundos: z.number().int().positive(),
    siguiente: z.string().nullable(),
    alExpirar: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('pausa'),
    segundos: z.number().int().positive(),
    siguiente: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('condicion'),
    casos: z
      .array(
        z.object({ contiene: z.array(z.string().min(1)).min(1), siguiente: z.string().nullable() }),
      )
      .max(20),
    siNo: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('etiquetar'),
    etiquetaId: z.string().uuid(),
    siguiente: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('asignar'),
    usuarioId: z.string().uuid(),
    siguiente: z.string().nullable(),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('relevo'),
    // 120 es lo que cabe de un vistazo en la cabecera del hilo. Un motivo más
    // largo no lo lee nadie con una conversación esperando.
    motivo: z.string().min(1).max(120),
  }),
  z.object({
    id: z.string().min(1).max(64),
    tipo: z.literal('fin'),
    cerrarConversacion: z.boolean().optional(),
  }),
]);

const GrafoSchema = z.object({
  inicio: z.string().min(1),
  nodos: z.array(NodoSchema).max(200),
});

const DisparadorSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('conversacion_abierta'), activo: z.boolean().optional() }),
  z.object({
    tipo: z.literal('palabra_clave'),
    palabras: z.array(z.string().min(1).max(60)).min(1).max(50),
    activo: z.boolean().optional(),
  }),
]);

const NuevoFlujo = z.object({
  nombre: z.string().min(1).max(80),
  grafo: GrafoSchema,
  disparadores: z.array(DisparadorSchema).max(10).default([]),
});

const EdicionFlujo = z
  .object({
    nombre: z.string().min(1).max(80).optional(),
    grafo: GrafoSchema.optional(),
    disparadores: z.array(DisparadorSchema).max(10).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'sin cambios');

const Prueba = z.object({
  grafo: GrafoSchema,
  /** Respuestas de mentira, en orden. Cada una desbloquea una espera. */
  respuestas: z.array(z.string().max(4096)).max(20).default([]),
});

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

@Controller('v1/flujos')
@UseGuards(AuthGuard)
export class FlujosController {
  constructor(@Inject(TOKEN_FLUJOS) private readonly flujos: FlujosService) {}

  @Get()
  listar(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.flujos.listar());
  }

  @Get(':id')
  detalle(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.flujos.detalle(id));
  }

  @Post()
  crear(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(NuevoFlujo, cuerpo);
    return conContextoDePeticion(req, () =>
      this.flujos.crear({
        nombre: d.nombre,
        grafo: d.grafo as Grafo,
        disparadores: d.disparadores as Disparador[],
      }),
    );
  }

  /** Guardar es versionar: el grafo anterior sigue intacto para lo que ya corre. */
  @Patch(':id')
  guardar(@Req() req: Req, @Param('id') id: string, @Body() cuerpo: unknown) {
    const d = validar(EdicionFlujo, cuerpo);
    return conContextoDePeticion(req, () =>
      this.flujos.guardarVersion(id, {
        ...(d.nombre !== undefined ? { nombre: d.nombre } : {}),
        ...(d.grafo !== undefined ? { grafo: d.grafo as Grafo } : {}),
        ...(d.disparadores !== undefined ? { disparadores: d.disparadores as Disparador[] } : {}),
      }),
    );
  }

  @Post(':id/publicar')
  publicar(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.flujos.publicar(id));
  }

  @Post(':id/pausar')
  async pausar(@Req() req: Req, @Param('id') id: string) {
    await conContextoDePeticion(req, () => this.flujos.pausar(id));
    return { pausado: true };
  }

  @Get(':id/ejecuciones')
  ejecuciones(@Req() req: Req, @Param('id') id: string) {
    return conContextoDePeticion(req, () => this.flujos.ejecuciones(id));
  }

  /** Modo prueba: dice qué haría el flujo, sin enviar nada a nadie. */
  @Post('probar')
  probar(@Req() req: Req, @Body() cuerpo: unknown) {
    const d = validar(Prueba, cuerpo);
    return conContextoDePeticion(req, () =>
      Promise.resolve(this.flujos.probar(d.grafo as Grafo, d.respuestas)),
    );
  }
}
