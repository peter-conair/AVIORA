import { z } from 'zod';

/**
 * What a second system may send into the GLOBAL knowledge catalogue
 * (docs/74 §1). Pure schema and normalisation; the writing lives in the service.
 */

/** How many products one request may carry. */
export const INGEST_BATCH_MAX = 100;

/**
 * The body limit for the ingest route.
 *
 * Express defaults to 100 KB, and a hundred products with a description and a
 * translation apiece is comfortably past it — so the route advertised a batch
 * size it could not actually accept, and answered a size it disliked with
 * "Internal server error". Raised HERE and nowhere else: a global ceiling this
 * size would be a denial-of-service surface bought to solve one route's problem
 * (the same reasoning app.factory applies to lesson uploads).
 */
export const INGEST_BODY_LIMIT = '2mb';

/**
 * Who is writing. Recorded on every row this creates, and checked against every
 * row it would update — a product curated here, or written by another system,
 * is refused rather than quietly rewritten (docs/74 §3).
 */
const sourceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,39}$/, 'A source names a system: lower-case, 3–40 characters');

/**
 * Codes are the natural key, and Postgres compares them byte for byte, so
 * `HANNA-HI98103` and `hanna-hi98103` would be two products with one meaning.
 * Everything that becomes a key is lower-cased on the way in, once, here —
 * rather than in each of the three places that look one up.
 */
const codeSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'A code carries no spaces')
  .transform((c) => c.toLowerCase());

/** Per-locale text. Names the locales the platform actually renders. */
const translationsSchema = z.record(
  z.enum(['th', 'en']),
  z.object({ name: z.string().max(300).optional(), description: z.string().max(2000).optional() }),
);

export const ingestProductSchema = z
  .object({
    /** The sender's SKU. */
    code: codeSchema,
    name: z.string().trim().min(1).max(300),
    brand: z.object({ code: codeSchema, name: z.string().trim().min(1).max(160) }),
    /** One or two sentences. The card shows this, not a page of marketing HTML. */
    description: z.string().max(2000).optional(),
    /** Where the sender got it. The card links here, so a member can check. */
    sourceUrl: z.string().url().max(2000).optional(),
    safetyNotes: z.string().max(2000).optional(),
    translations: translationsSchema.optional(),
    /**
     * Ingredient codes this product contains.
     *
     * OPTIONAL, and the reason it matters more than anything else in this
     * payload: a product reaches a member through an ingredient (docs/74 §5).
     * One with no links is findable by search and appears on no journey — so a
     * code this platform does not know is REPORTED rather than silently
     * dropped, and never fails the product.
     */
    ingredients: z.array(codeSchema).max(50).optional(),
    /**
     * Topic codes this product belongs to (docs/74 §6).
     *
     * The path for everything that is not a supplement. A water filter, an air
     * purifier and a pan contain no ingredient and would otherwise be reachable
     * from no goal at all, however plainly they belong to one. Same rules as
     * `ingredients`: omitted leaves existing links alone, present is the whole
     * truth, and a code this platform does not know is reported rather than
     * invented.
     */
    topics: z.array(codeSchema).max(20).optional(),
    /**
     * Pictures of the product (docs/74 §7).
     *
     * URLs at the sender's source, not bytes: this endpoint takes a catalogue,
     * not an upload. Whether AVIORA keeps its own copy is a separate decision
     * recorded per image in `stored_path`, and one this route does not make.
     */
    images: z
      .array(
        z
          .object({
            url: z.string().url().max(2000),
            /** What a screen reader says. Falls back to the product's name. */
            alt: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    status: z.enum(['active', 'archived']).default('active'),
  })
  .strict();

export const ingestRequestSchema = z
  .object({
    source: sourceSchema,
    products: z.array(ingestProductSchema).min(1).max(INGEST_BATCH_MAX),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Two rows for one code in one request is a mistake in the sender, and
    // silently letting the last one win hides it until the values differ.
    const seen = new Set<string>();
    body.products.forEach((p, i) => {
      if (seen.has(p.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['products', i, 'code'],
          message: `'${p.code}' appears twice in this request`,
        });
      }
      seen.add(p.code);
    });
  });

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
export type IngestProduct = z.infer<typeof ingestProductSchema>;

/** What happened to one product. */
export interface IngestItemResult {
  code: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'refused';
  /** Set only when refused — always a sentence, never a code to look up. */
  reason?: string;
  ingredientsLinked?: number;
  topicsLinked?: number;
  imagesLinked?: number;
  /** Codes this platform does not know. The product is still written. */
  unknownIngredients?: string[];
  unknownTopics?: string[];
}

export interface IngestResult {
  source: string;
  created: number;
  updated: number;
  unchanged: number;
  refused: number;
  results: IngestItemResult[];
}
