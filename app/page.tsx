'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { submitScoreWithOvertake, getCurrentRank, type LeaderboardEntry } from '@/lib/supabase';
import {
  type StimulusType, type LevelConfig, type Distraction,
  getLevelConfig, pickStimulus, getWaitTime, ROUNDS_PER_LEVEL,
} from '@/lib/levels';
import {
  getLeague, getMsToNextLeague,
  saveNickname, loadNickname,
  saveLastRank, loadLastRank,
  saveLastScore, loadLastScore, getDelta,
} from '@/lib/leagues';
import { BeatEngine, getTierForLevel } from '@/lib/beat-engine';

// ─── TYPES ──────────────────────────────────────────────
type GamePhase =
  | 'menu'
  | 'countdown'
  | 'waiting'
  | 'stimulus'
  | 'levelUp'
  | 'roundEnd'
  | 'failed'
  | 'leaderboard';
// NOTE: 'result' phase REMOVED — no individual time display.
// Player gets audio/visual feedback inline, then auto-advances.

interface RoundResult {
  reactionMs: number;
  level: number;
}

// ─── SOUND ENGINE ───────────────────────────────────────
class ChiptuneAudio {
  private ctx: AudioContext | null = null;
  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  playTone(freq: number, duration: number, type: OscillatorType = 'square', volume = 0.15) {
    const ctx = this.getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + duration);
  }
  countdown() { this.playTone(440, 0.15, 'square', 0.12); }
  countdownGo() { this.playTone(880, 0.25, 'square', 0.15); }
  menuSelect() { this.playTone(600, 0.08, 'square', 0.08); }
  goodReaction() { this.playTone(660, 0.08, 'square', 0.12); setTimeout(() => this.playTone(880, 0.12, 'square', 0.12), 80); }
  greatReaction() { this.playTone(660, 0.06, 'square', 0.15); setTimeout(() => this.playTone(880, 0.06, 'square', 0.15), 60); setTimeout(() => this.playTone(1100, 0.15, 'square', 0.15), 120); }
  fail() { this.playTone(220, 0.3, 'sawtooth', 0.15); setTimeout(() => this.playTone(165, 0.4, 'sawtooth', 0.12), 150); }
  nearMiss() { this.playTone(440, 0.1, 'square', 0.1); setTimeout(() => this.playTone(550, 0.1, 'square', 0.1), 100); setTimeout(() => this.playTone(440, 0.15, 'square', 0.12), 200); }
  newRecord() { [523, 659, 784, 1047].forEach((n, i) => setTimeout(() => this.playTone(n, 0.15, 'square', 0.12), i * 120)); }
  levelUp() { [440, 554, 659, 880].forEach((n, i) => setTimeout(() => this.playTone(n, 0.2, 'square', 0.15), i * 150)); }
  overtake() { [600, 750, 900].forEach((n, i) => setTimeout(() => this.playTone(n, 0.12, 'square', 0.14), i * 100)); }
  rankLost() { [400, 320, 240].forEach((n, i) => setTimeout(() => this.playTone(n, 0.2, 'sawtooth', 0.12), i * 120)); }
  miss() { this.playTone(330, 0.15, 'triangle', 0.1); }
}

const COUNTDOWN_SECS = 3;
const TELEGRAPH_MS = 150; // Visual charge-up before stimulus appears

