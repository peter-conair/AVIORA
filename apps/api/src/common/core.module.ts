import { Global, Module } from '@nestjs/common';
import { PrismaService } from './db/prisma.service';
import { TenantDb } from './db/tenant-db.service';
import { TenantDatabaseResolver } from './db/tenant-database.resolver';
import { AuditService } from './audit/audit.service';
import { AuthThrottleService } from './auth/auth-throttle.service';

/**
 * Infrastructure every feature module needs. Global because PrismaService owns
 * the two connection pools: a second instance would be a second pool, so it
 * must be shared rather than re-provided per module.
 */
@Global()
@Module({
  providers: [PrismaService, TenantDb, TenantDatabaseResolver, AuditService, AuthThrottleService],
  exports: [PrismaService, TenantDb, TenantDatabaseResolver, AuditService, AuthThrottleService],
})
export class CoreModule {}
