import { z } from 'zod';
import { isValidTimeZone } from '../../common/time/zone';

/**
 * Country, currency, timezone, language (docs/29 §2). One tenant, one of each.
 *
 * `timezone` is checked against the tz database rather than a regex: "GMT+7" and
 * "Bangkok" both look plausible and neither is a zone, and a zone that ICU
 * cannot resolve is a report that silently reports the wrong days.
 *
 * Country, currency and language get the same treatment for the same reason.
 * `ZZ`, `QQQ` and `zz` are all well-formed and none of them exist; a regex that
 * only counts letters would let a tenant trade in a currency nobody can pay in.
 * The check asks ICU — the runtime's own data — rather than a hand-kept list
 * that would start rotting the day it was written.
 */
function icuKnows(type: 'region' | 'currency' | 'language', code: string): boolean {
  try {
    const display = new Intl.DisplayNames(['en'], { type, fallback: 'code' }).of(code);
    if (typeof display !== 'string') return false;
    // ICU echoes the code back when it has no name for it — and for the
    // reserved "unknown" codes (ZZ, ZZZ, und) it helpfully names them as
    // unknown, which is exactly what a tenant must not be able to trade in.
    return display !== code && !/^unknown/i.test(display);
  } catch {
    return false;
  }
}
const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Locale is an ISO-639-1 code, optionally with a region')
  .refine((v) => icuKnows('language', v.slice(0, 2)), {
    message: 'That is not a language this platform can name',
  });

export const localisationUpdateSchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'Country is an ISO-3166-1 alpha-2 code')
      .transform((v) => v.toUpperCase())
      .refine((v) => icuKnows('region', v), {
        message: 'That is not a country this platform can name',
      }),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Currency is an ISO-4217 code')
      .refine((v) => icuKnows('currency', v), {
        message: 'That is not a currency this platform can name',
      })
      .optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, {
      message: 'Timezone must be an IANA zone name, e.g. Asia/Bangkok',
    }),
    defaultLocale: localeSchema,
    supportedLocales: z.array(localeSchema).min(1).max(20),
    addressFormat: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .refine((v) => v.supportedLocales.includes(v.defaultLocale), {
    message:
      'defaultLocale must be one of supportedLocales — a tenant cannot default to a language its switcher refuses to offer',
    path: ['defaultLocale'],
  });

export type LocalisationUpdate = z.infer<typeof localisationUpdateSchema>;
