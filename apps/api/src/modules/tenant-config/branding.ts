import { z } from 'zod';

/**
 * Branding is DATA, never code (docs/29 §1, §7).
 *
 * A tenant supplies colours, a font NAME and plain-text copy. It does not
 * supply CSS and it does not supply HTML: a stylesheet is code, and a tenant
 * shipping code that runs in another member's browser is the same class of
 * problem as script injection. Everything below is an allow-list — anything
 * unrecognised is refused rather than escaped, because escaping is a promise
 * about a renderer this module cannot see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `hiddenFeatures` HIDES NAVIGATION AND NOTHING ELSE.
 *
 * It is not access control. A hidden feature's routes still answer normally,
 * and they MUST: the permission and entitlement guards are what refuse. Nothing
 * in this file is imported by a guard, and nothing may be — if branding could
 * deny a request, a tenant could "secure" a feature by removing a menu item,
 * and the first person to type the URL would find it wide open. Hiding is for
 * tidiness; refusing is for security; they live in different layers.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const HIDDEN_FEATURES_ARE_NAVIGATION_ONLY =
  'hiddenFeatures hides navigation only. Routes for a hidden feature still answer normally — permissions and entitlements are what refuse.';

/**
 * Font FAMILIES a tenant may choose, by name. Not a URL and not an @font-face
 * block: the browser bundle decides how a family is loaded, so the tenant is
 * choosing from a menu rather than pointing at a font server of their choosing.
 */
export const FONT_FAMILIES = [
  'system',
  'inter',
  'roboto',
  'lato',
  'open-sans',
  'source-sans-3',
  'ibm-plex-sans',
  'noto-sans',
  'noto-sans-thai',
  'sarabun',
  'prompt',
  'kanit',
  'merriweather',
  'playfair-display',
  'jetbrains-mono',
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** Colour token names — a CSS custom property name is derived from these, so they are constrained. */
const COLOR_TOKEN_RE = /^[a-z][a-zA-Z0-9]{0,30}$/;

/**
 * A colour VALUE, in the forms a colour picker actually emits. Deliberately
 * narrow: `var(--x)`, `url(...)`, `expression(...)` and anything else that can
 * reach outside a single colour are not colours and are refused.
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/;
const HSL_RE =
  /^hsla?\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?%\s*,\s*\d{1,3}(?:\.\d+)?%\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/;

export function isColorValue(value: string): boolean {
  return HEX_RE.test(value) || RGB_RE.test(value) || HSL_RE.test(value);
}

/**
 * Markup detection. `<` and `>` are refused outright rather than encoded: a
 * tenant's app name has no legitimate need for an angle bracket, and a rule a
 * reviewer can check in one glance is worth more than one that is merely
 * clever. Entity and scheme forms are refused too, so the check cannot be
 * walked around by spelling `<` a different way.
 */
const MARKUP_RE = /[<>]|&#?[a-zA-Z0-9]{2,8};|&#x?[0-9a-fA-F]+|javascript:|data:/i;

export function containsMarkup(value: string): boolean {
  return MARKUP_RE.test(value);
}

/** Plain text of a bounded length, refusing anything that looks like markup. */
export function plainText(max: number) {
  return z
    .string()
    .max(max)
    .refine((v) => !containsMarkup(v), {
      message: 'Markup is not accepted here — branding copy is plain text (docs/29 §7)',
    });
}

/** An image or link URL: http(s) only, so `javascript:` and `data:` never reach an href. */
export const httpUrl = z
  .string()
  .max(2048)
  .refine(
    (v) => {
      try {
        const url = new URL(v);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'Must be an http(s) URL' },
  );

export const colorsSchema = z
  .record(z.string(), z.string())
  .refine((rec) => Object.keys(rec).length <= 24, { message: 'At most 24 colour tokens' })
  .refine((rec) => Object.keys(rec).every((k) => COLOR_TOKEN_RE.test(k)), {
    message: 'Colour token names are lowerCamelCase identifiers',
  })
  .refine((rec) => Object.values(rec).every((v) => isColorValue(v)), {
    message: 'Each value must be a colour: #rgb, #rrggbb(aa), rgb()/rgba(), hsl()/hsla()',
  });

/**
 * Landing copy — a fixed shape of plain-text fields. A tenant that needs a
 * bespoke landing page can have one BUILT; it cannot inject one (docs/29 §7).
 */
export const landingSchema = z.object({
  headline: plainText(160).optional(),
  subheadline: plainText(320).optional(),
  ctaLabel: plainText(60).optional(),
  ctaHref: httpUrl.optional(),
  sections: z
    .array(z.object({ title: plainText(120), body: plainText(1200) }))
    .max(12)
    .optional(),
});

/** A navigation feature key, e.g. `commerce.catalog`. Shape only — see the note above. */
const featureKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/, 'Feature keys are dot-notation lowercase')
  .max(60);

export const brandingUpdateSchema = z
  .object({
    appName: plainText(80).nullable().optional(),
    logoUrl: httpUrl.nullable().optional(),
    colors: colorsSchema.nullable().optional(),
    // An administrator typing "Inter" instead of "inter" is not an attack, and
    // refusing them teaches nothing. The allow-list is still the allow-list;
    // only the reader is forgiving.
    fontFamily: z
      .string()
      .nullable()
      .optional()
      .transform((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
      .refine(
        (value) => value == null || (FONT_FAMILIES as readonly string[]).includes(value),
        (value) => ({
          message: `'${String(value)}' is not one of the fonts this platform serves: ${FONT_FAMILIES.join(', ')}`,
        }),
      ),
    landing: landingSchema.nullable().optional(),
    emailFromName: plainText(80).nullable().optional(),
    emailFooter: plainText(600).nullable().optional(),
    hiddenFeatures: z.array(featureKeySchema).max(60).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No branding fields to update' });

export type BrandingUpdate = z.infer<typeof brandingUpdateSchema>;
