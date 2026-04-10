// ─── BEAT ENGINE ─────────────────────────────────────────
// Provides beat-synced music loops and timing for stimulus scheduling.
// Loops are generated procedurally via OfflineAudioContext (chiptune style).
// To replace with real audio files, swap generateLoop() with fetch + decodeAudioData.

'use client';

export type BpmTier = 'slow' | 'medium' | 'fast';

const TIER_BPM: Record<BpmTier, number> = {
  slow:   110,
  medium: 140,
  fast:   170,
};

const SAMPLE_RATE = 44100;
const BARS = 4;
const BEATS_PER_BAR = 4;

/** Map game level → BPM tier */
export function getTierForLevel(level: number): BpmTier {
  if (level <= 3) return 'slow';
  if (level <= 6) return 'medium';
  return 'fast';
}

// ─── HELPERS FOR LOOP GENERATION ───────────────────────────

/** Square wave sample (-1 or +1) */
function square(phase: number): number {
  return phase % 1 < 0.5 ? 1 : -1;
}

/** Triangle wave sample */
function triangle(phase: number): number {
  const p = phase % 1;
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

/** Simple noise */
function noise(): number {
  return Math.random() * 2 - 1;
}

/** Render a decaying sine (kick drum) into buffer */
function renderKick(data: Float32Array, start: number, sr: number, volume = 0.35): void {
  const dur = Math.floor(0.15 * sr);
  for (let i = 0; i < dur && start + i < data.length; i++) {
    const t = i / sr;
    const freq = 150 * Math.exp(-t * 30); // pitch drop
    const env = Math.exp(-t * 25);
    data[start + i] += Math.sin(2 * Math.PI * freq * t) * env * volume;
  }
}

/** Render noise burst (snare) into buffer */
function renderSnare(data: Float32Array, start: number, sr: number, volume = 0.12): void {
  const dur = Math.floor(0.06 * sr);
  for (let i = 0; i < dur && start + i < data.length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 40);
    // Noise + pitched body
    data[start + i] += (noise() * 0.6 + Math.sin(2 * Math.PI * 200 * t) * 0.4) * env * volume;
  }
}

/** Render short noise (hihat) into buffer */
function renderHihat(data: Float32Array, start: number, sr: number, volume = 0.04): void {
  const dur = Math.floor(0.02 * sr);
  for (let i = 0; i < dur && start + i < data.length; i++) {
    const env = Math.exp(-(i / sr) * 100);
    data[start + i] += noise() * env * volume;
  }
}

/** Render a square-wave bass note into buffer */
function renderBass(
  data: Float32Array, start: number, sr: number,
  freq: number, duration: number, volume = 0.10,
): void {
  const dur = Math.floor(duration * sr);
  for (let i = 0; i < dur && start + i < data.length; i++) {
    const t = i / sr;
    const phase = freq * t;
    // Fade out at end
    const env = i < dur * 0.85 ? 1 : Math.max(0, 1 - (i - dur * 0.85) / (dur * 0.15));
    data[start + i] += square(phase) * env * volume;
  }
}

/** Render a triangle-wave lead note into buffer */
function renderLead(
  data: Float32Array, start: number, sr: number,
  freq: number, duration: number, volume = 0.05,
): void {
  const dur = Math.floor(duration * sr);
  for (let i = 0; i < dur && start + i < data.length; i++) {
    const t = i / sr;
    const phase = freq * t;
    const env = i < dur * 0.7 ? 1 : Math.max(0, 1 - (i - dur * 0.7) / (dur * 0.3));
    data[start + i] += triangle(phase) * env * volume;
  }
}

// ─── LOOP PATTERNS ─────────────────────────────────────────

// Bass note patterns per tier (one array per bar, each sub-array = notes within one beat)
const BASS_PATTERNS: Record<BpmTier, number[][]> = {
  slow: [
    // Bar pattern (4 beats): A2 . E2 A2
    [110, 0, 82.5, 110],
    [110, 0, 82.5, 110],
    [87.3, 0, 98, 110],  // F2 . G2 A2
    [110, 0, 82.5, 110],
  ],
  medium: [
    [110, 131, 146.8, 131], // A2 C3 D3 C3
    [110, 131, 146.8, 131],
    [87.3, 110, 131, 110],  // F2 A2 C3 A2
    [82.5, 98, 110, 131],   // E2 G2 A2 C3
  ],
  fast: [
    [110, 110, 131, 131],   // A2 A2 C3 C3
    [146.8, 146.8, 131, 131], // D3 D3 C3 C3
    [110, 110, 87.3, 87.3], // A2 A2 F2 F2
    [82.5, 98, 110, 131],   // E2 G2 A2 C3
  ],
};

