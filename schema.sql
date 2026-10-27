-- Clean, complete schema for the 100% free football-data.org stack
-- (Also includes ALTER statements below if migrating an existing DB)

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    kick_id VARCHAR(64) UNIQUE NOT NULL,
    username VARCHAR(100) NOT NULL,
    avatar_url TEXT,
    total_points INT NOT NULL DEFAULT 0,
    exact_scores_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_leaderboard ON users (total_points DESC, exact_scores_count DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS matches (
    id BIGSERIAL PRIMARY KEY,
    external_id BIGINT UNIQUE NOT NULL,
    competition_code VARCHAR(20) NOT NULL,
    stage VARCHAR(64) NOT NULL DEFAULT 'REGULAR_SEASON',
    matchday INT,
    round_key VARCHAR(64) NOT NULL,
    home_team VARCHAR(150) NOT NULL,
    home_crest TEXT,
    away_team VARCHAR(150) NOT NULL,
    away_crest TEXT,
    utc_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL,
    home_score INT,
    away_score INT,
    ht_home_score INT,
    ht_away_score INT,
    home_goals_avg NUMERIC(4,2) NOT NULL DEFAULT 1.50,
    away_goals_avg NUMERIC(4,2) NOT NULL DEFAULT 1.20,
    markets_points JSONB,
    settled_outcomes JSONB,
    af_fixture_id BIGINT,
    odds_source VARCHAR(20),
    odds_updated_at TIMESTAMPTZ,
    points_calculated BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matches_comp_round ON matches (competition_code, round_key, utc_date);
CREATE INDEX IF NOT EXISTS idx_matches_unsettled ON matches (status, points_calculated)
  WHERE status = 'FINISHED' AND points_calculated = FALSE;

CREATE TABLE IF NOT EXISTS predictions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    predicted_outcome VARCHAR(10) NOT NULL CHECK (predicted_outcome IN ('HOME', 'DRAW', 'AWAY')),
    predicted_home INT NOT NULL CHECK (predicted_home >= 0 AND predicted_home <= 7),
    predicted_away INT NOT NULL CHECK (predicted_away >= 0 AND predicted_away <= 7),
    is_boosted BOOLEAN NOT NULL DEFAULT FALSE,
    outcome_points_locked INT NOT NULL DEFAULT 12,
    exact_points_locked INT NOT NULL DEFAULT 35,
    extras_picks JSONB NOT NULL DEFAULT '[]'::jsonb,
    points_awarded INT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, match_id),
    CONSTRAINT chk_max_3_extras CHECK (jsonb_array_length(extras_picks) <= 3)
);

CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions (match_id);

CREATE TABLE IF NOT EXISTS user_matchday_boosts (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    competition_code VARCHAR(20) NOT NULL,
    round_key VARCHAR(64) NOT NULL,
    matchday INT,
    boosts_used INT NOT NULL DEFAULT 0 CHECK (boosts_used >= 0),
    PRIMARY KEY (user_id, competition_code, round_key)
);

-- Safe migration statements if upgrading from earlier versions:
DROP TABLE IF EXISTS api_football_cache;

ALTER TABLE matches
  DROP COLUMN IF EXISTS api_football_fixture_id,
  DROP COLUMN IF EXISTS fixture_map_attempted,
  ALTER COLUMN matchday DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS stage VARCHAR(64) NOT NULL DEFAULT 'REGULAR_SEASON',
  ADD COLUMN IF NOT EXISTS round_key VARCHAR(64) NOT NULL DEFAULT 'MD-1',
  ADD COLUMN IF NOT EXISTS ht_home_score INT,
  ADD COLUMN IF NOT EXISTS ht_away_score INT,
  ADD COLUMN IF NOT EXISTS home_goals_avg NUMERIC(4,2) NOT NULL DEFAULT 1.50,
  ADD COLUMN IF NOT EXISTS away_goals_avg NUMERIC(4,2) NOT NULL DEFAULT 1.20,
  ADD COLUMN IF NOT EXISTS markets_points JSONB,
  ADD COLUMN IF NOT EXISTS settled_outcomes JSONB;

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS predicted_outcome VARCHAR(10) NOT NULL DEFAULT 'HOME'
    CHECK (predicted_outcome IN ('HOME', 'DRAW', 'AWAY')),
  ADD COLUMN IF NOT EXISTS outcome_points_locked INT NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS exact_points_locked INT NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS extras_picks JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Odds-based pricing (bookmaker odds via API-Football)
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS af_fixture_id BIGINT,
  ADD COLUMN IF NOT EXISTS odds_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS odds_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_matches_af_fixture ON matches (af_fixture_id) WHERE af_fixture_id IS NOT NULL;
