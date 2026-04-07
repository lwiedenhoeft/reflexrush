'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { submitScoreWithOvertake, getCurrentRank, type LeaderboardEntry } from '@/lib/supabase';
import {
  type StimulusType, type LevelConfig, type Distraction,
  getLevelConfig, pickStimulus, getWaitTime,
  ROUNDS_PER_LEVEL,
} from '@/lib/levels';
import {
  getLeague, getMsToNextLeague,
  saveNickname, loadNickname,
  saveLastRank, loadLastRank,
  saveLastScore, loadLastScore, getDelta,
} from '@/lib/leagues';

// ─── TYPES ──────────────────────────────────────────────
type GamePhase =
  | 'menu'
  | 'countdown'
  | 'waiting'
  | 'stimulus'
  | 'result'
  | 'levelUp'
  | 'roundEnd'
  | 'failed'
  | 'leaderboard';

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
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }

  countdown() { this.playTone(440, 0.15, 'square', 0.12); }
  countdownGo() { this.playTone(880, 0.25, 'square', 0.15); }
  menuSelect() { this.playTone(600, 0.08, 'square', 0.08); }
  goodReaction() {
    this.playTone(660, 0.08, 'square', 0.12);
    setTimeout(() => this.playTone(880, 0.12, 'square', 0.12), 80);
  }
  greatReaction() {
    this.playTone(660, 0.06, 'square', 0.15);
    setTimeout(() => this.playTone(880, 0.06, 'square', 0.15), 60);
    setTimeout(() => this.playTone(1100, 0.15, 'square', 0.15), 120);
  }
  fail() {
    this.playTone(220, 0.3, 'sawtooth', 0.15);
    setTimeout(() => this.playTone(165, 0.4, 'sawtooth', 0.12), 150);
  }
  nearMiss() {
    this.playTone(440, 0.1, 'square', 0.1);
    setTimeout(() => this.playTone(550, 0.1, 'square', 0.1), 100);
    setTimeout(() => this.playTone(440, 0.15, 'square', 0.12), 200);
  }
  newRecord() {
    [523, 659, 784, 1047].forEach((n, i) =>
      setTimeout(() => this.playTone(n, 0.15, 'square', 0.12), i * 120)
    );
  }
  levelUp() {
    [440, 554, 659, 880].forEach((n, i) =>
      setTimeout(() => this.playTone(n, 0.2, 'square', 0.15), i * 150)
    );
  }
  overtake() {
    [600, 750, 900].forEach((n, i) =>
      setTimeout(() => this.playTone(n, 0.12, 'square', 0.14), i * 100)
    );
  }
  rankLost() {
    [400, 320, 240].forEach((n, i) =>
      setTimeout(() => this.playTone(n, 0.2, 'sawtooth', 0.12), i * 120)
    );
  }
}

// ─── CONSTANTS ──────────────────────────────────────────
const COUNTDOWN_SECS = 3;