// Lead arpeggio patterns (frequencies, 0 = rest)
const LEAD_PATTERNS: Record<BpmTier, number[]> = {
  slow: [], // No lead on slow
  medium: [
    440, 0, 554, 0, 659, 0, 554, 0,  // A4 . C#5 . E5 . C#5 .
    440, 0, 554, 0, 659, 0, 880, 0,  // A4 . C#5 . E5 . A5 .
  ],
  fast: [
    440, 554, 659, 554, 880, 659, 554, 440,  // Fast arpeggio
    440, 554, 659, 880, 1047, 880, 659, 554,  // Higher run
  ],
};

function generateLoopBuffer(tier: BpmTier): Float32Array {
  const bpm = TIER_BPM[tier];
  const beatDur = 60 / bpm;
  const totalBeats = BARS * BEATS_PER_BAR;
  const loopDur = totalBeats * beatDur;
  const numSamples = Math.ceil(loopDur * SAMPLE_RATE);
  const data = new Float32Array(numSamples);

  const bassPattern = BASS_PATTERNS[tier];
  const leadPattern = LEAD_PATTERNS[tier];

  for (let bar = 0; bar < BARS; bar++) {
    const barBass = bassPattern[bar % bassPattern.length];

    for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
      const globalBeat = bar * BEATS_PER_BAR + beat;
      const beatStart = Math.floor(globalBeat * beatDur * SAMPLE_RATE);
      const eighthSamples = Math.floor((beatDur / 2) * SAMPLE_RATE);

      // ── Kick ──
      if (beat === 0 || beat === 2) {
        renderKick(data, beatStart, SAMPLE_RATE);
      }
      // Extra kick on fast tier
      if (tier === 'fast' && beat === 3 && bar % 2 === 1) {
        renderKick(data, beatStart, SAMPLE_RATE, 0.25);
      }

      // ── Snare ──
      if (beat === 1 || beat === 3) {
        renderSnare(data, beatStart, SAMPLE_RATE);
      }
      // Ghost snare on medium/fast
      if (tier !== 'slow' && beat === 0 && bar === 3) {
        renderSnare(data, beatStart + eighthSamples, SAMPLE_RATE, 0.06);
      }

      // ── Hihat ──
      if (tier === 'fast') {
        // 16th notes
        const sixteenthSamples = Math.floor((beatDur / 4) * SAMPLE_RATE);
        for (let s = 0; s < 4; s++) {
          renderHihat(data, beatStart + s * sixteenthSamples, SAMPLE_RATE,
            s === 0 ? 0.05 : 0.025);
        }
      } else {
        // 8th notes
        renderHihat(data, beatStart, SAMPLE_RATE, 0.04);
        renderHihat(data, beatStart + eighthSamples, SAMPLE_RATE, 0.025);
      }

      // ── Bass ──
      const bassFreq = barBass[beat];
      if (bassFreq > 0) {
        const bassDur = tier === 'fast' ? beatDur * 0.45 : beatDur * 0.75;
        renderBass(data, beatStart, SAMPLE_RATE, bassFreq, bassDur,
          tier === 'fast' ? 0.12 : 0.09);
      }

      // ── Lead ──
      if (leadPattern.length > 0) {
        if (tier === 'fast') {
          // 8th note lead
          for (let e = 0; e < 2; e++) {
            const idx = (globalBeat * 2 + e) % leadPattern.length;
            const freq = leadPattern[idx];
            if (freq > 0) {
              renderLead(data, beatStart + e * eighthSamples, SAMPLE_RATE,
                freq, beatDur / 2 * 0.8, 0.04);
            }
          }
        } else {
          // Quarter note lead
          const idx = globalBeat % leadPattern.length;
          const freq = leadPattern[idx];
          if (freq > 0) {
            renderLead(data, beatStart, SAMPLE_RATE, freq, beatDur * 0.7, 0.035);
          }
        }
      }
    }
  }

  return data;
}

