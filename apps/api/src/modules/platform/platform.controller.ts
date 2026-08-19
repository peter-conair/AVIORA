import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  CurrentUser,
  RequirePlatformRoles,
  type AuthenticatedUser,
} from '../../common/auth/decorators';
import { ZodPipe } from '../../common/validation/zod.pipe';
import { ProvisioningService } from './provisioning.service';

const createTenantSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{3,40}$/),
  name: z.string().min(1).max(160),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  tenantType: z.string().max(60).optional(),
  defaultLanguage: z.enum(['th', 'en']).optional(),
  timezone: z.string().max(60).optional(),
  adminEmail: z.string().email(),
  adminDisplayName: z.string().min(1).max(120),
  adminPassword: z.string().min(10).max(200).optional(),
});

@RequirePlatformRoles('PLATFORM_OWNER', 'SUPER_ADMIN')
@Controller('platform/tenants')
export class PlatformController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Post()
  async create(
    @Body(new ZodPipe(createTenantSchema)) body: z.infer<typeof createTenantSchema>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { tenant, adminUserId, adminMemberId } = await this.provisioning.createTenant(
      body,
      user.userId,
    );
    return { tenant, adminUserId, adminMemberId };
  }

  @Get()
  async list() {
    return { tenants: await this.provisioning.listTenants() };
  }
}
