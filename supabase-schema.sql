-- ReflexRush Supabase Schema
-- Run this in the Supabase SQL Editor

-- Scores table
CREATE TABLE scores (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nickname TEXT NOT NULL,
  average_ms INTEGER NOT NULL,
  week_start DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast leaderboard queries
CREATE INDEX idx_scores_week_leaderboard
  ON scores (week_start, average_ms ASC);

-- Index for checking existing player scores
CREATE INDEX idx_scores_nickname_week
  ON scores (nickname, week_start);

-- Row Level Security
ALTER TABLE scores ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read scores (public leaderboard)
CREATE POLICY "Public read access"
  ON scores FOR SELECT
  USING (true);

-- Allow anyone to insert scores (anonymous play)
CREATE POLICY "Public insert access"
  ON scores FOR INSERT
  WITH CHECK (true);

-- Allow updates (for personal best updates)
CREATE POLICY "Public update access"
  ON scores FOR UPDATE
  USING (true);
