import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createAppClient, createOwnerClient, type PrismaClient } from '@aviora/db';

/**
 * Holds the two Prisma clients (docs/03 §4):
 * - `app`  — non-owner role, RLS enforced; use via withTenant() for tenant work
 * - `owner`— table owner; migrations/seed/platform module ONLY
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly app: PrismaClient = createAppClient();
  readonly owner: PrismaClient = createOwnerClient();

  async onModuleInit() {
    await this.app.$connect();
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.app.$disconnect(), this.owner.$disconnect()]);
  }
}
