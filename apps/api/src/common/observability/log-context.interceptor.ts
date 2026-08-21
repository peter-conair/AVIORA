import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { CLS_TENANT_ID } from '../tenant/tenant-context.middleware';
import { CLS_USER_ID } from '../auth/jwt-auth.guard';
import { CLS_MEMBER_ID } from '../auth/permissions.guard';

interface BindableLog {
  setBindings?: (bindings: Record<string, unknown>) => void;
}

/**
 * Puts the request's identity on every log line it produces (docs/36 §2).
 *
 * Interceptors run AFTER the guards, which is the whole point: by here the
 * tenant has been resolved and the token has been proved, so what is logged is
 * what the platform concluded rather than what the caller claimed in
 * `x-tenant-id`. A request rejected before this point logs no tenant, which is
 * the honest record — it never had one.
 */
@Injectable()
export class LogContextInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { log?: BindableLog }>();
    const res = http.getResponse<Response>();

    const requestId = this.cls.getId() ?? undefined;
    const bindings: Record<string, unknown> = {};
    if (requestId) bindings['request_id'] = requestId;
    const tenantId = this.cls.get<string | undefined>(CLS_TENANT_ID);
    if (tenantId) bindings['tenant_id'] = tenantId;
    const userId = this.cls.get<string | undefined>(CLS_USER_ID);
    if (userId) bindings['user_id'] = userId;
    const memberId = this.cls.get<string | undefined>(CLS_MEMBER_ID);
    if (memberId) bindings['member_id'] = memberId;

    req.log?.setBindings?.(bindings);
    // Echoed so a caller holding a support ticket and we holding a log line
    // are talking about the same request.
    if (requestId && !res.headersSent) res.setHeader('X-Request-Id', requestId);

    return next.handle();
  }
}
