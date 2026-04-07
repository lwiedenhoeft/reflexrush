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
      // Red: auto-advance after brief display
      timeoutTimerRef.current = setTimeout(() => {
        if (!hasRespondedRef.current) {
          hasRespondedRef.current = true;
          // Correctly did NOT press on red
          advanceRound();
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

  // ─── HANDLE SPACEBAR ─────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();

      if (showNicknameInput) return; // Don't interfere with nickname input

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
            // FAIL – pressed on red
            audioRef.current?.fail();
            triggerShake();
            setStreakCount(0);
            setPhase('failed');
          } else {
            // Good reaction on green
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
          // Pressed too early – this counts as a fail
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, stimulusType, startGame, advanceRound, clearTimers, triggerShake, showNicknameInput]);

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
    <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginBottom: '24px' }}>
      {Array.from({ length: ROUNDS_PER_GAME }).map((_, i) => (
        <div
          key={i}
          style={{
            width: '16px',
            height: '16px',
            background: i < results.length ? 'var(--green)' : i === currentRound ? 'var(--gold)' : 'var(--accent)',
            boxShadow: i === currentRound ? '0 0 8px var(--gold)' : 'none',
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
          <h1 style={{ fontSize: '32px', color: 'var(--green)', marginBottom: '8px', textShadow: '0 0 20px rgba(0,255,65,0.5)' }}>
            REFLEX
          </h1>
          <h1 style={{ fontSize: '32px', color: 'var(--red)', marginBottom: '40px', textShadow: '0 0 20px rgba(255,0,64,0.3)' }}>
            RUSH
          </h1>

          <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '32px', lineHeight: '2' }}>
            <p><span style={{ color: 'var(--green)' }}>GRUEN</span> = DRUECKEN</p>
            <p><span style={{ color: 'var(--red)' }}>ROT</span> = NICHT DRUECKEN</p>
            <p style={{ marginTop: '8px' }}>5 RUNDEN &middot; DURCHSCHNITT ZAEHLT</p>
          </div>

          <p className="pulse" style={{ fontSize: '12px', color: 'var(--gold)' }}>
            [ LEERTASTE ]
          </p>

          {bestScore !== null && (
            <p style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: '24px' }}>
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
              fontSize: countdownNum === 0 ? '48px' : '64px',
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
          <p style={{ fontSize: '14px', color: 'var(--text-dim)' }}>
            WARTE...
          </p>
          <div
            style={{
              width: '120px',
              height: '120px',
              margin: '32px auto',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '-4px 0 0 0 var(--text-dim), 4px 0 0 0 var(--text-dim), 0 -4px 0 0 var(--text-dim), 0 4px 0 0 var(--text-dim)',
            }}
          >
            <span style={{ fontSize: '32px', color: 'var(--text-dim)' }}>?</span>
          </div>
          <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginTop: '16px' }}>
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
              width: '160px',
              height: '160px',
              margin: '16px auto',
              background: stimulusType === 'green' ? 'var(--green)' : 'var(--red)',
              boxShadow: `0 0 40px ${stimulusType === 'green' ? 'var(--green)' : 'var(--red)'}, -4px 0 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 4px 0 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 0 -4px 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}, 0 4px 0 0 ${stimulusType === 'green' ? '#00cc33' : '#cc0033'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.05s',
            }}
          >
            <span style={{ fontSize: '48px', color: stimulusType === 'green' ? '#001a00' : '#1a0000' }}>
              {stimulusType === 'green' ? '!' : 'X'}
            </span>
          </div>
          <p style={{
            fontSize: '14px',
            color: stimulusType === 'green' ? 'var(--green)' : 'var(--red)',
            marginTop: '20px',
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
            fontSize: '48px',
            color: reactionTime < 200 ? 'var(--gold)' : reactionTime < 300 ? 'var(--green)' : 'var(--text)',
            textShadow: reactionTime < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {reactionTime}
            <span style={{ fontSize: '16px' }}>ms</span>
          </p>
          <p style={{ fontSize: '9px', color: 'var(--text-dim)', marginTop: '12px' }}>
            {reactionTime < 150 ? 'UNMENSCHLICH!' :
              reactionTime < 200 ? 'BLITZSCHNELL!' :
                reactionTime < 250 ? 'SCHNELL!' :
                  reactionTime < 350 ? 'SOLIDE' :
                    'LANGSAM...'}
          </p>
          <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginTop: '24px' }}>
            [ LEERTASTE ] WEITER
          </p>
        </div>
      )}

      {/* ─── FAILED ────────────────────────────────── */}
      {phase === 'failed' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: '24px', color: 'var(--red)', textShadow: '0 0 20px rgba(255,0,64,0.5)' }}>
            FEHLSCHLAG!
          </p>
          <div style={{
            margin: '24px auto',
            padding: '16px 24px',
            background: 'rgba(255,0,64,0.1)',
            maxWidth: '320px',
          }}>
            <p style={{ fontSize: '9px', color: 'var(--red)', lineHeight: '2' }}>
              {phase === 'failed' && stimulusType === 'red'
                ? 'BEI ROT GEDRUECKT!'
                : 'ZU FRUEH GEDRUECKT!'}
            </p>
            <p style={{ fontSize: '9px', color: 'var(--text-dim)', lineHeight: '2' }}>
              RUNDE UNGUELTIG
            </p>
          </div>
          <p className="pulse" style={{ fontSize: '10px', color: 'var(--gold)', marginTop: '16px' }}>
            [ LEERTASTE ] NOCHMAL
          </p>
        </div>
      )}

      {/* ─── ROUND END ─────────────────────────────── */}
      {phase === 'roundEnd' && (
        <div style={{ zIndex: 1 }}>
          <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px' }}>
            ERGEBNIS
          </p>

          <p style={{
            fontSize: '48px',
            color: averageMs < 200 ? 'var(--gold)' : averageMs < 280 ? 'var(--green)' : 'var(--text)',
            textShadow: averageMs < 200 ? '0 0 20px var(--gold)' : 'none',
          }}>
            {averageMs}
            <span style={{ fontSize: '16px' }}>ms</span>
          </p>
          <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginTop: '4px' }}>
            DURCHSCHNITT
          </p>

          {/* Individual times */}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', margin: '20px 0', flexWrap: 'wrap' }}>
            {results.map((r, i) => (
              <span key={i} style={{ fontSize: '9px', color: r.reactionMs < 200 ? 'var(--gold)' : 'var(--green)' }}>
                {r.reactionMs}
              </span>
            ))}
          </div>

          {bestScore !== null && averageMs <= bestScore && (
            <p style={{ fontSize: '10px', color: 'var(--gold)', marginBottom: '12px', textShadow: '0 0 10px var(--gold)' }}>
              NEUER REKORD!
            </p>
          )}

          {streakCount > 1 && (
            <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginBottom: '12px' }}>
              STREAK: {streakCount}
            </p>
          )}

          {/* Nickname input */}
          {showNicknameInput ? (
            <div style={{ marginTop: '16px' }}>
              <p style={{ fontSize: '9px', color: 'var(--text-dim)', marginBottom: '12px' }}>
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
                  fontSize: '12px',
                  padding: '12px 16px',
                  textAlign: 'center',
                  width: '240px',
                  outline: 'none',
                  boxShadow: '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)',
                }}
                placeholder="___"
              />
              <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginTop: '12px' }}>
                [ ENTER ] ABSENDEN
              </p>
            </div>
          ) : (
            <p className="pulse" style={{ fontSize: '10px', color: 'var(--gold)', marginTop: '20px' }}>
              [ LEERTASTE ] ABSENDEN
            </p>
          )}
        </div>
      )}

      {/* ─── LEADERBOARD ───────────────────────────── */}
      {phase === 'leaderboard' && (
        <div style={{ zIndex: 1, maxWidth: '400px', width: '100%' }}>
          <p style={{ fontSize: '14px', color: 'var(--gold)', marginBottom: '4px' }}>
            LEADERBOARD
          </p>
          <p style={{ fontSize: '8px', color: 'var(--text-dim)', marginBottom: '20px' }}>
            DIESE WOCHE
          </p>

          {/* Near-miss alert */}
          {nearMissInfo && (
            <p className="near-miss" style={{ fontSize: '10px', color: 'var(--gold)', marginBottom: '16px' }}>
              {nearMissInfo}
            </p>
          )}

          {/* Leaderboard entries */}
          <div style={{ textAlign: 'left' }}>
            {leaderboard.length === 0 && (
              <p style={{ fontSize: '9px', color: 'var(--text-dim)', textAlign: 'center' }}>
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
                    padding: '8px 12px',
                    marginBottom: '4px',
                    background: isPlayer ? 'rgba(0,255,65,0.1)' : 'transparent',
                    boxShadow: isPlayer ? '-2px 0 0 0 var(--green), 2px 0 0 0 var(--green), 0 -2px 0 0 var(--green), 0 2px 0 0 var(--green)' : 'none',
                    animation: `slide-in 0.3s ease-out ${i * 0.05}s both`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '10px', color: rankColor, minWidth: '30px' }}>
                      {i === 0 ? '>>>' : `#${i + 1}`}
                    </span>
                    <span style={{
                      fontSize: '9px',
                      color: isPlayer ? 'var(--green)' : 'var(--text)',
                    }}>
                      {entry.nickname}
                    </span>
                  </div>
                  <span style={{
                    fontSize: '10px',
                    color: isPlayer ? 'var(--green)' : rankColor,
                  }}>
                    {entry.average_ms}ms
                  </span>
                </div>
              );
            })}
          </div>

          {/* Player score summary */}
          <div style={{ marginTop: '20px', padding: '12px', background: 'rgba(0,255,65,0.05)' }}>
            <p style={{ fontSize: '9px', color: 'var(--text-dim)' }}>
              DEIN SCORE: <span style={{ color: 'var(--green)' }}>{averageMs}ms</span>
              {playerRank && <span> &middot; PLATZ {playerRank}</span>}
            </p>
          </div>

          <p className="pulse" style={{ fontSize: '10px', color: 'var(--gold)', marginTop: '20px' }}>
            [ LEERTASTE ] NOCHMAL
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
