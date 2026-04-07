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
  average_ms: number;
  week_start: string;
  created_at: string;
}

export async function submitScore(nickname: string, averageMs: number): Promise<LeaderboardEntry | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const weekStart = getWeekStart();

  // Check if player already has a better score this week
  const { data: existing } = await supabase
    .from('scores')
    .select('*')
    .eq('nickname', nickname)
    .eq('week_start', weekStart)
    .order('average_ms', { ascending: true })
    .limit(1);

  if (existing && existing.length > 0 && existing[0].average_ms <= averageMs) {
    return existing[0]; // Keep better score
  }

  if (existing && existing.length > 0) {
    // Update existing score
    const { data, error } = await supabase
      .from('scores')
      .update({ average_ms: averageMs })
      .eq('id', existing[0].id)
      .select()
      .single();
    if (error) return null;
    return data;
  }

  // Insert new score
  const { data, error } = await supabase
    .from('scores')
    .insert({ nickname, average_ms: averageMs, week_start: weekStart })
    .select()
    .single();
  if (error) return null;
  return data;
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const weekStart = getWeekStart();
  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('week_start', weekStart)
    .order('average_ms', { ascending: true })
    .limit(20);
  if (error) return [];
  return data || [];
}

/** Check current rank for a nickname. Returns null if not on board. */
export async function getCurrentRank(nickname: string): Promise<number | null> {
  const lb = await getLeaderboard();
  const idx = lb.findIndex(e => e.nickname === nickname);
  return idx >= 0 ? idx + 1 : null;
}

export interface OvertakeResult {
  /** New rank after submission */
  newRank: number | null;
  /** Old rank before submission (from leaderboard snapshot) */
  oldRank: number | null;
  /** Nickname of the player that was overtaken (rank directly above old position) */
  overtakenNick: string | null;
  /** Full leaderboard after submission */
  leaderboard: LeaderboardEntry[];
}

/** Submit score and return rich overtake info */
export async function submitScoreWithOvertake(
  nickname: string,
  averageMs: number
): Promise<OvertakeResult> {
  // Snapshot leaderboard BEFORE submission
  const before = await getLeaderboard();
  const oldRank = before.findIndex(e => e.nickname === nickname);

  await submitScore(nickname, averageMs);

  // Fetch fresh leaderboard AFTER submission
  const after = await getLeaderboard();
  const newIdx = after.findIndex(e => e.nickname === nickname);
  const newRank = newIdx >= 0 ? newIdx + 1 : null;

  // Who did we overtake? The player now directly above us in the new board,
  // if they weren't there before (or we moved up past them).
  let overtakenNick: string | null = null;
  if (newRank !== null && newIdx > 0) {
    const playerAbove = after[newIdx - 1];
    // They were below us (or absent) before → we overtook them
    const wasBeforeUs = before.findIndex(e => e.nickname === playerAbove.nickname);
    if (oldRank === -1 || wasBeforeUs > oldRank) {
      overtakenNick = playerAbove.nickname;
    }
  }

  return {
    newRank,
    oldRank: oldRank >= 0 ? oldRank + 1 : null,
    overtakenNick,
    leaderboard: after,
  };
}
