-- ReflexRush Supabase Schema
-- Run this in the Supabase SQL Editor
--
-- PRIMARY success metric: max_level (higher = better)
-- SECONDARY tiebreaker: average_ms (lower = better)

CREATE TABLE scores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nickname TEXT NOT NULL,
  max_level INTEGER NOT NULL DEFAULT 1,
  average_ms INTEGER NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for leaderboard: level DESC, then ms ASC
CREATE INDEX idx_scores_week_leaderboard
  ON scores (week_start, max_level DESC, average_ms ASC);

CREATE INDEX idx_scores_nickname_week
  ON scores (nickname, week_start);

-- Row Level Security
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access"  ON scores FOR SELECT  USING (true);
CREATE POLICY "Public insert access" ON scores FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update access" ON scores FOR UPDATE USING (true);

-- If upgrading from old schema, run:
-- ALTER TABLE scores ADD COLUMN max_level INTEGER NOT NULL DEFAULT 1;
-- DROP INDEX IF EXISTS idx_scores_week_leaderboard;
-- CREATE INDEX idx_scores_week_leaderboard ON scores (week_start, max_level DESC, average_ms ASC);
