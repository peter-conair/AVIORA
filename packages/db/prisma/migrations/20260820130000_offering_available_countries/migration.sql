-- docs/29 §5: product availability by country.
--
-- The white-label migration added tax, branding, localisation and legal, but
-- not this column, and §5 cannot be enforced without somewhere to keep it.
-- Additive and defaulted: every existing offering keeps an EMPTY array, which
-- means "available everywhere", so no catalogue changes meaning here.
ALTER TABLE "offerings"
  ADD COLUMN "available_countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