// ─── MAIN COMPONENT ────────────────────────────────────
export default function ReflexRush() {
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [currentLevel, setCurrentLevel] = useState(1);
  const [currentRound, setCurrentRound] = useState(0);
  const [totalResults, setTotalResults] = useState<RoundResult[]>([]);
  const [levelResults, setLevelResults] = useState<RoundResult[]>([]);
  const [stimulusType, setStimulusType] = useState<StimulusType>('green');
  const [activeDistraction, setActiveDistraction] = useState<Distraction | null>(null);
  const [countdownNum, setCountdownNum] = useState(COUNTDOWN_SECS);
  const [reactionTime, setReactionTime] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [nickname, setNickname] = useState('');
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [playerRank, setPlayerRank] = useState<number | null>(null);
  const [nearMissInfo, setNearMissInfo] = useState<string | null>(null);
  const [showNicknameInput, setShowNicknameInput] = useState(false);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [streakCount, setStreakCount] = useState(0);
  const [highestLevel, setHighestLevel] = useState(1);

  // ── New: psychological mechanics ──
  const [overtakenNick, setOvertakenNick] = useState<string | null>(null);
  const [rankLostAlert, setRankLostAlert] = useState<string | null>(null); // Verlustaversion
  const [scoreDelta, setScoreDelta] = useState<number | null>(null);       // personal delta
  const [isSubmitting, setIsSubmitting] = useState(false);

  const stimulusTimeRef = useRef(0);
  const waitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<ChiptuneAudio | null>(null);
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const hasRespondedRef = useRef(false);
  const levelConfigRef = useRef<LevelConfig>(getLevelConfig(1));

  // ─── INIT: load persisted data + Verlustaversion check ──
  useEffect(() => {
    audioRef.current = new ChiptuneAudio();

    const savedNick = loadNickname();
    if (savedNick) {
      setNickname(savedNick);
      // Verlustaversion: check if rank was lost since last visit
      const savedRank = loadLastRank();
      if (savedRank !== null) {
        getCurrentRank(savedNick).then(currentRank => {
          if (currentRank !== null && currentRank > savedRank) {
            setRankLostAlert(
              `PLATZ ${savedRank} VERLOREN → JETZT #${currentRank}`
            );
            audioRef.current?.rankLost();
          }
        });
      }
    }

    const lastScore = loadLastScore();
    if (lastScore !== null) setBestScore(lastScore);
  }, []);

  useEffect(() => {
    levelConfigRef.current = getLevelConfig(currentLevel);
  }, [currentLevel]);

  const clearTimers = useCallback(() => {
    if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    waitTimerRef.current = null;
    timeoutTimerRef.current = null;
  }, []);

  const triggerShake = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 300);
  }, []);

  // ─── SHOW STIMULUS ───────────────────────────────────
  const showStimulus = useCallback(() => {
    const config = levelConfigRef.current;
    const { type, distraction } = pickStimulus(config);
    setStimulusType(type);
    setActiveDistraction(distraction || null);
    setPhase('stimulus');
    stimulusTimeRef.current = performance.now();
    hasRespondedRef.current = false;

    if (type === 'green') {
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          setReactionTime(config.timeoutMs);
          const result = { reactionMs: config.timeoutMs, level: config.level };
          setLevelResults(prev => [...prev, result]);
          setTotalResults(prev => [...prev, result]);
          setPhase('result');
        }
      }, config.timeoutMs);
    } else {
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          setPhase('waiting');
          const waitMs = getWaitTime(config);
          waitTimerRef.current = setTimeout(() => showStimulus(), waitMs);
        }
      }, config.timeoutMs);
    }
  }, []);

  // ─── ADVANCE ROUND ───────────────────────────────────
  const advanceRound = useCallback(() => {
    clearTimers();
    const config = levelConfigRef.current;
    setCurrentRound(prev => {
      const next = prev + 1;
      if (next >= ROUNDS_PER_LEVEL) {
        setPhase('levelUp');
        return prev;
      }
      setPhase('waiting');
      waitTimerRef.current = setTimeout(() => showStimulus(), getWaitTime(config));
      return next;
    });
  }, [clearTimers, showStimulus]);

  // ─── NEXT LEVEL ──────────────────────────────────────
  const goToNextLevel = useCallback(() => {
    clearTimers();
    const nextLevel = currentLevel + 1;
    setCurrentLevel(nextLevel);
    setCurrentRound(0);
    setLevelResults([]);
    if (nextLevel > highestLevel) setHighestLevel(nextLevel);
    audioRef.current?.levelUp();
    setPhase('waiting');
    const config = getLevelConfig(nextLevel);
    waitTimerRef.current = setTimeout(() => showStimulus(), getWaitTime(config));
  }, [currentLevel, highestLevel, clearTimers, showStimulus]);

  // ─── END RUN ─────────────────────────────────────────
  const endRun = useCallback(() => {
    setShowNicknameInput(true);
    setPhase('roundEnd');
    setTimeout(() => nicknameInputRef.current?.focus(), 100);
  }, []);

  // ─── START GAME ──────────────────────────────────────
  const startGame = useCallback(() => {
    clearTimers();
    setTotalResults([]);
    setLevelResults([]);
    setCurrentRound(0);
    setCurrentLevel(1);
    setReactionTime(0);
    setNearMissInfo(null);
    setPlayerRank(null);
    setActiveDistraction(null);
    setOvertakenNick(null);
    setRankLostAlert(null);
    setScoreDelta(null);
    setPhase('countdown');
    setCountdownNum(COUNTDOWN_SECS);
    levelConfigRef.current = getLevelConfig(1);
    audioRef.current?.menuSelect();

    let count = COUNTDOWN_SECS;
    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        setCountdownNum(count);
        audioRef.current?.countdown();
      } else if (count === 0) {
        setCountdownNum(0);
        audioRef.current?.countdownGo();
      } else {
        clearInterval(interval);
        setPhase('waiting');
        const config = getLevelConfig(1);
        waitTimerRef.current = setTimeout(() => showStimulus(), getWaitTime(config));
      }
    }, 900);
  }, [clearTimers, showStimulus]);

  // ─── INPUT HANDLER ───────────────────────────────────
  const handleInput = useCallback(() => {
    if (showNicknameInput) return;

    switch (phase) {
      case 'menu':
      case 'leaderboard':
        startGame();
        break;

      case 'stimulus':
        if (hasRespondedRef.current) return;
        hasRespondedRef.current = true;
        clearTimers();
        if (stimulusType !== 'green') {
          audioRef.current?.fail();
          triggerShake();
          setStreakCount(0);
          setPhase('failed');
        } else {
          const rt = Math.round(performance.now() - stimulusTimeRef.current);
          setReactionTime(rt);
          const result = { reactionMs: rt, level: currentLevel };
          setLevelResults(prev => [...prev, result]);
          setTotalResults(prev => [...prev, result]);
          if (rt < 200) audioRef.current?.greatReaction();
          else audioRef.current?.goodReaction();
          triggerShake();
          setPhase('result');
        }
        break;

      case 'waiting':
        clearTimers();
        audioRef.current?.fail();
        triggerShake();
        setStreakCount(0);
        setPhase('failed');
        break;

      case 'result':
        advanceRound();
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
  }, [phase, stimulusType, currentLevel, totalResults, startGame, advanceRound, clearTimers, triggerShake, showNicknameInput, goToNextLevel, endRun]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      handleInput();
    };
    const handleTouchStart = (e: TouchEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      e.preventDefault();
      handleInput();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('touchstart', handleTouchStart, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('touchstart', handleTouchStart);
    };
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
  const currentLeague = getLeague(averageMs || 999);
  const msToNext = averageMs ? getMsToNextLeague(averageMs) : null;

  // ─── SUBMIT SCORE ────────────────────────────────────
  const handleSubmitScore = async () => {
    if (!nickname.trim() || isSubmitting) return;
    setIsSubmitting(true);
    const nick = nickname.trim().toUpperCase().slice(0, 12);
    setNickname(nick);
    saveNickname(nick);
    setShowNicknameInput(false);

    // Personal delta
    const delta = getDelta(averageMs);
    setScoreDelta(delta);
    saveLastScore(averageMs);

    // Personal best
    if (bestScore === null || averageMs < bestScore) {
      setBestScore(averageMs);
      audioRef.current?.newRecord();
    }
    setStreakCount(prev => prev + 1);

    // Submit and get overtake info
    const result = await submitScoreWithOvertake(nick, averageMs);
    setLeaderboard(result.leaderboard);
    setPlayerRank(result.newRank);

    // Overtake moment
    if (result.overtakenNick) {
      setOvertakenNick(result.overtakenNick);
      audioRef.current?.overtake();
    }

    // Near-miss
    const newIdx = result.newRank !== null ? result.newRank - 1 : -1;
    if (newIdx > 0) {
      const diff = averageMs - result.leaderboard[newIdx - 1].average_ms;
      if (diff <= 15 && diff > 0) {
        setNearMissInfo(`Nur ${diff}ms bis ${result.leaderboard[newIdx - 1].nickname}!`);
        audioRef.current?.nearMiss();
      }
    }

    // Save rank for Verlustaversion next session
    if (result.newRank !== null) saveLastRank(result.newRank);

    setIsSubmitting(false);
    setPhase('leaderboard');
  };

  // ─── STIMULUS HELPERS ────────────────────────────────
  const getStimulusColor = () => {
    if (stimulusType === 'green') return 'var(--green)';
    if (stimulusType === 'red') return 'var(--red)';
    return activeDistraction?.color ?? 'var(--red)';
  };
  const getStimulusInnerColor = () => {
    if (stimulusType === 'green') return '#001a00';
    if (stimulusType === 'red') return '#1a0000';
    return activeDistraction?.innerColor ?? '#1a0000';
  };
  const getStimulusSymbol = () => {
    if (stimulusType === 'green') return '!';
    if (stimulusType === 'red') return 'X';
    return activeDistraction?.symbol ?? 'X';
  };
  const getStimulusLabel = () => {
    if (stimulusType === 'green') return 'JETZT!';
    if (stimulusType === 'red') return 'WARTE!';
    return activeDistraction?.label ?? 'WARTE!';
  };
  const getStimulusBg = () => {
    if (stimulusType === 'green') return 'radial-gradient(circle, #003300 0%, #001a00 50%, var(--bg) 100%)';
    if (stimulusType === 'red') return 'radial-gradient(circle, #330000 0%, #1a0000 50%, var(--bg) 100%)';
    if (stimulusType === 'yellow') return 'radial-gradient(circle, #332b00 0%, #1a1500 50%, var(--bg) 100%)';
    if (stimulusType === 'flash') return 'radial-gradient(circle, #003344 0%, #001a22 50%, var(--bg) 100%)';
    return 'var(--bg)';
  };

  // ─── RENDER HELPERS ──────────────────────────────────
  const renderProgressDots = () => (
    <div style={{ display: 'flex', gap: 'var(--sp-xs)', justifyContent: 'center', marginBottom: 'var(--sp-sm)' }}>
      {Array.from({ length: ROUNDS_PER_LEVEL }).map((_, i) => (
        <div key={i} style={{
          width: 'var(--sz-dot)', height: 'var(--sz-dot)',
          background: i < levelResults.length ? 'var(--green)'
            : (i === currentRound && stimulusType === 'green') ? 'var(--gold)'
              : 'var(--accent)',
          boxShadow: (i === currentRound && stimulusType === 'green') ? '0 0 8px var(--gold)' : 'none',
          transition: 'all 0.2s',
        }} />
      ))}
    </div>
  );

  const renderLeagueBadge = (ms: number, small = false) => {
    const lg = getLeague(ms);
    return (
      <span style={{
        color: lg.color,
        fontSize: small ? 'var(--fs-xs)' : 'var(--fs-sm)',
        textShadow: `0 0 8px ${lg.color}44`,
      }}>
        [{lg.name}]
      </span>
    );
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100vh', padding: '24px',
    textAlign: 'center', position: 'relative', overflow: 'hidden',
    background: phase === 'stimulus' ? getStimulusBg() : 'var(--bg)',
    transition: 'background 0.1s',
  };

  return (
    <div className={shaking ? 'shake' : ''} style={containerStyle}>
      {/* Scanline */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)',
        pointerEvents: 'none', zIndex: 10,
      }} />

      {/* Level badge */}
      {['waiting', 'stimulus', 'result'].includes(phase) && (
        <div style={{ position: 'absolute', top: 'var(--sp-sm)', left: 'var(--sp-sm)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', zIndex: 20 }}>
          LVL {currentLevel}
        </div>
      )}

      {/* ─── MENU ──────────────────────────────────── */}
      {phase === 'menu' && (
        <div style={{ zIndex: 1 }}>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--green)', marginBottom: 'var(--sp-xs)', textShadow: '0 0 20px rgba(0,255,65,0.5)' }}>REFLEX</h1>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--red)', marginBottom: 'var(--sp-md)', textShadow: '0 0 20px rgba(255,0,64,0.3)' }}>RUSH</h1>

          {/* Verlustaversion alert */}
          {rankLostAlert && (
            <div style={{
              marginBottom: 'var(--sp-sm)', padding: 'var(--sp-xs) var(--sp-sm)',
              background: 'rgba(255,0,64,0.12)',
              boxShadow: '-2px 0 0 0 var(--red), 2px 0 0 0 var(--red), 0 -2px 0 0 var(--red), 0 2px 0 0 var(--red)',
            }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: 2 }}>
                ⚠ {rankLostAlert}
              </p>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                HOLST DU DIR DEN PLATZ ZURUECK?
              </p>
            </div>
          )}

          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-md)', lineHeight: '2.2' }}>
            <p><span style={{ color: 'var(--green)' }}>GRUEN</span> = DRUECKEN</p>
            <p><span style={{ color: 'var(--red)' }}>ALLES ANDERE</span> = NICHT DRUECKEN</p>
            <p style={{ marginTop: 'var(--sp-xs)' }}>5 RUNDEN PRO LEVEL &middot; WERDE SCHNELLER</p>
          </div>

          {/* Liga-Info */}
          {bestScore !== null && (
            <div style={{ marginBottom: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                BEST {bestScore}ms &nbsp;{renderLeagueBadge(bestScore, true)}&nbsp; LVL {highestLevel}
              </p>
            </div>
          )}

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)' }}>
            [ TIPPEN / LEERTASTE ]
          </p>
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
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-dim)' }}>WARTE...</p>
          <div style={{
            width: 'var(--sz-box-sm)', height: 'var(--sz-box-sm)',
            margin: 'var(--sp-md) auto', background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '-4px 0 0 0 var(--text-dim), 4px 0 0 0 var(--text-dim), 0 -4px 0 0 var(--text-dim), 0 4px 0 0 var(--text-dim)',
          }}>
            <span style={{ fontSize: 'var(--fs-lg)', color: 'var(--text-dim)' }}>?</span>
          </div>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-sm)' }}>
            NICHT ZU FRUEH DRUECKEN!
          </p>
        </div>
      )}

      {/* ─── STIMULUS ──────────────────────────────── */}
      {phase === 'stimulus' && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <div style={{
            width: 'var(--sz-box-lg)', height: 'var(--sz-box-lg)',
            margin: 'var(--sp-sm) auto',
            background: getStimulusColor(),
            boxShadow: `0 0 40px ${getStimulusColor()}, -4px 0 0 0 ${getStimulusColor()}, 4px 0 0 0 ${getStimulusColor()}, 0 -4px 0 0 ${getStimulusColor()}, 0 4px 0 0 ${getStimulusColor()}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.05s',
          }}>
            <span style={{ fontSize: 'var(--fs-xxl)', color: getStimulusInnerColor() }}>
              {getStimulusSymbol()}
            </span>
          </div>
          <p style={{ fontSize: 'var(--fs-md)', color: getStimulusColor(), marginTop: 'var(--sp-sm)', textShadow: `0 0 10px ${getStimulusColor()}` }}>
            {getStimulusLabel()}
          </p>
        </div>
      )}

      {/* ─── RESULT ────────────────────────────────── */}
      {phase === 'result' && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <p style={{
            fontSize: 'var(--fs-xxl)',
            color: reactionTime < 200 ? 'var(--gold)' : reactionTime < 300 ? 'var(--green)' : 'var(--text)',
            textShadow: reactionTime < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {reactionTime}<span style={{ fontSize: 'var(--fs-sm)' }}>ms</span>
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>
            {reactionTime < 150 ? 'UNMENSCHLICH!' : reactionTime < 200 ? 'BLITZSCHNELL!' : reactionTime < 250 ? 'SCHNELL!' : reactionTime < 350 ? 'SOLIDE' : 'LANGSAM...'}
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] WEITER
          </p>
        </div>
      )}

      {/* ─── LEVEL UP ──────────────────────────────── */}
      {phase === 'levelUp' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
            LEVEL {currentLevel} GESCHAFFT!
          </p>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--gold)', textShadow: '0 0 20px rgba(255,215,0,0.5)', marginBottom: 'var(--sp-xs)' }}>
            {levelConfig.name}
          </p>
          <p style={{ fontSize: 'var(--fs-xxl)', color: 'var(--green)', margin: 'var(--sp-sm) 0' }}>
            {levelAverageMs}<span style={{ fontSize: 'var(--fs-sm)' }}>ms</span>
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>LEVEL-DURCHSCHNITT</p>
          <div style={{
            margin: 'var(--sp-md) auto', padding: 'var(--sp-sm)',
            background: 'rgba(255,215,0,0.05)', maxWidth: '400px',
            boxShadow: '-2px 0 0 0 var(--gold), 2px 0 0 0 var(--gold), 0 -2px 0 0 var(--gold), 0 2px 0 0 var(--gold)',
          }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)' }}>
              NAECHSTES LEVEL: {nextLevelConfig.name}
            </p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{nextLevelConfig.description}</p>
          </div>
          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] WEITER
          </p>
        </div>
      )}

      {/* ─── FAILED ────────────────────────────────── */}
      {phase === 'failed' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--red)', textShadow: '0 0 20px rgba(255,0,64,0.5)' }}>FEHLSCHLAG!</p>
          <div style={{ margin: 'var(--sp-sm) auto', padding: 'var(--sp-xs) var(--sp-sm)', background: 'rgba(255,0,64,0.1)', maxWidth: '400px' }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: '2' }}>
              {stimulusType === 'red' ? 'BEI ROT GEDRUECKT!' : stimulusType === 'yellow' ? 'AUF GELB REINGEFALLEN!' : stimulusType === 'flash' ? 'AUF BLITZ REINGEFALLEN!' : 'ZU FRUEH GEDRUECKT!'}
            </p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: '2' }}>LEVEL {currentLevel} &middot; RUNDE UNGUELTIG</p>
          </div>
          {totalResults.length > 0 ? (
            <div style={{ marginTop: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
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
          <p style={{
            fontSize: 'var(--fs-xxl)',
            color: averageMs < 200 ? 'var(--gold)' : averageMs < 280 ? 'var(--green)' : 'var(--text)',
            textShadow: averageMs < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {averageMs}<span style={{ fontSize: 'var(--fs-sm)' }}>ms</span>
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: '4px', marginBottom: 'var(--sp-xs)' }}>
            {renderLeagueBadge(averageMs)} &nbsp; {totalResults.length} REAKTIONEN &middot; LVL {currentLevel}
          </p>

          {/* Individual times */}
          <div style={{ display: 'flex', gap: 'var(--sp-xs)', justifyContent: 'center', margin: 'var(--sp-sm) 0', flexWrap: 'wrap' }}>
            {totalResults.map((r, i) => (
              <span key={i} style={{ fontSize: 'var(--fs-xs)', color: r.reactionMs < 200 ? 'var(--gold)' : 'var(--green)' }}>
                {r.reactionMs}
              </span>
            ))}
          </div>

          {showNicknameInput && (
            <div style={{ marginTop: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
                NICKNAME FUER LEADERBOARD:
              </p>
              <input
                ref={nicknameInputRef}
                type="text"
                value={nickname}
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

          {/* Overtake moment (Soziale Vergleichstheorie) */}
          {overtakenNick && (
            <div style={{
              marginBottom: 'var(--sp-sm)', padding: 'var(--sp-xs) var(--sp-sm)',
              background: 'rgba(0,255,65,0.08)',
              boxShadow: '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)',
            }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--green)' }}>
                DU HAST {overtakenNick} UEBERHOLT!
              </p>
            </div>
          )}

          {/* Near-miss */}
          {nearMissInfo && (
            <p className="near-miss" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)' }}>
              {nearMissInfo}
            </p>
          )}

          {/* Personal delta (Quantifizierbare Selbstwirksamkeit) */}
          {scoreDelta !== null && (
            <p style={{ fontSize: 'var(--fs-xs)', color: scoreDelta < 0 ? 'var(--green)' : 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
              {scoreDelta < 0 ? `${scoreDelta}ms PERSOENLICHE BESTZEIT!` : `+${scoreDelta}ms vs. BESTZEIT`}
            </p>
          )}

          {/* Liga + ms to next (Gestaffelte Mikro-Ziele) */}
          {playerRank !== null && (
            <div style={{
              marginBottom: 'var(--sp-sm)', padding: 'var(--sp-xs) var(--sp-sm)',
              background: `${currentLeague.color}11`,
              boxShadow: `-2px 0 0 0 ${currentLeague.color}, 2px 0 0 0 ${currentLeague.color}, 0 -2px 0 0 ${currentLeague.color}, 0 2px 0 0 ${currentLeague.color}`,
            }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: currentLeague.color }}>
                LIGA: {currentLeague.name}
              </p>
              {msToNext !== null && currentLeague.nextName && (
                <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
                  NOCH {msToNext}ms BIS {currentLeague.nextName}
                </p>
              )}
            </div>
          )}

          {/* Entries */}
          <div style={{ textAlign: 'left' }}>
            {leaderboard.length === 0 && (
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', textAlign: 'center' }}>KEINE EINTRAEGE DIESE WOCHE</p>
            )}
            {leaderboard.map((entry, i) => {
              const isPlayer = playerRank !== null && i === playerRank - 1;
              const rankColor = i === 0 ? 'var(--gold)' : i === 1 ? 'var(--silver)' : i === 2 ? 'var(--bronze)' : 'var(--text-dim)';
              const lg = getLeague(entry.average_ms);
              return (
                <div key={entry.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: 'var(--sp-xs) var(--sp-sm)', marginBottom: '4px',
                  background: isPlayer ? 'rgba(0,255,65,0.1)' : 'transparent',
                  boxShadow: isPlayer ? '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)' : 'none',
                  animation: `slide-in 0.3s ease-out ${i * 0.05}s both`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
                    <span style={{ fontSize: 'var(--fs-sm)', color: rankColor, minWidth: '2.5em' }}>
                      {i === 0 ? '>>>' : `#${i + 1}`}
                    </span>
                    <span style={{ fontSize: 'var(--fs-xs)', color: isPlayer ? 'var(--green)' : 'var(--text)' }}>
                      {entry.nickname}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
                    <span style={{ fontSize: 'var(--fs-xs)', color: lg.color }}>{lg.name}</span>
                    <span style={{ fontSize: 'var(--fs-sm)', color: isPlayer ? 'var(--green)' : rankColor }}>
                      {entry.average_ms}ms
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 'var(--sp-sm)', padding: 'var(--sp-xs)', background: 'rgba(0,255,65,0.05)' }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              {averageMs}ms &middot; {playerRank ? `PLATZ ${playerRank}` : ''} &middot; LVL {currentLevel}
            </p>
          </div>

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] NOCHMAL
          </p>
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
