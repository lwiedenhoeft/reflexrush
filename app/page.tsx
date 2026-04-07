'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { submitScore, getLeaderboard, type LeaderboardEntry } from '@/lib/supabase';

// ─── TYPES ──────────────────────────────────────────────
type GamePhase =
  | 'menu'
  | 'countdown'
  | 'waiting'    // waiting for stimulus
  | 'stimulus'   // GREEN or RED shown
  | 'result'     // single reaction result
  | 'roundEnd'   // 5-round summary
  | 'failed'     // pressed on red
  | 'leaderboard';

type StimulusType = 'green' | 'red';

interface RoundResult {
  reactionMs: number;
  stimulusType: StimulusType;
}

// ─── SOUND ENGINE (Web Audio API Chiptune) ──────────────
class ChiptuneAudio {
  private ctx: AudioContext | null = null;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
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

  countdown() {
    this.playTone(440, 0.15, 'square', 0.12);
  }

  countdownGo() {
    this.playTone(880, 0.25, 'square', 0.15);
  }

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
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => {
      setTimeout(() => this.playTone(n, 0.15, 'square', 0.12), i * 120);
    });
  }

  menuSelect() {
    this.playTone(600, 0.08, 'square', 0.08);
  }
}

// ─── CONSTANTS ──────────────────────────────────────────
const ROUNDS_PER_GAME = 5;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 4000;
const STIMULUS_TIMEOUT_MS = 1000;
const RED_CHANCE = 0.3; // 30% chance of red stimulus
const COUNTDOWN_SECS = 3;

