import { Injectable, Logger } from '@nestjs/common';
import { buildSearchText, Prisma, type Tx } from '@aviora/db';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/db/prisma.service';
import type {
  IngestItemResult,
  IngestProduct,
  IngestRequest,
  IngestResult,
} from './catalog-ingest';

/**
 * Writing the GLOBAL knowledge catalogue from another system (docs/74).
 *
 * Two things about this file are deliberate and worth reading before changing it.
 *
 * 1. It writes through the OWNER client. Global knowledge is `tenant_id NULL`,
 *    and the layered RLS policy on these tables reads global rows for everyone
 *    but WRITES only within the caller's tenant — on purpose, so no tenant can
 *    edit what every tenant reads. This surface is the one exception, reached
 *    only by a platform key, and it is exactly as narrow as that: brands,
 *    products, and the links that reach them — to ingredients, and (docs/74 §6)
 *    to topics. It creates no ingredient, no topic and no article, because a
 *    sender that could invent ingredients could invent the claims attached to
 *    them, and one that could invent topics could reorganise a member's
 *    knowledge from outside.
 *
 * 2. It refuses more than it rewrites. A product row records which system owns
 *    it, and a row owned by somebody else — including the seed, which owns
 *    nothing and therefore matches nobody — is reported back untouched. The
 *    alternative is two writers taking turns on one code, which reads as
 *    working right up until the day a curated safety note vanishes.
 */
