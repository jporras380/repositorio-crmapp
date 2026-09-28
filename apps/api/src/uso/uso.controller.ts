import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TOKEN_USO } from '../tokens.js';
import { AuthGuard, conContextoDePeticion } from '../auth/auth.guard.js';
import { ErrorDeNegocio } from '../auth/auth.service.js';
import type { UsoService } from './uso.service.js';

/**
 * Lo que el cliente declara haber pagado (0048).
 *
 * `pagadoEl` es una fecha y no un instante: quien rellena esto copia lo que
 * dice su banco, y ahí no hay hora ni zona horaria que valga la pena pedir.
 */
const Declaracion = z.object({
  importeCentimos: z.number().int().positive(),
  moneda: z.string().length(3).default('USD'),
  metodo: z.enum(['transferencia', 'yape', 'plin', 'otro']),
  referencia: z.string().trim().max(80).optional(),
  pagadoEl: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mediaAssetId: z.string().uuid().optional(),
});

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

  /**
   * «Ya pagué, aquí está el voucher».
   *
   * No registra un pago: registra una declaración. El operador la confirma y
   * entonces sí entra en el libro del dinero.
   */
  @Post('suscripcion/pagos-declarados')
  @HttpCode(201)
  declararPago(@Req() req: Req, @Body() body: unknown) {
    const r = Declaracion.safeParse(body);
    if (!r.success) {
      throw new ErrorDeNegocio(
        'datos_invalidos',
        r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; '),
        400,
      );
    }
    return conContextoDePeticion(req, () =>
      this.uso.declararPago({
        importeCentimos: r.data.importeCentimos,
        moneda: r.data.moneda,
        metodo: r.data.metodo,
        pagadoEl: r.data.pagadoEl,
        ...(r.data.referencia !== undefined ? { referencia: r.data.referencia } : {}),
        ...(r.data.mediaAssetId !== undefined ? { mediaAssetId: r.data.mediaAssetId } : {}),
      }),
    );
  }

  /** Por cuántos meses se contrata (0049). Un año se paga a once. */
  @Put('suscripcion/plazo')
  plazo(@Req() req: Req, @Body() body: unknown) {
    const r = z.object({ meses: z.number().int() }).safeParse(body);
    if (!r.success) throw new ErrorDeNegocio('datos_invalidos', 'Falta el plazo.', 400);
    return conContextoDePeticion(req, () => this.uso.cambiarPlazo(r.data.meses));
  }

  /** El QR de Yape o Plin de la plataforma, firmado (0048). */
  @Get('suscripcion/qr')
  qr(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.uso.qrDeCobro());
  }

  /** Consumo del mes en curso frente a los límites del plan. */
  @Get('uso')
  resumen(@Req() req: Req) {
    return conContextoDePeticion(req, () => this.uso.resumen());
  }
}
