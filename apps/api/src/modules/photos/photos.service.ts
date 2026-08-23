import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, newId } from '@aviora/shared';
import type { Tx } from '@aviora/db';
import { TenantDb } from '../../common/db/tenant-db.service';
import { AuditService } from '../../common/audit/audit.service';
import { STORAGE_PORT, type StoragePort } from '../../common/storage/storage.port';
import type { TeamActor } from '../team/team-scope.service';
import { CrmScopeService } from '../crm/crm-scope.service';

export const PHOTO_CONSENT = 'progress_photo';
/** Roughly a phone photo. Bigger than this is a mistake, not a picture. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Before/after photographs (docs/65).
 *
 * Two rules hold this together and both are enforced here rather than trusted:
 *
 * 1. **No photograph exists without a live consent.** Not "was consented at the
 *    time" — live, checked on every write.
 * 2. **Withdrawing consent deletes the photographs**, bytes included. Hiding
 *    them would leave the customer's picture in a bucket belonging to somebody
 *    they have told to stop, which is not what withdrawing consent means.
 */
@Injectable()
export class PhotosService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly scope: CrmScopeService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private requireMember(actor: TeamActor): string {
    if (!actor.memberId) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'You are not a member of this tenant',
      });
    }
    return actor.memberId;
  }

  /** The customer must be in the caller's own book, as everywhere else in CRM. */
  private async reachableCustomer(
    tx: Tx,
    actor: TeamActor,
    customerId: string,
    permission: string,
  ) {
    const customer = await tx.customer.findFirst({ where: { id: customerId } });
    if (!customer) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Customer not found' });
    }
    const owners = await this.scope.ownerMemberIds(tx, actor, permission);
    if (!this.scope.canAccess(owners, customer.ownerMemberId)) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Customer not found' });
    }
    return customer;
  }

  async recordConsent(actor: TeamActor, customerId: string, note: string | null) {
    const memberId = this.requireMember(actor);
    const consent = await this.db.tx(async (tx) => {
      await this.reachableCustomer(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      return tx.customerConsent.upsert({
        where: { customerId_purpose: { customerId, purpose: PHOTO_CONSENT } },
        create: {
          tenantId: this.db.tenantId,
          customerId,
          purpose: PHOTO_CONSENT,
          recordedByMemberId: memberId,
          note,
        },
        // Re-consenting after a withdrawal reopens the same row, so the story
        // of the decision stays in one place rather than in a pile of rows.
        update: { grantedAt: new Date(), revokedAt: null, recordedByMemberId: memberId, note },
      });
    });
    await this.audit.record({
      action: 'crm.consent.grant',
      entityType: 'customer_consent',
      entityId: consent.id,
      after: { customerId, purpose: PHOTO_CONSENT },
    });
    return consent;
  }

  /**
   * Withdraw consent, and destroy what it permitted.
   *
   * The consent row is kept — the record of what was agreed and when it ended
   * is exactly what a customer might later need. The photographs are not.
   */
  async revokeConsent(actor: TeamActor, customerId: string) {
    const result = await this.db.tx(async (tx) => {
      await this.reachableCustomer(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      const photos = await tx.progressPhoto.findMany({ where: { customerId } });
      await tx.progressPhoto.deleteMany({ where: { customerId } });
      const consent = await tx.customerConsent.updateMany({
        where: { customerId, purpose: PHOTO_CONSENT, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { photos, revoked: consent.count };
    });

    // Outside the transaction on purpose: a storage delete that fails must not
    // roll back the withdrawal. The rows are already gone, so the objects are
    // unreachable either way, and an orphan in a bucket is a smaller problem
    // than a consent that did not take.
    for (const photo of result.photos) {
      await this.storage.delete(photo.storageKey).catch(() => undefined);
    }

    await this.audit.record({
      action: 'crm.consent.revoke',
      entityType: 'customer_consent',
      entityId: customerId,
      after: { purpose: PHOTO_CONSENT, photosDeleted: result.photos.length },
    });
    return { revoked: result.revoked > 0, photosDeleted: result.photos.length };
  }

  async consentFor(actor: TeamActor, customerId: string) {
    return this.db.tx(async (tx) => {
      await this.reachableCustomer(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_VIEW);
      const consent = await tx.customerConsent.findFirst({
        where: { customerId, purpose: PHOTO_CONSENT },
      });
      return {
        purpose: PHOTO_CONSENT,
        granted: !!consent && consent.revokedAt === null,
        grantedAt: consent?.grantedAt ?? null,
        revokedAt: consent?.revokedAt ?? null,
        note: consent?.note ?? null,
      };
    });
  }

  async upload(
    actor: TeamActor,
    customerId: string,
    input: { stepKey: string; contentType: string; dataBase64: string },
  ) {
    const memberId = this.requireMember(actor);
    if (!ALLOWED_TYPES.has(input.contentType)) {
      throw new ForbiddenException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `Unsupported image type: ${input.contentType}`,
      });
    }
    const body = Buffer.from(input.dataBase64, 'base64');
    if (body.byteLength === 0 || body.byteLength > MAX_PHOTO_BYTES) {
      throw new ForbiddenException({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: `A photo must be between 1 byte and ${MAX_PHOTO_BYTES} bytes`,
      });
    }

    const photo = await this.db.tx(async (tx) => {
      await this.reachableCustomer(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      const consent = await tx.customerConsent.findFirst({
        where: { customerId, purpose: PHOTO_CONSENT, revokedAt: null },
      });
      if (!consent) {
        // Checked live, on every upload. "They consented last month" is not a
        // fact about now.
        throw new ForbiddenException({
          code: ERROR_CODES.FORBIDDEN,
          message: 'This customer has not consented to progress photos',
        });
      }
      const storageKey = `tenants/${this.db.tenantId}/customers/${customerId}/${newId()}`;
      await this.storage.put({ key: storageKey, body, contentType: input.contentType });
      return tx.progressPhoto.create({
        data: {
          tenantId: this.db.tenantId,
          customerId,
          stepKey: input.stepKey,
          storageKey,
          contentType: input.contentType,
          byteSize: body.byteLength,
          uploadedByMemberId: memberId,
        },
      });
    });

    await this.audit.record({
      action: 'crm.photo.upload',
      entityType: 'progress_photo',
      entityId: photo.id,
      after: { customerId, stepKey: photo.stepKey, byteSize: photo.byteSize },
    });
    return photo;
  }

  async list(actor: TeamActor, customerId: string) {
    return this.db.tx(async (tx) => {
      await this.reachableCustomer(tx, actor, customerId, PERMISSIONS.CRM_CUSTOMER_VIEW);
      const photos = await tx.progressPhoto.findMany({
        where: { customerId },
        orderBy: { takenAt: 'asc' },
        // The key never leaves the server: it is the only thing that would let
        // somebody fetch the bytes without coming back through this API.
        select: {
          id: true,
          stepKey: true,
          takenAt: true,
          contentType: true,
          byteSize: true,
        },
      });
      return { photos };
    });
  }

  /** The bytes, for a caller who may see this customer. */
  async content(actor: TeamActor, photoId: string) {
    const photo = await this.db.tx(async (tx) => {
      const found = await tx.progressPhoto.findFirst({ where: { id: photoId } });
      if (!found) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Photo not found' });
      }
      await this.reachableCustomer(tx, actor, found.customerId, PERMISSIONS.CRM_CUSTOMER_VIEW);
      return found;
    });
    const object = await this.storage.get(photo.storageKey);
    if (!object) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Photo not found' });
    }
    return object;
  }

  async remove(actor: TeamActor, photoId: string) {
    const photo = await this.db.tx(async (tx) => {
      const found = await tx.progressPhoto.findFirst({ where: { id: photoId } });
      if (!found) {
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Photo not found' });
      }
      await this.reachableCustomer(tx, actor, found.customerId, PERMISSIONS.CRM_CUSTOMER_MANAGE);
      await tx.progressPhoto.delete({ where: { id: photoId } });
      return found;
    });
    await this.storage.delete(photo.storageKey).catch(() => undefined);
    await this.audit.record({
      action: 'crm.photo.delete',
      entityType: 'progress_photo',
      entityId: photoId,
      before: { customerId: photo.customerId, stepKey: photo.stepKey },
    });
    return { deleted: true };
  }
}
