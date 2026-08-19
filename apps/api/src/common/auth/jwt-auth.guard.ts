import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { ERROR_CODES } from '@aviora/shared';
import { IS_PUBLIC, type AuthenticatedUser } from './decorators';

export const ACCESS_COOKIE = 'aviora_access';
export const CLS_USER_ID = 'userId';
export const CLS_PLATFORM_ROLE = 'platformRole';

interface AccessPayload {
  sub: string;
  email: string;
  prole: string | null;
  type: 'access';
}

/** Global authentication guard. Skips routes marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Authentication required',
      });
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessPayload>(token, {
        secret: process.env.AVIORA_JWT_ACCESS_SECRET,
      });
      if (payload.type !== 'access') throw new Error('wrong token type');
      req.user = { userId: payload.sub, email: payload.email, platformRole: payload.prole };
      this.cls.set(CLS_USER_ID, payload.sub);
      this.cls.set(CLS_PLATFORM_ROLE, payload.prole);
      return true;
    } catch {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Invalid or expired access token',
      });
    }
  }

  private extractToken(req: Request): string | null {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (cookie) return cookie;
    const header = req.header('authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7);
    return null;
  }
}
