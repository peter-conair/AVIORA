/**
 * The platform's own name, as people see it: page headings, the installed-app
 * name, email subjects and signatures, alert prefixes and the assistant's
 * self-introduction. A tenant's white-label name (branding.service) overrides
 * it inside that tenant; this is what shows when no tenant name applies.
 *
 * Wire contracts keep the original identifier and do NOT follow this value:
 * the X-Aviora-* webhook headers, AVIORA_* env vars, the @aviora/* package
 * scope, the aviora_app DB role and the aviora.tenantId storage key. Renaming
 * those would break every integration and stored session already out there.
 */
export const BRAND = {
  name: 'AVIORA',
  shortName: 'AVIORA',
} as const;
