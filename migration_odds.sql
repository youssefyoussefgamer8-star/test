-- Run once on your existing database
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS af_fixture_id BIGINT,
  ADD COLUMN IF NOT EXISTS odds_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS odds_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_matches_af_fixture ON matches (af_fixture_id) WHERE af_fixture_id IS NOT NULL;
