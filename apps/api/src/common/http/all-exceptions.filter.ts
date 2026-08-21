import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@aviora/shared';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';
import { CLS_USER_ID } from '../auth/jwt-auth.guard';

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
    const req = host.switchToHttp().getRequest<Request | undefined>();
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

    // docs/36 §3. Every error the caller sees gets a log line carrying the
    // SAME request_id the body carries, so a support ticket quoting it finds
    // something. 5xx is ours and needs the stack; 4xx is the caller's and a
    // stack there is noise that buries the 5xx beside it.
    const where = `${req?.method ?? '?'} ${req?.originalUrl ?? req?.url ?? '?'}`;
    const context =
      `${where} → ${status} ${code} (request_id=${requestId}` +
      `${this.safe(CLS_TENANT_ID) ? `, tenant_id=${this.safe(CLS_TENANT_ID)}` : ''}` +
      `${this.safe(CLS_USER_ID) ? `, user_id=${this.safe(CLS_USER_ID)}` : ''})`;
    if (status >= 500) {
      this.logger.error(
        `Unhandled exception ${context}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(context);
    }

    const payload: ApiErrorBody = {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        request_id: requestId,
      },
    };
    // Also set here, not only in the interceptor: a request refused by a GUARD
    // never reaches an interceptor, and those are precisely the responses a
    // caller opens a ticket about. The id in the header and the id in the body
    // must be the same one on every path that can fail.
    if (!res.headersSent) res.setHeader('X-Request-Id', requestId);
    res.status(status).json(payload);
  }

  /** CLS is not available for an error thrown outside a request. */
  private safe(key: string): string | undefined {
    try {
      return this.cls.get<string | undefined>(key);
    } catch {
      return undefined;
    }
  }

  private safeRequestId(): string {
    try {
      return this.cls.getId() ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
