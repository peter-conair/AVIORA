import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@aviora/shared';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  429: ERROR_CODES.RATE_LIMITED,
};

/**
 * Every error leaves the API in the standard envelope (docs/10 §errors):
 *   { "error": { "code", "message", "details?", "request_id" } }
 * Internal messages/stacks are never exposed on 5xx.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly cls: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = this.safeRequestId();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = ERROR_CODES.INTERNAL;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        code = (b['code'] as ErrorCode) ?? STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL;
        message = (b['message'] as string) ?? exception.message;
        details = b['details'] ?? (Array.isArray(b['message']) ? b['message'] : undefined);
      } else {
        code = STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL;
        message = typeof body === 'string' ? body : exception.message;
      }
    }

    if (status >= 500) {
      this.logger.error(
        `Unhandled exception (request_id=${requestId})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const payload: ApiErrorBody = {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        request_id: requestId,
      },
    };
    res.status(status).json(payload);
  }

  private safeRequestId(): string {
    try {
      return this.cls.getId() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
