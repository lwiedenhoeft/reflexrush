// ─── LEVEL CONFIGURATION ────────────────────────────────
// Each level = 5 successful green reactions.
// To add a new level: just append an entry to LEVELS[].
// The game loops the last level forever once all are cleared.

export type StimulusType = 'green' | 'red' | 'yellow' | 'flash';

export interface Distraction {
  /** Type of fake stimulus */
  type: 'yellow' | 'flash';
  /** Chance (0–1) this distraction appears instead of a normal red */
  chance: number;
  /** Label shown during stimulus */
  label: string;
  /** Display color */
  color: string;
  /** Dark inner text color */
  innerColor: string;
  /** Symbol shown inside the box */
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
  /** Time the player has to react to green (ms) */
  timeoutMs: number;
  /** Base chance of red stimulus (0–1) */
  redChance: number;
  /** Additional distractions beyond red */
  distractions: Distraction[];
  /** Brief description of what's new */
  description: string;
}

// ─── THE LEVELS ─────────────────────────────────────────
// Easy to maintain: just tweak numbers or add entries.

export const LEVELS: LevelConfig[] = [
  // ── LEVEL 1: Tutorial ──────────────────────────────────
  {
    level: 1,
    name: 'AUFWAERMEN',
    minWaitMs: 1500,
    maxWaitMs: 4000,
    timeoutMs: 1000,
    redChance: 0.15,
    distractions: [],
    description: 'LANGSAM STARTEN',
  },

  // ── LEVEL 2: Getting real ──────────────────────────────
  {
    level: 2,
    name: 'EINSTIEG',
    minWaitMs: 1200,
    maxWaitMs: 3500,
    timeoutMs: 900,
    redChance: 0.25,
    distractions: [],
    description: 'MEHR ROT, WENIGER ZEIT',
  },

  // ── LEVEL 3: Yellow fakes ──────────────────────────────
  {
    level: 3,
    name: 'TAEUSCHUNG',
    minWaitMs: 1000,
    maxWaitMs: 3000,
    timeoutMs: 850,
    redChance: 0.25,
    distractions: [
      {
        type: 'yellow',
        chance: 0.15,
        label: 'FALLE!',
        color: '#ffd700',
        innerColor: '#1a1500',
        symbol: '?',
      },
    ],
    description: 'GELB = NICHT DRUECKEN',
  },

  // ── LEVEL 4: Speed up ─────────────────────────────────
  {
    level: 4,
    name: 'TEMPO',
    minWaitMs: 800,
    maxWaitMs: 2500,
    timeoutMs: 750,
    redChance: 0.3,
    distractions: [
      {
        type: 'yellow',
        chance: 0.15,
        label: 'FALLE!',
        color: '#ffd700',
        innerColor: '#1a1500',
        symbol: '?',
      },
    ],
    description: 'SCHNELLERE REIZE',
  },

  // ── LEVEL 5: Flash distraction ─────────────────────────
  {
    level: 5,
    name: 'BLITZ',
    minWaitMs: 700,
    maxWaitMs: 2200,
    timeoutMs: 700,
    redChance: 0.25,
    distractions: [
      {
        type: 'yellow',
        chance: 0.12,
        label: 'FALLE!',
        color: '#ffd700',
        innerColor: '#1a1500',
        symbol: '?',
      },
      {
        type: 'flash',
        chance: 0.12,
        label: 'FAKE!',
        color: '#00ccff',
        innerColor: '#001a22',
        symbol: '~',
      },
    ],
    description: 'BLAU-BLITZE IGNORIEREN',
  },

  // ── LEVEL 6: Chaos ────────────────────────────────────
  {
    level: 6,
    name: 'CHAOS',
    minWaitMs: 600,
    maxWaitMs: 2000,
    timeoutMs: 650,
    redChance: 0.2,
    distractions: [
      {
        type: 'yellow',
        chance: 0.15,
        label: 'FALLE!',
        color: '#ffd700',
        innerColor: '#1a1500',
        symbol: '?',
      },
      {
        type: 'flash',
        chance: 0.15,
        label: 'FAKE!',
        color: '#00ccff',
        innerColor: '#001a22',
        symbol: '~',
      },
    ],
    description: 'MAXIMALES CHAOS',
  },

  // ── LEVEL 7: Endgame ──────────────────────────────────
  {
    level: 7,
    name: 'ENDGAME',
    minWaitMs: 500,
    maxWaitMs: 1800,
    timeoutMs: 600,
    redChance: 0.2,
    distractions: [
      {
        type: 'yellow',
        chance: 0.18,
        label: 'FALLE!',
        color: '#ffd700',
        innerColor: '#1a1500',
        symbol: '?',
      },
      {
        type: 'flash',
        chance: 0.18,
        label: 'FAKE!',
        color: '#00ccff',
        innerColor: '#001a22',
        symbol: '~',
      },
    ],
    description: 'NUR FUER PROFIS',
  },
];

// ─── HELPERS ────────────────────────────────────────────

/** Get the config for a given level (1-based). Loops the last level. */
export function getLevelConfig(level: number): LevelConfig {
  const index = Math.min(level - 1, LEVELS.length - 1);
  const config = LEVELS[index];
  // If we're beyond defined levels, return last level but with correct number
  if (level > LEVELS.length) {
    return { ...config, level, name: `ENDGAME+${level - LEVELS.length}` };
  }
  return config;
}

export const ROUNDS_PER_LEVEL = 5;

/** Pick a stimulus type based on level config */
export function pickStimulus(config: LevelConfig): { type: StimulusType; distraction?: Distraction } {
  const roll = Math.random();

  // Check distractions first
  let threshold = 0;
  for (const d of config.distractions) {
    threshold += d.chance;
    if (roll < threshold) {
      return { type: d.type, distraction: d };
    }
  }

  // Then red
  if (roll < threshold + config.redChance) {
    return { type: 'red' };
  }

  // Default: green
  return { type: 'green' };
}

/** Random wait time for a level */
export function getWaitTime(config: LevelConfig): number {
  return config.minWaitMs + Math.random() * (config.maxWaitMs - config.minWaitMs);
}