export default function ReflexRush() {
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [currentLevel, setCurrentLevel] = useState(1);
  const [currentRound, setCurrentRound] = useState(0);
  const [totalResults, setTotalResults] = useState<RoundResult[]>([]);
  const [levelResults, setLevelResults] = useState<RoundResult[]>([]);
  const [stimulusType, setStimulusType] = useState<StimulusType>('green');
  const [activeDistraction, setActiveDistraction] = useState<Distraction | null>(null);
  const [countdownNum, setCountdownNum] = useState(COUNTDOWN_SECS);
  const [shakeClass, setShakeClass] = useState<string>('');
  const [nickname, setNickname] = useState('');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [playerRank, setPlayerRank] = useState<number | null>(null);
  const [nearMissInfo, setNearMissInfo] = useState<string | null>(null);
  const [showNicknameInput, setShowNicknameInput] = useState(false);
  const [bestLevel, setBestLevel] = useState<number>(0);
  const [streakCount, setStreakCount] = useState(0);
  const [highestLevel, setHighestLevel] = useState(1);
  const [overtakenNick, setOvertakenNick] = useState<string | null>(null);
  const [rankLostAlert, setRankLostAlert] = useState<string | null>(null);
  const [scoreDelta, setScoreDelta] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Brief green flash feedback (no result screen)
  const [flashFeedback, setFlashFeedback] = useState<string | null>(null);
  // Telegraph: brief glow before stimulus appears
  const [isTelegraphing, setIsTelegraphing] = useState(false);
  // Juiciness: combo counter + particles
  const [comboCount, setComboCount] = useState(0);
  const [particles, setParticles] = useState<{id: number; px: number; py: number; color: string}[]>([]);
  // Beat engine
  const [isMuted, setIsMuted] = useState(false);

  const stimulusTimeRef = useRef(0);
  const waitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<ChiptuneAudio | null>(null);
  const beatRef = useRef<BeatEngine | null>(null);
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const hasRespondedRef = useRef(false);
  const levelConfigRef = useRef<LevelConfig>(getLevelConfig(1));

  // ─── INIT ────────────────────────────────────────────
  useEffect(() => {
    audioRef.current = new ChiptuneAudio();
    // Beat engine (lazy init — generates loops on first user gesture)
    const beat = new BeatEngine();
    beat.loadMuteState();
    setIsMuted(beat.muted);
    beatRef.current = beat;

    const savedNick = loadNickname();
    if (savedNick) {
      setNickname(savedNick);
      const savedRank = loadLastRank();
      if (savedRank !== null) {
        getCurrentRank(savedNick).then(cur => {
          if (cur !== null && cur > savedRank) {
            setRankLostAlert(`PLATZ ${savedRank} VERLOREN → JETZT #${cur}`);
            audioRef.current?.rankLost();
          }
        });
      }
    }
    const lastScore = loadLastScore();
    if (lastScore !== null) setBestLevel(lastScore);
    return () => { beat.stop(); };
  }, []);

  useEffect(() => { levelConfigRef.current = getLevelConfig(currentLevel); }, [currentLevel]);

  const clearTimers = useCallback(() => {
    if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    waitTimerRef.current = null; timeoutTimerRef.current = null;
  }, []);

  const triggerShake = useCallback((intensity: 'light' | 'normal' | 'heavy' = 'normal') => {
    const cls = intensity === 'heavy' ? 'shake-heavy' : intensity === 'light' ? 'shake-light' : 'shake';
    setShakeClass(cls);
    setTimeout(() => setShakeClass(''), intensity === 'heavy' ? 350 : intensity === 'light' ? 200 : 300);
  }, []);

  const spawnParticles = useCallback((color: string, count = 10) => {
    const pts = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const dist = 50 + Math.random() * 60;
      return { id: Date.now() + i, px: Math.cos(angle) * dist, py: Math.sin(angle) * dist, color };
    });
    setParticles(pts);
    setTimeout(() => setParticles([]), 500);
  }, []);

  // ─── ADVANCE ROUND (auto, no result screen) ──────────
  const advanceRoundDirect = useCallback((config: LevelConfig) => {
    setCurrentRound(prev => {
      const next = prev + 1;
      if (next >= ROUNDS_PER_LEVEL) {
        setPhase('levelUp');
        return prev;
      }
      setPhase('waiting');
      // Beat-quantized wait: use engine if playing, else random
      const beat = beatRef.current;
      const waitMs = beat?.playing
        ? beat.getBeatQuantizedWait(config.minWaitMs, config.maxWaitMs)
        : getWaitTime(config);
      waitTimerRef.current = setTimeout(() => {
        stimulusRef.current?.();
      }, waitMs);
      return next;
    });
  }, []);

  // We need a ref for showStimulus because of circular dependency
  const stimulusRef = useRef<(() => void) | null>(null);

  // ─── SHOW STIMULUS ───────────────────────────────────
  const showStimulus = useCallback(() => {
    const config = levelConfigRef.current;
    const { type, distraction } = pickStimulus(config);

    // Telegraph: flash the waiting box white before revealing the stimulus
    setIsTelegraphing(true);
    setTimeout(() => {
      setIsTelegraphing(false);
      setStimulusType(type);
      setActiveDistraction(distraction || null);
      setFlashFeedback(null);
      setPhase('stimulus');
      stimulusTimeRef.current = performance.now();
      hasRespondedRef.current = false;

      // Gold shows for half the normal window — react fast for a bonus!
      const effectiveDisplayMs = type === 'gold'
        ? Math.max(150, Math.floor(config.displayMs / 2))
        : config.displayMs;

    if (type === 'green' || type === 'gold') {
      // Stimulus disappears after effectiveDisplayMs — player must react within that window
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          setComboCount(0); // miss breaks the combo
          // Missed! Counts as max time for this attempt
          const result = { reactionMs: effectiveDisplayMs, level: config.level };
          setLevelResults(prev => [...prev, result]);
          setTotalResults(prev => [...prev, result]);
          audioRef.current?.miss();
          setFlashFeedback(type === 'gold' ? 'VERPASST ★' : 'VERPASST');
          // Auto-advance after brief feedback
          setTimeout(() => {
            setFlashFeedback(null);
            advanceRoundDirect(config);
          }, 400);
        }
      }, effectiveDisplayMs);
    } else {
      // Non-green/gold: player must NOT press. Disappears after displayMs.
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          // Correctly ignored → next stimulus (no round count)
          setPhase('waiting');
          const beat = beatRef.current;
          const waitMs = beat?.playing
            ? beat.getBeatQuantizedWait(config.minWaitMs, config.maxWaitMs)
            : getWaitTime(config);
          waitTimerRef.current = setTimeout(() => showStimulus(), waitMs);
        }
      }, config.displayMs);
    }
    }, TELEGRAPH_MS); // end telegraph delay
  }, [advanceRoundDirect]);

  // Wire up the ref
  useEffect(() => { stimulusRef.current = showStimulus; }, [showStimulus]);

  // ─── NEXT LEVEL ──────────────────────────────────────
  const goToNextLevel = useCallback(() => {
    clearTimers();
    const nextLevel = currentLevel + 1;
    setCurrentLevel(nextLevel);
    setCurrentRound(0);
    setLevelResults([]);
    if (nextLevel > highestLevel) setHighestLevel(nextLevel);
    audioRef.current?.levelUp();
    // Switch BPM tier if needed (crossfade)
    const newTier = getTierForLevel(nextLevel);
    beatRef.current?.switchTier(newTier);
    setPhase('waiting');
    const config = getLevelConfig(nextLevel);
    const beat = beatRef.current;
    const waitMs = beat?.playing
      ? beat.getBeatQuantizedWait(config.minWaitMs, config.maxWaitMs)
      : getWaitTime(config);
    waitTimerRef.current = setTimeout(() => showStimulus(), waitMs);
  }, [currentLevel, highestLevel, clearTimers, showStimulus]);

  const endRun = useCallback(() => {
    beatRef.current?.stop(); // Stop music on run end
    setShowNicknameInput(true);
    setPhase('roundEnd');
    setTimeout(() => nicknameInputRef.current?.focus(), 100);
  }, []);

  /** Get a wait time — beat-quantized when engine is playing, else random */
  const getNextWait = useCallback((config: LevelConfig): number => {
    const beat = beatRef.current;
    if (beat?.playing) {
      return beat.getBeatQuantizedWait(config.minWaitMs, config.maxWaitMs);
    }
    return getWaitTime(config);
  }, []);

  // ─── START GAME ──────────────────────────────────────
  const startGame = useCallback(() => {
    clearTimers();
    setTotalResults([]); setLevelResults([]);
    setCurrentRound(0); setCurrentLevel(1);
    setNearMissInfo(null); setPlayerRank(null);
    setActiveDistraction(null); setOvertakenNick(null);
    setRankLostAlert(null); setScoreDelta(null); setFlashFeedback(null);
    setComboCount(0); setParticles([]);
    setPhase('countdown'); setCountdownNum(COUNTDOWN_SECS);
    levelConfigRef.current = getLevelConfig(1);
    audioRef.current?.menuSelect();

    // Init + start beat engine on first user gesture
    const beat = beatRef.current;
    if (beat) {
      if (!beat.ready) beat.init();
      beat.start(getTierForLevel(1));
    }

    let count = COUNTDOWN_SECS;
    const interval = setInterval(() => {
      count--;
      if (count > 0) { setCountdownNum(count); audioRef.current?.countdown(); }
      else if (count === 0) { setCountdownNum(0); audioRef.current?.countdownGo(); }
      else {
        clearInterval(interval);
        setPhase('waiting');
        const config = getLevelConfig(1);
        waitTimerRef.current = setTimeout(() => showStimulus(), getNextWait(config));
      }
    }, 900);
  }, [clearTimers, showStimulus, getNextWait]);

  // ─── INPUT HANDLER ───────────────────────────────────
  const handleInput = useCallback((event?: KeyboardEvent | TouchEvent) => {
    if (showNicknameInput) return;

    switch (phase) {
      case 'menu':
      case 'leaderboard':
        startGame();
        break;

      case 'stimulus': {
        if (hasRespondedRef.current) return;
        hasRespondedRef.current = true;
        clearTimers();
        const config = levelConfigRef.current;

        if (stimulusType !== 'green' && stimulusType !== 'gold') {
          // FAIL – pressed on non-green/gold
          beatRef.current?.stop();
          audioRef.current?.fail();
          triggerShake('heavy');
          setStreakCount(0);
          setComboCount(0);
          setPhase('failed');
        } else {
          // Good reaction – record time silently, auto-advance
          // Use event.timeStamp for more precise timing (captured at OS level)
          const eventTime = event?.timeStamp ?? performance.now();
          const rt = Math.round(eventTime - stimulusTimeRef.current);
          const result = { reactionMs: rt, level: currentLevel };
          setLevelResults(prev => [...prev, result]);
          setTotalResults(prev => [...prev, result]);
          setComboCount(prev => prev + 1);

          // Variable audio + shake + particles based on quality
          const isGold = stimulusType === 'gold';
          if (isGold) {
            audioRef.current?.greatReaction();
            triggerShake('heavy');
            spawnParticles('#ffd700', 14);
          } else if (rt < 150) {
            audioRef.current?.greatReaction();
            triggerShake('heavy');
            spawnParticles('#00ff41', 12);
          } else if (rt < 200) {
            audioRef.current?.greatReaction();
            triggerShake('normal');
            spawnParticles('#00ff41', 8);
          } else if (rt < 300) {
            audioRef.current?.goodReaction();
            triggerShake('normal');
            spawnParticles('#00ff41', 6);
          } else {
            audioRef.current?.goodReaction();
            triggerShake('light');
          }

          // Brief flash then advance (NO result screen)
          const feedback = isGold
            ? '★BONUS★'
            : (rt < 150 ? '!!!' : rt < 200 ? '!!' : '!');
          setFlashFeedback(feedback);
          setTimeout(() => {
            setFlashFeedback(null);
            advanceRoundDirect(config);
          }, isGold ? 350 : 250);
        }
        break;
      }

      case 'waiting':
        clearTimers();
        beatRef.current?.stop();
        audioRef.current?.fail();
        triggerShake('heavy');
        setStreakCount(0);
        setComboCount(0);
        setPhase('failed');
        break;

      case 'failed':
        if (totalResults.length > 0) endRun();
        else startGame();
        break;

      case 'levelUp':
        goToNextLevel();
        break;

      case 'roundEnd':
        setShowNicknameInput(true);
        setTimeout(() => nicknameInputRef.current?.focus(), 100);
        break;
    }
  }, [phase, stimulusType, currentLevel, totalResults, startGame, advanceRoundDirect, clearTimers, triggerShake, spawnParticles, showNicknameInput, goToNextLevel, endRun]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.code !== 'Space') return; e.preventDefault(); handleInput(e); };
    const handleTouchStart = (e: TouchEvent) => { const tag = (e.target as HTMLElement)?.tagName; if (tag === 'INPUT' || tag === 'BUTTON') return; e.preventDefault(); handleInput(e); };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('touchstart', handleTouchStart, { passive: false });
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('touchstart', handleTouchStart); };
  }, [handleInput]);

  // ─── COMPUTED ────────────────────────────────────────
  const averageMs = totalResults.length > 0
    ? Math.round(totalResults.reduce((s, r) => s + r.reactionMs, 0) / totalResults.length)
    : 0;
  const levelAverageMs = levelResults.length > 0
    ? Math.round(levelResults.reduce((s, r) => s + r.reactionMs, 0) / levelResults.length)
    : 0;
  const levelConfig = getLevelConfig(currentLevel);
  const nextLevelConfig = getLevelConfig(currentLevel + 1);

  // ─── SUBMIT SCORE ────────────────────────────────────
  const handleSubmitScore = async () => {
    if (!nickname.trim() || isSubmitting) return;
    setIsSubmitting(true);
    const nick = nickname.trim().toUpperCase().slice(0, 12);
    setNickname(nick);
    saveNickname(nick);
    setShowNicknameInput(false);

    // Level is the primary metric now
    const reachedLevel = currentLevel;
    const delta = getDelta(reachedLevel);
    setScoreDelta(delta);
    saveLastScore(reachedLevel);

    if (reachedLevel > bestLevel) {
      setBestLevel(reachedLevel);
      audioRef.current?.newRecord();
    }
    setStreakCount(prev => prev + 1);

    const result = await submitScoreWithOvertake(nick, reachedLevel, averageMs);
    setLeaderboard(result.leaderboard);
    setPlayerRank(result.newRank);

    if (result.overtakenNick) {
      setOvertakenNick(result.overtakenNick);
      audioRef.current?.overtake();
    }

    const newIdx = result.newRank !== null ? result.newRank - 1 : -1;
    if (newIdx > 0) {
      const above = result.leaderboard[newIdx - 1];
      if (above.max_level === reachedLevel) {
        const diff = averageMs - above.average_ms;
        if (diff <= 15 && diff > 0) {
          setNearMissInfo(`Nur ${diff}ms bis ${above.nickname}!`);
          audioRef.current?.nearMiss();
        }
      } else {
        const lvlDiff = above.max_level - reachedLevel;
        if (lvlDiff === 1) {
          setNearMissInfo(`Nur 1 Level bis ${above.nickname}!`);
          audioRef.current?.nearMiss();
        }
      }
    }

    if (result.newRank !== null) saveLastRank(result.newRank);
    setIsSubmitting(false);
    setPhase('leaderboard');
  };

  // ─── STIMULUS HELPERS ────────────────────────────────
  const getStimulusColor = () => {
    if (stimulusType === 'green') return 'var(--green)';
    if (stimulusType === 'red')   return 'var(--red)';
    if (stimulusType === 'gold')  return 'var(--gold)';
    return activeDistraction?.color ?? 'var(--red)';
  };
  const getStimulusInnerColor = () => {
    if (stimulusType === 'green') return '#001a00';
    if (stimulusType === 'red')   return '#1a0000';
    if (stimulusType === 'gold')  return '#1a1200';
    return activeDistraction?.innerColor ?? '#1a0000';
  };
  const getStimulusSymbol = () => {
    if (stimulusType === 'green') return '!';
    if (stimulusType === 'red')   return 'X';
    if (stimulusType === 'gold')  return '★';
    return activeDistraction?.symbol ?? 'X';
  };
  const getStimulusLabel = () => {
    if (stimulusType === 'green') return 'JETZT!';
    if (stimulusType === 'red')   return 'WARTE!';
    if (stimulusType === 'gold')  return 'SCHNELL!';
    return activeDistraction?.label ?? 'WARTE!';
  };
  const getStimulusBg = () => {
    if (stimulusType === 'green') return 'radial-gradient(circle, #003300 0%, #001a00 50%, var(--bg) 100%)';
    if (stimulusType === 'red')   return 'radial-gradient(circle, #330000 0%, #1a0000 50%, var(--bg) 100%)';
    if (stimulusType === 'gold')  return 'radial-gradient(circle, #332600 0%, #1a1200 50%, var(--bg) 100%)';
    if (stimulusType === 'yellow') return 'radial-gradient(circle, #332b00 0%, #1a1500 50%, var(--bg) 100%)';
    return 'radial-gradient(circle, #003344 0%, #001a22 50%, var(--bg) 100%)';
  };

  // ─── RENDER HELPERS ──────────────────────────────────
  const renderProgressDots = () => (
    <div style={{ display: 'flex', gap: 'var(--sp-xs)', justifyContent: 'center', marginBottom: 'var(--sp-sm)' }}>
      {Array.from({ length: ROUNDS_PER_LEVEL }).map((_, i) => (
        <div key={i} style={{
          width: 'var(--sz-dot)', height: 'var(--sz-dot)',
          background: i < levelResults.length ? 'var(--green)' : (i === currentRound && stimulusType === 'green') ? 'var(--gold)' : 'var(--accent)',
          boxShadow: (i === currentRound && stimulusType === 'green') ? '0 0 8px var(--gold)' : 'none',
          transition: 'all 0.2s',
        }} />
      ))}
    </div>
  );

  const handleMuteToggle = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const beat = beatRef.current;
    if (beat) {
      const nowMuted = beat.toggleMute();
      setIsMuted(nowMuted);
    }
  }, []);

  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100vh', padding: '24px',
    textAlign: 'center', position: 'relative', overflow: 'hidden',
    background: phase === 'stimulus' ? getStimulusBg() : 'var(--bg)',
    transition: 'background 0.1s',
  };

  return (
    <div className={shakeClass} style={containerStyle}>
      {/* Scanline */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)', pointerEvents: 'none', zIndex: 10 }} />

      {/* Mute toggle — always visible, bottom right */}
      <button
        onClick={handleMuteToggle}
        onTouchStart={handleMuteToggle}
        style={{
          position: 'absolute', bottom: 'var(--sp-sm)', right: 'var(--sp-sm)',
          zIndex: 20, background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', padding: 'var(--sp-xs)',
          fontFamily: "'Press Start 2P', monospace",
        }}
      >
        {isMuted ? 'MUTE' : 'SND'}
      </button>

      {/* Combo glow overlay — visible at 3+ consecutive hits */}
      {comboCount >= 3 && ['waiting', 'stimulus'].includes(phase) && (
        <div className="combo-ring" style={{
          boxShadow: `inset 0 0 ${Math.min(comboCount * 12, 80)}px rgba(0,255,65,${Math.min(0.04 + comboCount * 0.02, 0.18)})`,
        }} />
      )}

      {/* Particle burst from center on hit */}
      {particles.length > 0 && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', pointerEvents: 'none', zIndex: 25 }}>
          {particles.map(p => (
            <div key={p.id} className="particle" style={{
              '--px': `${p.px}px`,
              '--py': `${p.py}px`,
              background: p.color,
            } as React.CSSProperties} />
          ))}
        </div>
      )}

      {/* Level + display timer badge */}
      {['waiting', 'stimulus'].includes(phase) && (
        <div style={{ position: 'absolute', top: 'var(--sp-sm)', left: 'var(--sp-sm)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', zIndex: 20 }}>
          LVL {currentLevel} &middot; {stimulusType === 'gold'
            ? <span style={{ color: 'var(--gold)' }}>{Math.max(150, Math.floor(levelConfig.displayMs / 2))}ms ★</span>
            : `${levelConfig.displayMs}ms`}
        </div>
      )}

      {/* Combo counter — top right, visible at 3+ hits */}
      {comboCount >= 3 && ['waiting', 'stimulus'].includes(phase) && (
        <div style={{
          position: 'absolute', top: 'var(--sp-sm)', right: 'var(--sp-sm)',
          fontSize: 'var(--fs-xs)', zIndex: 20,
          color: comboCount >= 8 ? 'var(--gold)' : comboCount >= 5 ? 'var(--green)' : 'var(--text-dim)',
          textShadow: comboCount >= 5 ? `0 0 8px ${comboCount >= 8 ? 'var(--gold)' : 'var(--green)'}` : 'none',
        }}>
          COMBO x{comboCount}
        </div>
      )}

      {/* Flash feedback overlay (brief !/!!/!!!/★BONUS★/VERPASST) */}
      {flashFeedback && (() => {
        const isBonus   = flashFeedback === '★BONUS★';
        const isMiss    = flashFeedback.startsWith('VERPASST');
        const color     = isBonus ? 'var(--gold)' : isMiss ? 'var(--red)' : 'var(--green)';
        const fontSize  = isBonus ? 'var(--fs-lg)' : 'var(--fs-xxl)';
        return (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize, color, textShadow: `0 0 30px ${color}`, zIndex: 30, pointerEvents: 'none', opacity: 0.9, whiteSpace: 'nowrap' }}>
            {flashFeedback}
          </div>
        );
      })()}

      {/* ─── MENU ──────────────────────────────────── */}
      {phase === 'menu' && (
        <div style={{ zIndex: 1 }}>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--green)', marginBottom: 'var(--sp-xs)', textShadow: '0 0 20px rgba(0,255,65,0.5)' }}>REFLEX</h1>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--red)', marginBottom: 'var(--sp-md)', textShadow: '0 0 20px rgba(255,0,64,0.3)' }}>RUSH</h1>

          {rankLostAlert && (
            <div style={{ marginBottom: 'var(--sp-sm)', padding: 'var(--sp-xs) var(--sp-sm)', background: 'rgba(255,0,64,0.12)', boxShadow: '-2px 0 0 0 var(--red), 2px 0 0 0 var(--red), 0 -2px 0 0 var(--red), 0 2px 0 0 var(--red)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: 2 }}>⚠ {rankLostAlert}</p>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>HOLST DU DIR DEN PLATZ ZURUECK?</p>
            </div>
          )}

          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-md)', lineHeight: '2.2' }}>
            <p><span style={{ color: 'var(--green)' }}>GRUEN</span> = DRUECKEN</p>
            <p><span style={{ color: 'var(--red)' }}>ALLES ANDERE</span> = NICHT DRUECKEN</p>
            <p style={{ marginTop: 'var(--sp-xs)' }}>KOMME SO WEIT WIE MOEGLICH</p>
          </div>

          {bestLevel > 0 && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-sm)' }}>
              BESTES LEVEL: {bestLevel}
            </p>
          )}

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)' }}>[ TIPPEN / LEERTASTE ]</p>
        </div>
      )}

      {/* ─── COUNTDOWN ─────────────────────────────── */}
      {phase === 'countdown' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-sm)' }}>
            LEVEL 1 &middot; {levelConfig.name}
          </p>
          <p key={countdownNum} className="countdown-pop" style={{
            fontSize: 'var(--fs-xxl)',
            color: countdownNum === 0 ? 'var(--green)' : 'var(--text)',
            textShadow: countdownNum === 0 ? '0 0 30px var(--green)' : 'none',
          }}>
            {countdownNum === 0 ? 'GO!' : countdownNum}
          </p>
        </div>
      )}

      {/* ─── WAITING ───────────────────────────────── */}
      {phase === 'waiting' && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <p style={{ fontSize: 'var(--fs-md)', color: isTelegraphing ? 'var(--text)' : 'var(--text-dim)', transition: 'color 0.1s' }}>
            {isTelegraphing ? 'JETZT!' : 'WARTE...'}
          </p>
          <div
            className={isTelegraphing ? 'telegraph' : ''}
            style={{
              width: 'var(--sz-box-sm)', height: 'var(--sz-box-sm)', margin: 'var(--sp-md) auto',
              background: isTelegraphing ? 'var(--bg-light)' : 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: isTelegraphing
                ? undefined  // handled by .telegraph CSS animation
                : '-4px 0 0 0 var(--text-dim), 4px 0 0 0 var(--text-dim), 0 -4px 0 0 var(--text-dim), 0 4px 0 0 var(--text-dim)',
              transition: 'background 0.1s',
            }}
          >
            <span style={{ fontSize: 'var(--fs-lg)', color: isTelegraphing ? 'var(--text)' : 'var(--text-dim)', transition: 'color 0.1s' }}>?</span>
          </div>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-sm)' }}>NICHT ZU FRUEH DRUECKEN!</p>
        </div>
      )}

      {/* ─── STIMULUS ──────────────────────────────── */}
      {phase === 'stimulus' && !flashFeedback && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <div style={{
            width: 'var(--sz-box-lg)', height: 'var(--sz-box-lg)', margin: 'var(--sp-sm) auto',
            background: getStimulusColor(),
            boxShadow: `0 0 40px ${getStimulusColor()}, -4px 0 0 0 ${getStimulusColor()}, 4px 0 0 0 ${getStimulusColor()}, 0 -4px 0 0 ${getStimulusColor()}, 0 4px 0 0 ${getStimulusColor()}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: 'var(--fs-xxl)', color: getStimulusInnerColor() }}>{getStimulusSymbol()}</span>
          </div>
          <p style={{ fontSize: 'var(--fs-md)', color: getStimulusColor(), marginTop: 'var(--sp-sm)', textShadow: `0 0 10px ${getStimulusColor()}` }}>
            {getStimulusLabel()}
          </p>
        </div>
      )}

      {/* ─── LEVEL UP ──────────────────────────────── */}
      {phase === 'levelUp' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>LEVEL {currentLevel} GESCHAFFT!</p>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--gold)', textShadow: '0 0 20px rgba(255,215,0,0.5)', marginBottom: 'var(--sp-xs)' }}>{levelConfig.name}</p>
          <p style={{ fontSize: 'var(--fs-xxl)', color: 'var(--green)', margin: 'var(--sp-sm) 0' }}>
            LVL {currentLevel}
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
            Ø {levelAverageMs}ms IN DIESEM LEVEL
          </p>
          <div style={{
            margin: 'var(--sp-md) auto', padding: 'var(--sp-sm)', background: 'rgba(255,215,0,0.05)', maxWidth: '400px',
            boxShadow: '-2px 0 0 0 var(--gold), 2px 0 0 0 var(--gold), 0 -2px 0 0 var(--gold), 0 2px 0 0 var(--gold)',
          }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)' }}>NAECHSTES: {nextLevelConfig.name}</p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{nextLevelConfig.description}</p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>SICHTBAR: {nextLevelConfig.displayMs}ms</p>
          </div>
          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>[ TIPPEN / LEERTASTE ] WEITER</p>
        </div>
      )}

      {/* ─── FAILED ────────────────────────────────── */}
      {phase === 'failed' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--red)', textShadow: '0 0 20px rgba(255,0,64,0.5)' }}>FEHLSCHLAG!</p>
          <div style={{ margin: 'var(--sp-sm) auto', padding: 'var(--sp-xs) var(--sp-sm)', background: 'rgba(255,0,64,0.1)', maxWidth: '400px' }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: '2' }}>
              {stimulusType === 'red' ? 'BEI ROT GEDRUECKT!' : stimulusType === 'yellow' ? 'AUF GELB REINGEFALLEN!' : stimulusType === 'flash' ? 'AUF BLITZ REINGEFALLEN!' : stimulusType === 'gold' ? 'BEI GOLD NICHT GEDRUECKT!' : 'ZU FRUEH GEDRUECKT!'}
            </p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: '2' }}>LEVEL {currentLevel} &middot; ENDE</p>
          </div>
          {totalResults.length > 0 ? (
            <div style={{ marginTop: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-md)', color: 'var(--gold)' }}>LEVEL {currentLevel}</p>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)', marginBottom: 'var(--sp-xs)' }}>
                {totalResults.length} REAKTIONEN &middot; Ø {averageMs}ms
              </p>
              <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)' }}>[ TIPPEN / LEERTASTE ] SCORE SICHERN</p>
            </div>
          ) : (
            <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>[ TIPPEN / LEERTASTE ] NOCHMAL</p>
          )}
        </div>
      )}

      {/* ─── ROUND END ─────────────────────────────── */}
      {phase === 'roundEnd' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>ENDSTAND</p>
          <p style={{ fontSize: 'var(--fs-xxl)', color: 'var(--gold)', textShadow: '0 0 20px var(--gold)' }}>
            LEVEL {currentLevel}
          </p>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>
            Ø {averageMs}ms &middot; {totalResults.length} REAKTIONEN
          </p>

          {bestLevel > 0 && currentLevel > bestLevel && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gold)', marginTop: 'var(--sp-xs)', textShadow: '0 0 10px var(--gold)' }}>
              NEUES BESTES LEVEL!
            </p>
          )}

          {showNicknameInput && (
            <div style={{ marginTop: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>NICKNAME FUER LEADERBOARD:</p>
              <input
                ref={nicknameInputRef} type="text" value={nickname}
                onChange={(e) => setNickname(e.target.value.toUpperCase().slice(0, 12))}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitScore(); }}
                maxLength={12}
                style={{
                  background: 'var(--accent)', border: 'none', color: 'var(--green)',
                  fontFamily: "'Press Start 2P', monospace", fontSize: 'var(--fs-sm)',
                  padding: 'var(--sp-xs) var(--sp-sm)', textAlign: 'center',
                  width: 'var(--sz-input)', outline: 'none',
                  boxShadow: '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)',
                }}
                placeholder="___"
              />
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>
                {isSubmitting ? 'SPEICHERE...' : '[ ENTER ] ABSENDEN'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ─── LEADERBOARD ───────────────────────────── */}
      {phase === 'leaderboard' && (
        <div style={{ zIndex: 1, maxWidth: 'clamp(320px, 80vw, 500px)', width: '100%' }}>
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--gold)', marginBottom: '4px' }}>LEADERBOARD</p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-sm)' }}>DIESE WOCHE</p>

          {overtakenNick && (
            <div style={{ marginBottom: 'var(--sp-sm)', padding: 'var(--sp-xs) var(--sp-sm)', background: 'rgba(0,255,65,0.08)', boxShadow: '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--green)' }}>DU HAST {overtakenNick} UEBERHOLT!</p>
            </div>
          )}

          {nearMissInfo && (
            <p className="near-miss" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)' }}>{nearMissInfo}</p>
          )}

          {scoreDelta !== null && (
            <p style={{ fontSize: 'var(--fs-xs)', color: scoreDelta > 0 ? 'var(--green)' : 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
              {scoreDelta > 0 ? `+${scoreDelta} LEVEL vs. BESTLEISTUNG!` : scoreDelta === 0 ? 'GLEICH WIE BESTLEISTUNG' : `${scoreDelta} LEVEL vs. BESTLEISTUNG`}
            </p>
          )}

          <div style={{ textAlign: 'left' }}>
            {leaderboard.length === 0 && (
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', textAlign: 'center' }}>KEINE EINTRAEGE DIESE WOCHE</p>
            )}
            {leaderboard.map((entry, i) => {
              const isPlayer = playerRank !== null && i === playerRank - 1;
              const rankColor = i === 0 ? 'var(--gold)' : i === 1 ? 'var(--silver)' : i === 2 ? 'var(--bronze)' : 'var(--text-dim)';
              return (
                <div key={entry.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: 'var(--sp-xs) var(--sp-sm)', marginBottom: '4px',
                  background: isPlayer ? 'rgba(0,255,65,0.1)' : 'transparent',
                  boxShadow: isPlayer ? '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)' : 'none',
                  animation: `slide-in 0.3s ease-out ${i * 0.05}s both`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
                    <span style={{ fontSize: 'var(--fs-sm)', color: rankColor, minWidth: '2.5em' }}>{i === 0 ? '>>>' : `#${i + 1}`}</span>
                    <span style={{ fontSize: 'var(--fs-xs)', color: isPlayer ? 'var(--green)' : 'var(--text)' }}>{entry.nickname}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
                    <span style={{ fontSize: 'var(--fs-sm)', color: isPlayer ? 'var(--green)' : rankColor }}>
                      LVL {entry.max_level}
                    </span>
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                      {entry.average_ms}ms
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 'var(--sp-sm)', padding: 'var(--sp-xs)', background: 'rgba(0,255,65,0.05)' }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              LVL {currentLevel} &middot; Ø {averageMs}ms {playerRank ? `&middot; PLATZ ${playerRank}` : ''}
            </p>
          </div>

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>[ TIPPEN / LEERTASTE ] NOCHMAL</p>
        </div>
      )}

      {/* Streak */}
      {streakCount > 0 && (phase === 'menu' || phase === 'leaderboard') && (
        <div style={{ position: 'absolute', top: 'var(--sp-sm)', right: 'var(--sp-sm)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', zIndex: 20 }}>
          STREAK {streakCount}
        </div>
      )}
    </div>
  );
}
