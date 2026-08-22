import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createAppClient,
  createOwnerClient,
  createPlatformClient,
  type PrismaClient,
} from '@aviora/db';

/**
 * Holds the two Prisma clients (docs/03 §4):
 * - `app`  — non-owner role, RLS enforced; use via withTenant() for tenant work
 * - `owner`— table owner; migrations/seed/platform module ONLY
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly app: PrismaClient = createAppClient();
  readonly owner: PrismaClient = createOwnerClient();
  /**
   * Cross-tenant reads (docs/53). NOT the owner: policies apply to it, and its
   * `platform_access` policy admits nothing unless the transaction declares
   * itself via `withPlatform`. Use this for platform VIEWS; the owner stays for
   * DDL, seeding and the platform-scope tables that have no policy to be
   * exempt from.
   */
  readonly platform: PrismaClient = createPlatformClient();

  async onModuleInit() {
    await this.app.$connect();
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.app.$disconnect(),
      this.owner.$disconnect(),
      this.platform.$disconnect(),
    ]);
  }
}