// ─── BEAT ENGINE CLASS ─────────────────────────────────────

export class BeatEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffers = new Map<BpmTier, AudioBuffer>();
  private _currentTier: BpmTier = 'slow';
  private _playing = false;
  private _muted = false;
  private loopStartTime = 0;
  private _ready = false;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  get bpm(): number { return TIER_BPM[this._currentTier]; }
  get beatMs(): number { return 60000 / this.bpm; }
  get playing(): boolean { return this._playing; }
  get muted(): boolean { return this._muted; }
  get ready(): boolean { return this._ready; }
  get currentTier(): BpmTier { return this._currentTier; }

  /** Initialize engine — call once on first user interaction */
  init(): void {
    if (this._ready) return;
    const ctx = this.ensureCtx();
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this._muted ? 0 : 0.25;
    this.gainNode.connect(ctx.destination);

    // Generate all tier loops synchronously (fast — just math)
    for (const tier of ['slow', 'medium', 'fast'] as BpmTier[]) {
      const raw = generateLoopBuffer(tier);
      const buf = ctx.createBuffer(1, raw.length, SAMPLE_RATE);
      buf.getChannelData(0).set(raw);
      this.buffers.set(tier, buf);
    }
    this._ready = true;
  }

  // ─── Beat timing ───

  /**
   * Calculate a beat-quantized wait time in ms.
   * Picks a random number of beats between min and max constraints,
   * then snaps to the next beat grid boundary.
   */
  getBeatQuantizedWait(minMs: number, maxMs: number): number {
    const bms = this.beatMs;
    const minBeats = Math.max(2, Math.ceil(minMs / bms));
    const maxBeats = Math.max(minBeats, Math.floor(maxMs / bms));
    const waitBeats = minBeats + Math.floor(Math.random() * (maxBeats - minBeats + 1));

    if (!this._playing || !this.ctx) return waitBeats * bms;

    // Snap to actual beat grid
    const now = this.ctx.currentTime;
    const elapsed = now - this.loopStartTime;
    const beatSec = 60 / this.bpm;
    const currentBeatFrac = elapsed / beatSec;
    const nextBeat = Math.ceil(currentBeatFrac);
    const targetBeat = nextBeat + waitBeats - 1;
    const targetTime = this.loopStartTime + targetBeat * beatSec;
    return Math.max(50, (targetTime - now) * 1000);
  }

  // ─── Playback ───

  start(tier?: BpmTier): void {
    if (!this._ready) this.init();
    if (tier) this._currentTier = tier;
    this.stopSource();

    const ctx = this.ensureCtx();
    const buffer = this.buffers.get(this._currentTier);
    if (!buffer || !this.gainNode) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(this.gainNode);
    source.start(0);
    this.source = source;
    this.loopStartTime = ctx.currentTime;
    this._playing = true;
  }

  stop(): void {
    this.stopSource();
    this._playing = false;
  }

  /** Crossfade to a new BPM tier */
  switchTier(newTier: BpmTier): void {
    if (newTier === this._currentTier || !this._playing) {
      this._currentTier = newTier;
      return;
    }
    this._currentTier = newTier;

    // Quick crossfade: fade out → start new loop
    if (this.gainNode && this.ctx) {
      const ctx = this.ctx;
      const gain = this.gainNode;
      const targetVol = this._muted ? 0 : 0.25;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
      setTimeout(() => {
        this.stopSource();
        gain.gain.value = targetVol;
        this.start();
      }, 130);
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this.gainNode) {
      this.gainNode.gain.value = this._muted ? 0 : 0.25;
    }
    try { localStorage.setItem('rr_muted', this._muted ? '1' : '0'); } catch {}
    return this._muted;
  }

  /** Restore mute state from localStorage */
  loadMuteState(): void {
    try {
      this._muted = localStorage.getItem('rr_muted') === '1';
    } catch {}
  }

  private stopSource(): void {
    try { this.source?.stop(); } catch {}
    try { this.source?.disconnect(); } catch {}
    this.source = null;
  }
}
