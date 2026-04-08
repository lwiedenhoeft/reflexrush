// ─── LEVEL CONFIGURATION ────────────────────────────────
// Each level = 5 successful green reactions.
// To add a new level: just append an entry to LEVELS[].
// The game loops the last level forever once all are cleared.
//
// SUCCESS METRIC: Level reached (primary), reaction time (secondary).
// Higher levels = shorter stimulus display = harder.

export type StimulusType = 'green' | 'red' | 'yellow' | 'flash' | 'gold';

export interface Distraction {
  type: 'yellow' | 'flash';
  chance: number;
  label: string;
  color: string;
  innerColor: string;
  symbol: string;
}

export interface LevelConfig {
  /** Level number (1-based, for display) */
  level: number;
  /** Level name shown on level-up screen */
  name: string;
  /** Minimum wait before stimulus (ms) */
  minWaitMs: number;
  /** Maximum wait before stimulus (ms) */
  maxWaitMs: number;
  /** How long the stimulus (green/red/etc) is VISIBLE on screen (ms).
   *  Player must react within this window. Gets shorter each level. */
  displayMs: number;
  /** Base chance of red stimulus (0–1) */
  redChance: number;
  /** Chance of gold (bonus) stimulus (0–1). Gold shows for displayMs/2 — hit it for double round progress. */
  goldChance: number;
  /** Additional distractions beyond red */
  distractions: Distraction[];
  /** Brief description of what's new */
  description: string;
}

// ─── THE LEVELS ─────────────────────────────────────────
// Easy to maintain: just tweak numbers or add entries.
// displayMs = how long the button is visible. KEY difficulty driver.

export const LEVELS: LevelConfig[] = [
  // ── LEVEL 1: Tutorial ──────────────────────────────────
  {
    level: 1,
    name: 'AUFWAERMEN',
    minWaitMs: 1500,
    maxWaitMs: 4000,
    displayMs: 1200,
    redChance: 0.15,
    goldChance: 0,
    distractions: [],
    description: 'LANGSAM STARTEN',
  },

  // ── LEVEL 2: Getting real ──────────────────────────────
  {
    level: 2,
    name: 'EINSTIEG',
    minWaitMs: 1200,
    maxWaitMs: 3500,
    displayMs: 1000,
    redChance: 0.25,
    distractions: [],
    description: 'MEHR ROT &middot; KUERZER SICHTBAR',
  },

  // ── LEVEL 3: Yellow fakes ──────────────────────────────
  {
    level: 3,
    name: 'TAEUSCHUNG',
    minWaitMs: 1000,
    maxWaitMs: 3000,
    displayMs: 850,
    redChance: 0.25,
    distractions: [
      { type: 'yellow', chance: 0.15, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
    ],
    description: 'GELB = NICHT DRUECKEN',
  },

  // ── LEVEL 4: Speed up ─────────────────────────────────
  {
    level: 4,
    name: 'TEMPO',
    minWaitMs: 800,
    maxWaitMs: 2500,
    displayMs: 700,
    redChance: 0.3,
    distractions: [
      { type: 'yellow', chance: 0.15, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
    ],
    description: 'SCHNELLERE REIZE &middot; KUERZER',
  },

  // ── LEVEL 5: Flash distraction ─────────────────────────
  {
    level: 5,
    name: 'BLITZ',
    minWaitMs: 700,
    maxWaitMs: 2200,
    displayMs: 580,
    redChance: 0.25,
    distractions: [
      { type: 'yellow', chance: 0.12, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
      { type: 'flash', chance: 0.12, label: 'FAKE!', color: '#00ccff', innerColor: '#001a22', symbol: '~' },
    ],
    description: 'BLAU-BLITZE &middot; NOCH KUERZER',
  },

  // ── LEVEL 6: Chaos ────────────────────────────────────
  {
    level: 6,
    name: 'CHAOS',
    minWaitMs: 600,
    maxWaitMs: 2000,
    displayMs: 480,
    redChance: 0.2,
    distractions: [
      { type: 'yellow', chance: 0.15, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
      { type: 'flash', chance: 0.15, label: 'FAKE!', color: '#00ccff', innerColor: '#001a22', symbol: '~' },
    ],
    description: 'MAXIMALES CHAOS',
  },

  // ── LEVEL 7: Endgame ──────────────────────────────────
  {
    level: 7,
    name: 'ENDGAME',
    minWaitMs: 500,
    maxWaitMs: 1800,
    displayMs: 400,
    redChance: 0.2,
    distractions: [
      { type: 'yellow', chance: 0.18, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
      { type: 'flash', chance: 0.18, label: 'FAKE!', color: '#00ccff', innerColor: '#001a22', symbol: '~' },
    ],
    description: 'NUR FUER PROFIS',
  },

  // ── LEVEL 8: Beyond ───────────────────────────────────
  {
    level: 8,
    name: 'JENSEITS',
    minWaitMs: 400,
    maxWaitMs: 1500,
    displayMs: 350,
    redChance: 0.2,
    distractions: [
      { type: 'yellow', chance: 0.2, label: 'FALLE!', color: '#ffd700', innerColor: '#1a1500', symbol: '?' },
      { type: 'flash', chance: 0.2, label: 'FAKE!', color: '#00ccff', innerColor: '#001a22', symbol: '~' },
    ],
    description: 'UNMOEGLICH?',
  },
];

// ─── HELPERS ────────────────────────────────────────────

/** Get the config for a given level (1-based). Loops the last level with scaling. */
export function getLevelConfig(level: number): LevelConfig {
  const index = Math.min(level - 1, LEVELS.length - 1);
  const config = LEVELS[index];
  if (level > LEVELS.length) {
    // Beyond defined levels: keep getting harder
    const extra = level - LEVELS.length;
    return {
      ...config,
      level,
      name: `JENSEITS+${extra}`,
      displayMs: Math.max(250, config.displayMs - extra * 20),
      minWaitMs: Math.max(300, config.minWaitMs - extra * 30),
      maxWaitMs: Math.max(800, config.maxWaitMs - extra * 50),
    };
  }
  return config;
}

export const ROUNDS_PER_LEVEL = 5;

/** Pick a stimulus type based on level config */
export function pickStimulus(config: LevelConfig): { type: StimulusType; distraction?: Distraction } {
  const roll = Math.random();
  let threshold = 0;
  for (const d of config.distractions) {
    threshold += d.chance;
    if (roll < threshold) return { type: d.type, distraction: d };
  }
  if (roll < threshold + config.redChance) return { type: 'red' };
  return { type: 'green' };
}

/** Random wait time for a level */
export function getWaitTime(config: LevelConfig): number {
  return config.minWaitMs + Math.random() * (config.maxWaitMs - config.minWaitMs);
}
