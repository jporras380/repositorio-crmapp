import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ErrorDeNegocio } from './auth/auth.service.js';
import { SinContextoDeInquilino } from './db.js';

/**
 * Traduce errores a respuestas HTTP.
 *
 * Todo lo que no sea un error de negocio conocido sale como 500 con un mensaje
 * generico: el detalle va al log, no al cliente. Un mensaje de PostgreSQL
 * devuelto tal cual filtra nombres de tabla y de columna.
 */
@Catch()
export class FiltroDeErrores implements ExceptionFilter {
  constructor(private readonly onError?: (e: unknown) => void) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();

    if (error instanceof ErrorDeNegocio) {
      res.status(error.httpStatus).json({ codigo: error.codigo, mensaje: error.message });
      return;
    }
    if (error instanceof SinContextoDeInquilino) {
      // Es un bug nuestro, no del cliente: una ruta sin guard.
      this.onError?.(error);
      res.status(500).json({ codigo: 'error_interno', mensaje: 'Error interno.' });
      return;
    }
    if (error instanceof HttpException) {
      res.status(error.getStatus()).json({ codigo: 'http', mensaje: error.message });
      return;
    }

    this.onError?.(error);
    res.status(500).json({ codigo: 'error_interno', mensaje: 'Error interno.' });
  }
}
