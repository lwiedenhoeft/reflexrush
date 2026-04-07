// ─── LIGA SYSTEM ────────────────────────────────────────
// Tiers based on average reaction time (ms).
// Lower is better. Easy to adjust thresholds.

export interface League {
  name: string;
  minMs: number;   // inclusive lower bound (or 0 for top tier)
  maxMs: number;   // exclusive upper bound (or Infinity for bottom tier)
  color: string;
  nextName: string | null;
  nextMaxMs: number | null;
  rank: number;    // 1 = best
}

export const LEAGUES: League[] = [
  { rank: 1, name: 'PRO',    minMs: 0,   maxMs: 180,      color: '#ffd700', nextName: null,     nextMaxMs: null },
  { rank: 2, name: 'GOLD',   minMs: 180, maxMs: 220,      color: '#c0c0c0', nextName: 'PRO',    nextMaxMs: 180  },
  { rank: 3, name: 'SILBER', minMs: 220, maxMs: 300,      color: '#4fc3f7', nextName: 'GOLD',   nextMaxMs: 220  },
  { rank: 4, name: 'BRONZE', minMs: 300, maxMs: 400,      color: '#cd7f32', nextName: 'SILBER', nextMaxMs: 300  },
  { rank: 5, name: 'ROOKIE', minMs: 400, maxMs: Infinity, color: '#666680', nextName: 'BRONZE', nextMaxMs: 400  },
];

export function getLeague(avgMs: number): League {
  return LEAGUES.find(l => avgMs >= l.minMs && avgMs < l.maxMs) ?? LEAGUES[LEAGUES.length - 1];
}

export function getMsToNextLeague(avgMs: number): number | null {
  const league = getLeague(avgMs);
  if (league.nextMaxMs === null) return null;
  return avgMs - league.nextMaxMs;
}

// ─── PERSISTENT IDENTITY (localStorage) ─────────────────
const STORAGE_KEY_NICK = 'reflexrush_nick';
const STORAGE_KEY_RANK = 'reflexrush_last_rank';
const STORAGE_KEY_SCORE = 'reflexrush_last_score';
const STORAGE_KEY_HISTORY = 'reflexrush_score_history';
const MAX_HISTORY = 10;

export function saveNickname(nick: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY_NICK, nick);
}

export function loadNickname(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(STORAGE_KEY_NICK) ?? '';
}

export function saveLastRank(rank: number) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY_RANK, String(rank));
}

export function loadLastRank(): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY_RANK);
  return v !== null ? parseInt(v, 10) : null;
}

export function saveLastScore(score: number) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY_SCORE, String(score));
  // Append to history
  const history = loadScoreHistory();
  history.push(score);
  if (history.length > MAX_HISTORY) history.shift();
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
}

export function loadLastScore(): number | null {
  if (typeof window === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY_SCORE);
  return v !== null ? parseInt(v, 10) : null;
}

export function loadScoreHistory(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) ?? '[]');
  } catch {
    return [];
  }
}

/** Delta vs personal best (negative = improvement) */
export function getDelta(newScore: number): number | null {
  const history = loadScoreHistory();
  if (history.length === 0) return null;
  const best = Math.min(...history);
  return newScore - best;
}
