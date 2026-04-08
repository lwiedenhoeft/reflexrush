import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

export function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

export interface LeaderboardEntry {
  id: number;
  nickname: string;
  max_level: number;
  average_ms: number;
  week_start: string;
  created_at: string;
}

/** Submit score. Level is PRIMARY metric, average_ms is secondary (tiebreaker). */
export async function submitScore(
  nickname: string,
  maxLevel: number,
  averageMs: number
): Promise<LeaderboardEntry | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const weekStart = getWeekStart();

  const { data: existing } = await supabase
    .from('scores')
    .select('*')
    .eq('nickname', nickname)
    .eq('week_start', weekStart)
    .limit(1);

  if (existing && existing.length > 0) {
    const old = existing[0];
    // Keep existing if higher level, or same level with better (lower) time
    const existingBetter =
      old.max_level > maxLevel ||
      (old.max_level === maxLevel && old.average_ms <= averageMs);

    if (existingBetter) return old;

    // Update with new best
    const { data, error } = await supabase
      .from('scores')
      .update({ max_level: maxLevel, average_ms: averageMs })
      .eq('id', old.id)
      .select()
      .single();
    if (error) return null;
    return data;
  }

  const { data, error } = await supabase
    .from('scores')
    .insert({ nickname, max_level: maxLevel, average_ms: averageMs, week_start: weekStart })
    .select()
    .single();
  if (error) return null;
  return data;
}

/** Leaderboard sorted by level DESC (primary), then average_ms ASC (tiebreaker). */
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const weekStart = getWeekStart();
  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('week_start', weekStart)
    .order('max_level', { ascending: false })
    .order('average_ms', { ascending: true })
    .limit(20);
  if (error) return [];
  return data || [];
}

/** Check current rank for a nickname. */
export async function getCurrentRank(nickname: string): Promise<number | null> {
  const lb = await getLeaderboard();
  const idx = lb.findIndex(e => e.nickname === nickname);
  return idx >= 0 ? idx + 1 : null;
}

export interface OvertakeResult {
  newRank: number | null;
  oldRank: number | null;
  overtakenNick: string | null;
  leaderboard: LeaderboardEntry[];
}

export async function submitScoreWithOvertake(
  nickname: string,
  maxLevel: number,
  averageMs: number
): Promise<OvertakeResult> {
  const before = await getLeaderboard();
  const oldRank = before.findIndex(e => e.nickname === nickname);

  await submitScore(nickname, maxLevel, averageMs);

  const after = await getLeaderboard();
  const newIdx = after.findIndex(e => e.nickname === nickname);
  const newRank = newIdx >= 0 ? newIdx + 1 : null;

  let overtakenNick: string | null = null;
  if (newRank !== null && newIdx > 0) {
    const playerAbove = after[newIdx - 1];
    const wasBeforeUs = before.findIndex(e => e.nickname === playerAbove.nickname);
    if (oldRank === -1 || wasBeforeUs > oldRank) {
      overtakenNick = playerAbove.nickname;
    }
  }

  return { newRank, oldRank: oldRank >= 0 ? oldRank + 1 : null, overtakenNick, leaderboard: after };
}
