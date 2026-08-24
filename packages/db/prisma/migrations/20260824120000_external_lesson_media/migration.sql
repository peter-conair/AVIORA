-- Lesson media that lives somewhere else (docs/74).
--
-- Until now every asset was ours: bytes in our bucket, served through our API,
-- with the release check in front of them. A YouTube video is not that, and the
-- column below exists so the difference is a fact in the row rather than
-- something each reader infers. What it costs is written down in docs/74 §2 —
-- an unlisted link works for anyone who has it, so for `youtube` assets the
-- release rules are advice and not enforcement.

ALTER TABLE lesson_assets
  ADD COLUMN IF NOT EXISTS provider    text NOT NULL DEFAULT 'storage',
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE lesson_assets ALTER COLUMN storage_key  DROP NOT NULL;
ALTER TABLE lesson_assets ALTER COLUMN content_type DROP NOT NULL;
ALTER TABLE lesson_assets ALTER COLUMN byte_size    DROP NOT NULL;

ALTER TABLE lesson_assets
  ADD CONSTRAINT lesson_assets_provider_check
  CHECK (provider IN ('storage', 'youtube'));

-- The columns each provider requires, enforced here rather than only in the
-- service. A `storage` row with no key is a lesson that looks playable and is
-- not; a `youtube` row with a storage key is a claim to own bytes we do not.
ALTER TABLE lesson_assets
  ADD CONSTRAINT lesson_assets_provider_columns_check
  CHECK (
    (provider = 'storage'
      AND storage_key IS NOT NULL
      AND content_type IS NOT NULL
      AND byte_size IS NOT NULL
      AND external_id IS NULL)
    OR
    (provider = 'youtube'
      AND external_id IS NOT NULL
      AND storage_key IS NULL
      AND byte_size IS NULL)
  );

-- Eleven characters from YouTube's own alphabet. Refusing a URL here is the
-- point: somebody pasting `watch?v=abc&list=PL…` would put the whole playlist
-- in a column read by a template.
ALTER TABLE lesson_assets
  ADD CONSTRAINT lesson_assets_external_id_shape_check
  CHECK (external_id IS NULL OR external_id ~ '^[A-Za-z0-9_-]{11}$');
