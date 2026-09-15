/** Traduce los errores del dominio a códigos HTTP, sin filtrar detalles internos. */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  DomainError,
  ForbiddenError,
  InsufficientStockError,
  NotFoundError,
  PlanLimitError,
  TenantViolationError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return res.status(status).json(this.body(status, 'HTTP', exception.getResponse()));
    }

    if (exception instanceof DomainError) {
      const status = this.statusFor(exception);
      // `data` lleva el detalle estructurado (ej. los productos que faltan al reservar).
      return res.status(status).json(this.body(status, exception.code, exception.message, exception.data));
    }

    // Error no controlado: no exponemos el stack al cliente.
    // eslint-disable-next-line no-console
    console.error('Unhandled error:', exception);
    return res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(this.body(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL', 'Error interno'));
  }

  private statusFor(err: DomainError): number {
    if (err instanceof NotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof InsufficientStockError) return HttpStatus.CONFLICT;
    if (err instanceof UnauthorizedError) return HttpStatus.UNAUTHORIZED;
    if (err instanceof ForbiddenError) return HttpStatus.FORBIDDEN;
    if (err instanceof TenantViolationError) return HttpStatus.FORBIDDEN;
    if (err instanceof PlanLimitError) return HttpStatus.PAYMENT_REQUIRED;
    if (err instanceof ValidationError) return HttpStatus.UNPROCESSABLE_ENTITY;
    return HttpStatus.BAD_REQUEST;
  }

  private body(status: number, code: string, detail: unknown, data?: unknown) {
    return data === undefined ? { statusCode: status, code, detail } : { statusCode: status, code, detail, data };
  }
}