// ─── MAIN COMPONENT ────────────────────────────────────
export default function ReflexRush() {
  const [phase, setPhase] = useState<GamePhase>('menu');
  const [currentRound, setCurrentRound] = useState(0);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [stimulusType, setStimulusType] = useState<StimulusType>('green');
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

  const stimulusTimeRef = useRef(0);
  const waitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<ChiptuneAudio | null>(null);
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const hasRespondedRef = useRef(false);

  // Initialize audio
  useEffect(() => {
    audioRef.current = new ChiptuneAudio();
    // Load saved nickname
    const saved = typeof window !== 'undefined' ? window.sessionStorage?.getItem?.('reflexrush_nick') : null;
    if (saved) setNickname(saved);
  }, []);

  // ─── CLEANUP TIMERS ──────────────────────────────────
  const clearTimers = useCallback(() => {
    if (waitTimerRef.current) clearTimeout(waitTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    waitTimerRef.current = null;
    timeoutTimerRef.current = null;
  }, []);

  // ─── TRIGGER SCREENSHAKE ─────────────────────────────
  const triggerShake = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 300);
  }, []);

  // ─── SHOW STIMULUS ───────────────────────────────────
  const showStimulus = useCallback(() => {
    const isRed = Math.random() < RED_CHANCE;
    const type: StimulusType = isRed ? 'red' : 'green';
    setStimulusType(type);
    setPhase('stimulus');
    stimulusTimeRef.current = performance.now();
    hasRespondedRef.current = false;

    // Timeout: if green and no response, count as max time
    if (type === 'green') {
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          setReactionTime(STIMULUS_TIMEOUT_MS);
          setResults(prev => [...prev, { reactionMs: STIMULUS_TIMEOUT_MS, stimulusType: 'green' }]);
          setPhase('result');
        }
      }, STIMULUS_TIMEOUT_MS);
    } else {
      // Red: correctly ignored → show next stimulus WITHOUT counting this as a round
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          setPhase('waiting');
          const waitMs = MIN_WAIT_MS + Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS);
          waitTimerRef.current = setTimeout(() => {
            showStimulus();
          }, waitMs);
        }
      }, STIMULUS_TIMEOUT_MS);
    }
  }, []);

  // ─── ADVANCE TO NEXT ROUND ──────────────────────────
  const advanceRound = useCallback(() => {
    clearTimers();
    setCurrentRound(prev => {
      const next = prev + 1;
      if (next >= ROUNDS_PER_GAME) {
        setPhase('roundEnd');
        return prev;
      }
      // Start next stimulus after brief pause
      setPhase('waiting');
      const waitMs = MIN_WAIT_MS + Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS);
      waitTimerRef.current = setTimeout(() => {
        showStimulus();
      }, waitMs);
      return next;
    });
  }, [clearTimers, showStimulus]);

  // ─── START GAME ──────────────────────────────────────
  const startGame = useCallback(() => {
    clearTimers();
    setResults([]);
    setCurrentRound(0);
    setReactionTime(0);
    setNearMissInfo(null);
    setPlayerRank(null);
    setPhase('countdown');
    setCountdownNum(COUNTDOWN_SECS);

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
        const waitMs = MIN_WAIT_MS + Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS);
        waitTimerRef.current = setTimeout(() => {
          showStimulus();
        }, waitMs);
      }
    }, 900);
  }, [clearTimers, showStimulus]);

  // ─── SHARED INPUT HANDLER (Spacebar + Touch) ─────────
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

        if (stimulusType === 'red') {
          audioRef.current?.fail();
          triggerShake();
          setStreakCount(0);
          setPhase('failed');
        } else {
          const rt = Math.round(performance.now() - stimulusTimeRef.current);
          setReactionTime(rt);
          setResults(prev => [...prev, { reactionMs: rt, stimulusType: 'green' }]);
          if (rt < 200) {
            audioRef.current?.greatReaction();
          } else {
            audioRef.current?.goodReaction();
          }
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
        startGame();
        break;

      case 'roundEnd':
        setShowNicknameInput(true);
        setTimeout(() => nicknameInputRef.current?.focus(), 100);
        break;
    }
  }, [phase, stimulusType, startGame, advanceRound, clearTimers, triggerShake, showNicknameInput]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      handleInput();
    };

    const handleTouchStart = (e: TouchEvent) => {
      // Ignore touches on the nickname input
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

  // ─── COMPUTE AVERAGE ─────────────────────────────────
  const averageMs = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.reactionMs, 0) / results.length)
    : 0;

  // ─── SUBMIT SCORE ────────────────────────────────────
  const handleSubmitScore = async () => {
    if (!nickname.trim()) return;

    const nick = nickname.trim().toUpperCase().slice(0, 12);
    setNickname(nick);
    if (typeof window !== 'undefined') {
      window.sessionStorage?.setItem?.('reflexrush_nick', nick);
    }
    setShowNicknameInput(false);

    // Update best score & streak
    if (bestScore === null || averageMs < bestScore) {
      setBestScore(averageMs);
      audioRef.current?.newRecord();
    }
    setStreakCount(prev => prev + 1);

    // Submit to Supabase
    await submitScore(nick, averageMs);
    const lb = await getLeaderboard();
    setLeaderboard(lb);

    // Find player rank
    const rank = lb.findIndex(e => e.nickname === nick);
    setPlayerRank(rank >= 0 ? rank + 1 : null);

    // Near-miss detection
    if (rank > 0) {
      const diff = averageMs - lb[rank - 1].average_ms;
      if (diff <= 15 && diff > 0) {
        setNearMissInfo(`Nur ${diff}ms bis Platz ${rank}!`);
        audioRef.current?.nearMiss();
      }
    }

    setPhase('leaderboard');
  };

  // ─── RENDER ──────────────────────────────────────────
  const renderProgressDots = () => (
    <div style={{ display: 'flex', gap: 'var(--sp-xs)', justifyContent: 'center', marginBottom: 'var(--sp-sm)' }}>
      {Array.from({ length: ROUNDS_PER_GAME }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 'var(--sz-dot)',
            height: 'var(--sz-dot)',
            // During a red stimulus, don't highlight the current round dot (red is not a real attempt)
            background: i < results.length ? 'var(--green)' : (i === currentRound && stimulusType !== 'red') ? 'var(--gold)' : 'var(--accent)',
            boxShadow: (i === currentRound && stimulusType !== 'red') ? '0 0 8px var(--gold)' : 'none',
            transition: 'all 0.2s',
          }}
        />
      ))}
    </div>
  );

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    padding: '24px',
    textAlign: 'center',
    position: 'relative',
    overflow: 'hidden',
    background:
      phase === 'stimulus' && stimulusType === 'green'
        ? 'radial-gradient(circle, #003300 0%, #001a00 50%, var(--bg) 100%)'
        : phase === 'stimulus' && stimulusType === 'red'
          ? 'radial-gradient(circle, #330000 0%, #1a0000 50%, var(--bg) 100%)'
          : 'var(--bg)',
    transition: 'background 0.1s',
  };

  return (
    <div className={shaking ? 'shake' : ''} style={containerStyle}>
      {/* Scanline overlay */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />

      {/* ─── MENU ──────────────────────────────────── */}
      {phase === 'menu' && (
        <div style={{ zIndex: 1 }}>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--green)', marginBottom: 'var(--sp-xs)', textShadow: '0 0 20px rgba(0,255,65,0.5)' }}>
            REFLEX
          </h1>
          <h1 style={{ fontSize: 'var(--fs-xl)', color: 'var(--red)', marginBottom: 'var(--sp-lg)', textShadow: '0 0 20px rgba(255,0,64,0.3)' }}>
            RUSH
          </h1>

          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-md)', lineHeight: '2' }}>
            <p><span style={{ color: 'var(--green)' }}>GRUEN</span> = DRUECKEN</p>
            <p><span style={{ color: 'var(--red)' }}>ROT</span> = NICHT DRUECKEN</p>
            <p style={{ marginTop: 'var(--sp-xs)' }}>5 RUNDEN &middot; DURCHSCHNITT ZAEHLT</p>
          </div>

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)' }}>
            [ TIPPEN / LEERTASTE ]
          </p>

          {bestScore !== null && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-sm)' }}>
              BEST: {bestScore}ms
            </p>
          )}
        </div>
      )}

      {/* ─── COUNTDOWN ─────────────────────────────── */}
      {phase === 'countdown' && (
        <div style={{ zIndex: 1 }}>
          <p
            key={countdownNum}
            className="countdown-pop"
            style={{
              fontSize: countdownNum === 0 ? 'var(--fs-xxl)' : 'var(--fs-xxl)',
              color: countdownNum === 0 ? 'var(--green)' : 'var(--text)',
              textShadow: countdownNum === 0 ? '0 0 30px var(--green)' : 'none',
            }}
          >
            {countdownNum === 0 ? 'GO!' : countdownNum}
          </p>
        </div>
      )}

      {/* ─── WAITING ───────────────────────────────── */}
      {phase === 'waiting' && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-dim)' }}>
            WARTE...
          </p>
          <div
            style={{
              width: 'var(--sz-box-sm)',
              height: 'var(--sz-box-sm)',
              margin: 'var(--sp-md) auto',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '-4px 0 0 0 var(--text-dim), 4px 0 0 0 var(--text-dim), 0 -4px 0 0 var(--text-dim), 0 4px 0 0 var(--text-dim)',
            }}
          >
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
          <div
            style={{
              width: 'var(--sz-box-lg)',
              height: 'var(--sz-box-lg)',
              margin: 'var(--sp-sm) auto',
              background: stimulusType === 'green' ? 'var(--green)' : 'var(--red)',
              boxShadow: `0 0 40px ${stimulusType === 'green' ? 'var(--green)' : 'var(--red)'}, -4px 0 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 4px 0 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 0 -4px 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 0 4px 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.05s',
            }}
          >
            <span style={{ fontSize: 'var(--fs-xxl)', color: stimulusType === 'green' ? '#001a00' : '#1a0000' }}>
              {stimulusType === 'green' ? '!' : 'X'}
            </span>
          </div>
          <p style={{
            fontSize: 'var(--fs-md)',
            color: stimulusType === 'green' ? 'var(--green)' : 'var(--red)',
            marginTop: 'var(--sp-sm)',
            textShadow: `0 0 10px ${stimulusType === 'green' ? 'var(--green)' : 'var(--red)'}`,
          }}>
            {stimulusType === 'green' ? 'JETZT!' : 'WARTE!'}
          </p>
        </div>
      )}

      {/* ─── RESULT (single reaction) ──────────────── */}
      {phase === 'result' && (
        <div style={{ zIndex: 1 }}>
          {renderProgressDots()}
          <p style={{
            fontSize: 'var(--fs-xxl)',
            color: reactionTime < 200 ? 'var(--gold)' : reactionTime < 300 ? 'var(--green)' : 'var(--text)',
            textShadow: reactionTime < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {reactionTime}
            <span style={{ fontSize: 'var(--fs-sm)' }}>ms</span>
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>
            {reactionTime < 150 ? 'UNMENSCHLICH!' :
              reactionTime < 200 ? 'BLITZSCHNELL!' :
                reactionTime < 250 ? 'SCHNELL!' :
                  reactionTime < 350 ? 'SOLIDE' :
                    'LANGSAM...'}
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] WEITER
          </p>
        </div>
      )}

      {/* ─── FAILED ────────────────────────────────── */}
      {phase === 'failed' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--red)', textShadow: '0 0 20px rgba(255,0,64,0.5)' }}>
            FEHLSCHLAG!
          </p>
          <div style={{
            margin: 'var(--sp-sm) auto',
            padding: 'var(--sp-xs) var(--sp-sm)',
            background: 'rgba(255,0,64,0.1)',
            maxWidth: '400px',
          }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--red)', lineHeight: '2' }}>
              {phase === 'failed' && stimulusType === 'red'
                ? 'BEI ROT GEDRUECKT!'
                : 'ZU FRUEH GEDRUECKT!'}
            </p>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: '2' }}>
              RUNDE UNGUELTIG
            </p>
          </div>
          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] NOCHMAL
          </p>
        </div>
      )}

      {/* ─── ROUND END ─────────────────────────────── */}
      {phase === 'roundEnd' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
            ERGEBNIS
          </p>

          <p style={{
            fontSize: 'var(--fs-xxl)',
            color: averageMs < 200 ? 'var(--gold)' : averageMs < 280 ? 'var(--green)' : 'var(--text)',
            textShadow: averageMs < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {averageMs}
            <span style={{ fontSize: 'var(--fs-sm)' }}>ms</span>
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
            DURCHSCHNITT
          </p>

          {/* Individual times */}
          <div style={{ display: 'flex', gap: 'var(--sp-xs)', justifyContent: 'center', margin: 'var(--sp-sm) 0', flexWrap: 'wrap' }}>
            {results.map((r, i) => (
              <span key={i} style={{ fontSize: 'var(--fs-xs)', color: r.reactionMs < 200 ? 'var(--gold)' : 'var(--green)' }}>
                {r.reactionMs}
              </span>
            ))}
          </div>

          {bestScore !== null && averageMs <= bestScore && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)', textShadow: '0 0 10px var(--gold)' }}>
              NEUER REKORD!
            </p>
          )}

          {streakCount > 1 && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
              STREAK: {streakCount}
            </p>
          )}

          {/* Nickname input */}
          {showNicknameInput ? (
            <div style={{ marginTop: 'var(--sp-sm)' }}>
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-xs)' }}>
                NICKNAME FUER LEADERBOARD:
              </p>
              <input
                ref={nicknameInputRef}
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value.toUpperCase().slice(0, 12))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmitScore();
                }}
                maxLength={12}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  color: 'var(--green)',
                  fontFamily: "'Press Start 2P', monospace",
                  fontSize: 'var(--fs-sm)',
                  padding: 'var(--sp-xs) var(--sp-sm)',
                  textAlign: 'center',
                  width: 'var(--sz-input)',
                  outline: 'none',
                  boxShadow: '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)',
                }}
                placeholder="___"
              />
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--sp-xs)' }}>
                [ ENTER ] ABSENDEN
              </p>
            </div>
          ) : (
            <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>
              [ TIPPEN / LEERTASTE ] ABSENDEN
            </p>
          )}
        </div>
      )}

      {/* ─── LEADERBOARD ───────────────────────────── */}
      {phase === 'leaderboard' && (
        <div style={{ zIndex: 1, maxWidth: 'clamp(320px, 80vw, 500px)', width: '100%' }}>
          <p style={{ fontSize: 'var(--fs-md)', color: 'var(--gold)', marginBottom: '4px' }}>
            LEADERBOARD
          </p>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 'var(--sp-sm)' }}>
            DIESE WOCHE
          </p>

          {/* Near-miss alert */}
          {nearMissInfo && (
            <p className="near-miss" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginBottom: 'var(--sp-xs)' }}>
              {nearMissInfo}
            </p>
          )}

          {/* Leaderboard entries */}
          <div style={{ textAlign: 'left' }}>
            {leaderboard.length === 0 && (
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', textAlign: 'center' }}>
                KEINE EINTRAEGE DIESE WOCHE
              </p>
            )}
            {leaderboard.map((entry, i) => {
              const isPlayer = playerRank !== null && i === playerRank - 1;
              const rankColor = i === 0 ? 'var(--gold)' : i === 1 ? 'var(--silver)' : i === 2 ? 'var(--bronze)' : 'var(--text-dim)';
              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: 'var(--sp-xs) var(--sp-sm)',
                    marginBottom: '4px',
                    background: isPlayer ? 'rgba(0,255,65,0.1)' : 'transparent',
                    boxShadow: isPlayer ? '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)' : 'none',
                    animation: `slide-in 0.3s ease-out ${i * 0.05}s both`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
                    <span style={{ fontSize: 'var(--fs-sm)', color: rankColor, minWidth: '2.5em' }}>
                      {i === 0 ? '>>>' : `#${i + 1}`}
                    </span>
                    <span style={{
                      fontSize: 'var(--fs-xs)',
                      color: isPlayer ? 'var(--green)' : 'var(--text)',
                    }}>
                      {entry.nickname}
                    </span>
                  </div>
                  <span style={{
                    fontSize: 'var(--fs-sm)',
                    color: isPlayer ? 'var(--green)' : rankColor,
                  }}>
                    {entry.average_ms}ms
                  </span>
                </div>
              );
            })}
          </div>

          {/* Player score summary */}
          <div style={{ marginTop: 'var(--sp-sm)', padding: 'var(--sp-xs)', background: 'rgba(0,255,65,0.05)' }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              DEIN SCORE: <span style={{ color: 'var(--green)' }}>{averageMs}ms</span>
              {playerRank && <span> &middot; PLATZ {playerRank}</span>}
            </p>
          </div>

          <p className="pulse" style={{ fontSize: 'var(--fs-sm)', color: 'var(--gold)', marginTop: 'var(--sp-sm)' }}>
            [ TIPPEN / LEERTASTE ] NOCHMAL
          </p>
        </div>
      )}

      {/* ─── STREAK INDICATOR (always visible during game) ─── */}
      {streakCount > 0 && (phase === 'menu' || phase === 'leaderboard') && (
        <div style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          fontSize: '8px',
          color: 'var(--text-dim)',
          zIndex: 20,
        }}>
          STREAK {streakCount}
        </div>
      )}
    </div>
  );
}