@Injectable()
export class CatalogIngestService {
  private readonly logger = new Logger(CatalogIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async ingest(body: IngestRequest, keyName: string): Promise<IngestResult> {
    const results: IngestItemResult[] = [];
    for (const product of body.products) {
      // One transaction per PRODUCT, not per request: a batch of a hundred in
      // which one row is refused should write the other ninety-nine. A caller
      // fixing one SKU must not have to resend the batch to get the rest back.
      results.push(
        await this.prisma.owner
          .$transaction((tx) => this.upsertProduct(tx as Tx, product, body.source))
          .catch((e: unknown) => {
            // A failure here is this platform's, not the sender's. Name the
            // product so the sender can retry it alone, and log the cause where
            // an operator will find it rather than putting it in the response.
            this.logger.error(`ingest failed for ${product.code}`, e as Error);
            return {
              code: product.code,
              outcome: 'refused' as const,
              reason: 'This product could not be written; the failure is recorded here',
            };
          }),
      );
    }

    const count = (outcome: IngestItemResult['outcome']) =>
      results.filter((r) => r.outcome === outcome).length;
    const summary: IngestResult = {
      source: body.source,
      created: count('created'),
      updated: count('updated'),
      unchanged: count('unchanged'),
      refused: count('refused'),
      results,
    };

    // ONE row per request, carrying the counts — not one per product. A sync of
    // a hundred products would otherwise bury the sensitive entries this log
    // exists for under its own routine traffic, which is the failure mode the
    // unaudited list elsewhere in this codebase keeps arguing about.
    await this.audit.record({
      tenantId: null,
      action: 'platform.catalog.ingest',
      entityType: 'product',
      after: {
        source: body.source,
        key: keyName,
        received: body.products.length,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        refused: summary.refused,
        refusedCodes: results.filter((r) => r.outcome === 'refused').map((r) => r.code),
      },
    });

    return summary;
  }

  private async upsertProduct(
    tx: Tx,
    input: IngestProduct,
    source: string,
  ): Promise<IngestItemResult> {
    const existing = await tx.product.findFirst({ where: { tenantId: null, code: input.code } });

    if (existing && existing.source !== source) {
      return {
        code: input.code,
        outcome: 'refused',
        reason: existing.source
          ? `This code already belongs to '${existing.source}'`
          : 'This code is curated in AVIORA and is not written by an ingest',
      };
    }

    const brandId = await this.upsertBrand(tx, input.brand);
    const searchText = buildSearchText([input.name, input.description], input.translations);
    const data = {
      brandId,
      name: input.name,
      description: input.description ?? null,
      sourceUrl: input.sourceUrl ?? null,
      safetyNotes: input.safetyNotes ?? null,
      // DbNull, not null: for a nullable Json column Prisma reads a bare `null`
      // as "the JSON value null" and refuses it here. DbNull is the SQL NULL
      // the column actually holds when a product carries no translations.
      translations: input.translations ?? Prisma.DbNull,
      status: input.status,
      searchText,
      source,
    };

    let productId: string;
    let changed: boolean;
    if (existing) {
      // `last_verified_at` moves on every sync, so it is not part of what
      // "changed" means — otherwise every product would report as updated and
      // the count would tell the sender nothing.
      changed =
        existing.brandId !== data.brandId ||
        existing.name !== data.name ||
        existing.description !== data.description ||
        existing.sourceUrl !== data.sourceUrl ||
        existing.safetyNotes !== data.safetyNotes ||
        existing.status !== data.status ||
        existing.searchText !== data.searchText ||
        JSON.stringify(existing.translations ?? null) !==
          JSON.stringify(input.translations ?? null);
      await tx.product.update({
        where: { id: existing.id },
        data: { ...data, lastVerifiedAt: new Date() },
      });
      productId = existing.id;
    } else {
      const row = await tx.product.create({
        data: { ...data, code: input.code, lastVerifiedAt: new Date() },
      });
      productId = row.id;
      changed = true;
    }

    const links = await this.syncIngredients(tx, productId, input.ingredients);
    const topics = await this.syncTopics(tx, productId, input.topics);
    const images = await this.syncImages(tx, productId, input.images);

    return {
      code: input.code,
      outcome: existing
        ? changed || links.changed || topics.changed || images.changed
          ? 'updated'
          : 'unchanged'
        : 'created',
      ingredientsLinked: links.linked,
      topicsLinked: topics.linked,
      imagesLinked: images.linked,
      ...(links.unknown.length > 0 ? { unknownIngredients: links.unknown } : {}),
      ...(topics.unknown.length > 0 ? { unknownTopics: topics.unknown } : {}),
    };
  }

  /**
   * Pictures of the product (docs/74 §7).
   *
   * Stores the URL the sender gave, and NOT the bytes behind it: mirroring is a
   * separate decision with its own cost and its own permission, and the row
   * says which it is holding via `storedPath`. An existing row's `storedPath`
   * is preserved across a sync — re-sending a catalogue must not silently
   * discard a copy somebody paid to make.
   *
   * Same omitted-vs-present rule as everything else here.
   */
  private async syncImages(
    tx: Tx,
    productId: string,
    images: Array<{ url: string; alt?: string }> | undefined,
  ): Promise<{ linked: number; changed: boolean }> {
    const current = await tx.productImage.findMany({
      where: { productId },
      select: { id: true, url: true, alt: true, position: true },
    });
    if (images === undefined) return { linked: current.length, changed: false };

    // The sender's ORDER is the order: it is the order on their own page, and
    // the first picture is the one that stands for the product.
    const wanted = new Map(images.map((img, position) => [img.url, { ...img, position }]));
    const held = new Map(current.map((row) => [row.url, row]));

    const toRemove = current.filter((row) => !wanted.has(row.url));
    if (toRemove.length > 0) {
      await tx.productImage.deleteMany({ where: { id: { in: toRemove.map((r) => r.id) } } });
    }

    let changed = toRemove.length > 0;
    for (const [url, img] of wanted) {
      const existing = held.get(url);
      if (!existing) {
        await tx.productImage.create({
          data: { productId, url, alt: img.alt ?? null, position: img.position },
        });
        changed = true;
        continue;
      }
      if (existing.alt !== (img.alt ?? null) || existing.position !== img.position) {
        await tx.productImage.update({
          where: { id: existing.id },
          data: { alt: img.alt ?? null, position: img.position },
        });
        changed = true;
      }
    }

    return { linked: wanted.size, changed };
  }

  /**
   * The path for a product that contains nothing (docs/74 §6).
   *
   * Deliberately the same shape as `syncIngredients`, down to the omitted-vs-
   * present rule, because a sender should not have to learn two conventions for
   * what is the same act. Topics are never CREATED here either: a topic is a
   * heading a member navigates by, and a catalogue that could invent headings
   * could reorganise somebody else's knowledge.
   */
  private async syncTopics(
    tx: Tx,
    productId: string,
    codes: string[] | undefined,
  ): Promise<{ linked: number; unknown: string[]; changed: boolean }> {
    const current = await tx.productTopic.findMany({
      where: { productId },
      select: { topicId: true },
    });
    if (codes === undefined) return { linked: current.length, unknown: [], changed: false };

    const known = await tx.topic.findMany({
      where: { tenantId: null, code: { in: codes } },
      select: { id: true, code: true },
    });
    const knownCodes = new Set(known.map((t) => t.code));
    const unknown = codes.filter((c) => !knownCodes.has(c));

    const wanted = new Set(known.map((t) => t.id));
    const held = new Set(current.map((l) => l.topicId));
    const toAdd = [...wanted].filter((id) => !held.has(id));
    const toRemove = [...held].filter((id) => !wanted.has(id));

    if (toAdd.length > 0) {
      await tx.productTopic.createMany({
        data: toAdd.map((topicId) => ({ productId, topicId })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await tx.productTopic.deleteMany({ where: { productId, topicId: { in: toRemove } } });
    }

    return { linked: wanted.size, unknown, changed: toAdd.length > 0 || toRemove.length > 0 };
  }

  /** Brands are data, never code (docs/31): a new brand is a row, not a deploy. */
  private async upsertBrand(tx: Tx, brand: IngestProduct['brand']): Promise<string> {
    const existing = await tx.brand.findFirst({ where: { tenantId: null, code: brand.code } });
    if (existing) {
      if (existing.name !== brand.name) {
        await tx.brand.update({ where: { id: existing.id }, data: { name: brand.name } });
      }
      return existing.id;
    }
    const row = await tx.brand.create({ data: { code: brand.code, name: brand.name } });
    return row.id;
  }

  /**
   * The links that make a product reachable (docs/74 §5).
   *
   * An OMITTED `ingredients` leaves the existing links alone; a PRESENT one is
   * the whole truth and links not in it are removed. Those are different
   * intentions — "I am not saying anything about ingredients" and "these are
   * the ingredients" — and a sender that could only ever add would have no way
   * to correct a mistake.
   *
   * Ingredient codes are never CREATED here. An ingredient carries claims about
   * what it does to a body; a sender that could invent one could invent those.
   */
  private async syncIngredients(
    tx: Tx,
    productId: string,
    codes: string[] | undefined,
  ): Promise<{ linked: number; unknown: string[]; changed: boolean }> {
    const current = await tx.productIngredient.findMany({
      where: { productId },
      select: { ingredientId: true },
    });
    if (codes === undefined) return { linked: current.length, unknown: [], changed: false };

    const known = await tx.ingredient.findMany({
      where: { tenantId: null, code: { in: codes } },
      select: { id: true, code: true },
    });
    const knownCodes = new Set(known.map((i) => i.code));
    const unknown = codes.filter((c) => !knownCodes.has(c));

    const wanted = new Set(known.map((i) => i.id));
    const held = new Set(current.map((l) => l.ingredientId));
    const toAdd = [...wanted].filter((id) => !held.has(id));
    const toRemove = [...held].filter((id) => !wanted.has(id));

    if (toAdd.length > 0) {
      await tx.productIngredient.createMany({
        data: toAdd.map((ingredientId) => ({ productId, ingredientId })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await tx.productIngredient.deleteMany({
        where: { productId, ingredientId: { in: toRemove } },
      });
    }

    return {
      linked: wanted.size,
      unknown,
      changed: toAdd.length > 0 || toRemove.length > 0,
    };
  }
}
