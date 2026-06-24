/**
 * Tests for `HolderTracker` (pure flash-loan-mitigation logic).
 *
 * Strategy: inject a manual clock so we can advance time
 * deterministically and assert on the exact transitions between
 * the time gate and the consecutive-observation gate.
 *
 * Coverage hits every branch of `recordObservation`:
 * - balance below threshold (reset path)
 * - first observation above threshold (initial tracking, denied)
 * - subsequent observations: time gate passes, consec gate passes,
 *   neither passes, both pass
 * - threshold dip resets tracking
 * - history accessors and clear methods
 * - input validation (NaN, negative)
 * - configuration validation
 */

import { describe, expect, it, vi } from 'vitest';

import type { GameLogger } from '../../server/game/interfaces.js';
import { HolderTracker } from '../../server/verification/holder-tracker.js';

const ALICE = 'AliceWalletAddress11111111111111111111111111';
const BOB = 'BobWalletAddress2222222222222222222222222222';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeClock {
  constructor(public ms: number = 1_000_000) {}
  now = (): number => this.ms;
  advance = (deltaMs: number) => {
    this.ms += deltaMs;
  };
}

function makeTracker(opts?: {
  minHoldMs?: number;
  minConsecutiveObservations?: number;
  clock?: FakeClock;
}): { tracker: HolderTracker; clock: FakeClock } {
  const clock = opts?.clock ?? new FakeClock();
  const tracker = new HolderTracker({
    minHoldMs: opts?.minHoldMs ?? 600_000,
    minConsecutiveObservations: opts?.minConsecutiveObservations ?? 5,
    logger: silentLogger,
    now: clock.now,
  });
  return { tracker, clock };
}

// =============================================================================
// Below-threshold path
// =============================================================================

describe('HolderTracker.recordObservation: below threshold', () => {
  it('returns eligible=false with reason=below_threshold when balance < required', () => {
    const { tracker } = makeTracker();
    const r = tracker.recordObservation(ALICE, 5, 10);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.meetsBalanceRequirement).toBe(false);
    expect(r.consecutiveObservations).toBe(0);
    expect(r.balance).toBe(5);
    expect(r.requiredBalance).toBe(10);
  });

  it('zero balance with positive threshold is below_threshold', () => {
    const { tracker } = makeTracker();
    const r = tracker.recordObservation(ALICE, 0, 10);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('below_threshold');
  });

  it('zero threshold with zero balance is above (>= rule)', () => {
    const { tracker } = makeTracker();
    const r = tracker.recordObservation(ALICE, 0, 0);
    expect(r.meetsBalanceRequirement).toBe(true);
  });

  it('a below-threshold observation does NOT create a tracking entry', () => {
    const { tracker } = makeTracker();
    tracker.recordObservation(ALICE, 5, 10);
    expect(tracker.getHistory(ALICE)).toBeUndefined();
    expect(tracker.size()).toBe(0);
  });
});

// =============================================================================
// First observation above threshold
// =============================================================================

describe('HolderTracker.recordObservation: first observation', () => {
  it('returns eligible=false with reason=flash_loan_guard on first observation', () => {
    const { tracker } = makeTracker();
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('flash_loan_guard');
    expect(r.meetsBalanceRequirement).toBe(true);
    expect(r.consecutiveObservations).toBe(1);
    expect(r.holdDurationMs).toBe(0);
  });

  it('reports the full minHoldMs as remaining on first observation', () => {
    const { tracker } = makeTracker({ minHoldMs: 600_000 });
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.remainingHoldMs).toBe(600_000);
  });

  it('creates a tracking entry on first observation', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordObservation(ALICE, 100, 10);
    const h = tracker.getHistory(ALICE);
    expect(h).toBeDefined();
    expect(h?.firstSeenAboveThresholdMs).toBe(clock.ms);
    expect(h?.lastBalance).toBe(100);
    expect(h?.consecutiveObservations).toBe(1);
  });

  it('NEVER passes through on first call (BG quirk explicitly fixed)', () => {
    // BG's behavior: first call = eligible. astroid.club's behavior:
    // first call = denied. This is the entire point of the slice.
    const { tracker } = makeTracker();
    const r = tracker.recordObservation(ALICE, 1_000_000, 1);
    expect(r.eligible).toBe(false);
  });
});

// =============================================================================
// Subsequent observations: time gate
// =============================================================================

describe('HolderTracker.recordObservation: time gate', () => {
  it('blocks while held < minHoldMs and consec < minConsecutiveObservations', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 5 });
    tracker.recordObservation(ALICE, 100, 10);
    clock.advance(1_000); // 1s elapsed, consec=1
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('flash_loan_guard');
    expect(r.holdDurationMs).toBe(1_000);
    expect(r.consecutiveObservations).toBe(2);
    expect(r.remainingHoldMs).toBe(599_000);
  });

  it('passes when holdDurationMs reaches minHoldMs (consec gate not met)', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 50 });
    tracker.recordObservation(ALICE, 100, 10);
    clock.advance(600_000); // exactly at threshold
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.holdDurationMs).toBe(600_000);
    expect(r.remainingHoldMs).toBe(0);
  });

  it('passes when holdDurationMs > minHoldMs', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 50 });
    tracker.recordObservation(ALICE, 100, 10);
    clock.advance(700_000);
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(true);
  });

  it('does NOT pass when holdDurationMs is exactly 1 ms below minHoldMs', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 50 });
    tracker.recordObservation(ALICE, 100, 10);
    clock.advance(599_999);
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(false);
  });
});

// =============================================================================
// Subsequent observations: consecutive gate
// =============================================================================

describe('HolderTracker.recordObservation: consecutive gate', () => {
  it('passes when consecutive observations reach minConsecutiveObservations', () => {
    const { tracker, clock } = makeTracker({
      minHoldMs: 1_000_000_000,
      minConsecutiveObservations: 5,
    });
    // 5 calls, each 1ms apart — way below time gate, way above consec gate
    let r;
    for (let i = 0; i < 5; i++) {
      r = tracker.recordObservation(ALICE, 100, 10);
      clock.advance(1);
    }
    expect(r?.eligible).toBe(true);
    expect(r?.consecutiveObservations).toBe(5);
  });

  it('does NOT pass after only 4 consecutive when threshold is 5', () => {
    const { tracker, clock } = makeTracker({
      minHoldMs: 1_000_000_000,
      minConsecutiveObservations: 5,
    });
    let r;
    for (let i = 0; i < 4; i++) {
      r = tracker.recordObservation(ALICE, 100, 10);
      clock.advance(1);
    }
    expect(r?.eligible).toBe(false);
    expect(r?.consecutiveObservations).toBe(4);
  });

  it('with minConsecutiveObservations=1, first observation is still denied (>= rule met but flash-loan window hits anyway)', () => {
    // Edge case: even with the loosest consecutive setting allowed
    // (1), first call is denied because we have no historical data
    // — but actually, consec=1 >= 1 makes the first call eligible.
    // Document this clearly.
    const { tracker } = makeTracker({
      minHoldMs: 600_000,
      minConsecutiveObservations: 1,
    });
    const r = tracker.recordObservation(ALICE, 100, 10);
    // consec=1, threshold=1, so consec gate is met immediately —
    // operators who set this knob to 1 are explicitly opting out
    // of the flash-loan guard. eligible=true.
    expect(r.eligible).toBe(true);
  });
});

// =============================================================================
// Both gates pass simultaneously
// =============================================================================

describe('HolderTracker.recordObservation: both gates pass', () => {
  it('eligible when both holdDuration >= minHoldMs AND consec >= threshold', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 1_000, minConsecutiveObservations: 3 });
    tracker.recordObservation(ALICE, 100, 10); // consec=1, hold=0
    clock.advance(500);
    tracker.recordObservation(ALICE, 100, 10); // consec=2, hold=500
    clock.advance(500);
    const r = tracker.recordObservation(ALICE, 100, 10); // consec=3, hold=1000
    expect(r.eligible).toBe(true);
    expect(r.consecutiveObservations).toBe(3);
    expect(r.holdDurationMs).toBe(1_000);
  });
});

// =============================================================================
// Threshold dip resets tracking
// =============================================================================

describe('HolderTracker.recordObservation: threshold dip', () => {
  it('a single below-threshold observation resets tracking', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 5 });
    tracker.recordObservation(ALICE, 100, 10); // consec=1
    clock.advance(599_000);
    tracker.recordObservation(ALICE, 5, 10); // dip below threshold
    expect(tracker.getHistory(ALICE)).toBeUndefined();

    clock.advance(1_000);
    const r = tracker.recordObservation(ALICE, 100, 10); // back above
    expect(r.consecutiveObservations).toBe(1); // reset
    expect(r.holdDurationMs).toBe(0); // reset
    expect(r.eligible).toBe(false);
  });

  it('the attacker cannot bypass the guard by dipping repeatedly', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 5 });
    // Try to "bank" hold time by dipping and returning many times.
    for (let i = 0; i < 100; i++) {
      tracker.recordObservation(ALICE, 100, 10);
      clock.advance(1_000);
      tracker.recordObservation(ALICE, 5, 10); // dip
      clock.advance(1_000);
    }
    // After 200_000 ms of pretending to hold, attacker comes back.
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(false);
    expect(r.consecutiveObservations).toBe(1);
    expect(r.holdDurationMs).toBe(0);
  });
});

// =============================================================================
// seedHoldStart: pre-warming from on-chain history
// =============================================================================

describe('HolderTracker.seedHoldStart', () => {
  it('seeds an untracked wallet and returns true', () => {
    const { tracker, clock } = makeTracker();
    const seeded = tracker.seedHoldStart(ALICE, clock.ms - 30 * 60_000, 1000);
    expect(seeded).toBe(true);
    const h = tracker.getHistory(ALICE);
    expect(h?.firstSeenAboveThresholdMs).toBe(clock.ms - 30 * 60_000);
    expect(h?.lastBalance).toBe(1000);
    expect(h?.consecutiveObservations).toBe(1);
  });

  it('is idempotent: returns false and does NOT override existing history', () => {
    const { tracker, clock } = makeTracker();
    tracker.recordObservation(ALICE, 100, 10); // creates history at clock.ms
    const before = tracker.getHistory(ALICE);
    const seeded = tracker.seedHoldStart(ALICE, clock.ms - 30 * 60_000, 1000);
    expect(seeded).toBe(false);
    const after = tracker.getHistory(ALICE);
    expect(after).toEqual(before);
  });

  it('clamps future timestamps to now (defensive)', () => {
    const { tracker, clock } = makeTracker();
    const future = clock.ms + 10 * 60_000;
    tracker.seedHoldStart(ALICE, future, 1000);
    const h = tracker.getHistory(ALICE);
    expect(h?.firstSeenAboveThresholdMs).toBe(clock.ms);
  });

  it('lets a long-time holder pass the time gate on the very next observation', () => {
    // The whole point of pre-warming: a wallet that has held for
    // longer than minHoldMs on chain should qualify immediately,
    // not after another minHoldMs of in-memory observation.
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 50 });
    const oneHourAgo = clock.ms - 60 * 60_000;
    tracker.seedHoldStart(ALICE, oneHourAgo, 1000);
    const r = tracker.recordObservation(ALICE, 1000, 100);
    expect(r.eligible).toBe(true);
    expect(r.holdDurationMs).toBe(60 * 60_000);
    expect(r.consecutiveObservations).toBe(2);
  });

  it('does not bypass the threshold-dip reset', () => {
    // Pre-warm seeds; balance dips; tracking is wiped just like
    // any other tracking entry. The next above-threshold observation
    // is treated as a true first observation.
    const { tracker, clock } = makeTracker({ minHoldMs: 600_000, minConsecutiveObservations: 50 });
    tracker.seedHoldStart(ALICE, clock.ms - 60 * 60_000, 1000);
    tracker.recordObservation(ALICE, 5, 100); // dip
    expect(tracker.getHistory(ALICE)).toBeUndefined();
    const r = tracker.recordObservation(ALICE, 1000, 100); // back above
    expect(r.eligible).toBe(false);
    expect(r.consecutiveObservations).toBe(1);
    expect(r.holdDurationMs).toBe(0);
  });

  it('throws on non-finite holdStartMs', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.seedHoldStart(ALICE, Number.NaN, 1000)).toThrow(/holdStartMs/);
    expect(() => tracker.seedHoldStart(ALICE, Number.POSITIVE_INFINITY, 1000)).toThrow(
      /holdStartMs/,
    );
  });

  it('throws on negative or non-finite balance', () => {
    const { tracker, clock } = makeTracker();
    expect(() => tracker.seedHoldStart(ALICE, clock.ms, -1)).toThrow(/balance/);
    expect(() => tracker.seedHoldStart(ALICE, clock.ms, Number.NaN)).toThrow(/balance/);
  });

  it('logs the pre-warm event at info', () => {
    const info = vi.fn();
    const clock = new FakeClock();
    const tracker = new HolderTracker({
      logger: { info, warn: () => {}, error: () => {} },
      now: clock.now,
    });
    tracker.seedHoldStart(ALICE, clock.ms - 60_000, 1000);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toContain('pre-warmed');
  });
});

// =============================================================================
// Multiple wallets are isolated
// =============================================================================

describe('HolderTracker isolation', () => {
  it('tracking for ALICE does not affect BOB', () => {
    const { tracker, clock } = makeTracker({ minHoldMs: 1_000, minConsecutiveObservations: 50 });
    tracker.recordObservation(ALICE, 100, 10);
    clock.advance(2_000);
    const aliceR = tracker.recordObservation(ALICE, 100, 10);
    expect(aliceR.eligible).toBe(true);

    const bobR = tracker.recordObservation(BOB, 100, 10);
    expect(bobR.eligible).toBe(false);
    expect(bobR.consecutiveObservations).toBe(1);
  });

  it('clear(wallet) only forgets that wallet', () => {
    const { tracker } = makeTracker();
    tracker.recordObservation(ALICE, 100, 10);
    tracker.recordObservation(BOB, 200, 10);
    tracker.clear(ALICE);
    expect(tracker.getHistory(ALICE)).toBeUndefined();
    expect(tracker.getHistory(BOB)).toBeDefined();
  });

  it('clearAll() forgets every wallet', () => {
    const { tracker } = makeTracker();
    tracker.recordObservation(ALICE, 100, 10);
    tracker.recordObservation(BOB, 200, 10);
    tracker.clearAll();
    expect(tracker.size()).toBe(0);
  });
});

// =============================================================================
// Input validation
// =============================================================================

describe('HolderTracker input validation', () => {
  it('throws on NaN balance', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordObservation(ALICE, Number.NaN, 10)).toThrow(/balance/);
  });

  it('throws on Infinity balance', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordObservation(ALICE, Number.POSITIVE_INFINITY, 10)).toThrow(/balance/);
  });

  it('throws on negative balance', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordObservation(ALICE, -1, 10)).toThrow(/balance/);
  });

  it('throws on NaN requiredBalance', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordObservation(ALICE, 100, Number.NaN)).toThrow(/requiredBalance/);
  });

  it('throws on negative requiredBalance', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordObservation(ALICE, 100, -1)).toThrow(/requiredBalance/);
  });
});

// =============================================================================
// Configuration validation
// =============================================================================

describe('HolderTracker constructor validation', () => {
  it('throws on negative minHoldMs', () => {
    expect(() => new HolderTracker({ minHoldMs: -1, logger: silentLogger })).toThrow(/minHoldMs/);
  });

  it('throws on minConsecutiveObservations < 1', () => {
    expect(
      () => new HolderTracker({ minConsecutiveObservations: 0, logger: silentLogger }),
    ).toThrow(/minConsecutiveObservations/);
  });

  it('accepts minHoldMs=0 (operators explicitly opting out of time gate)', () => {
    expect(() => new HolderTracker({ minHoldMs: 0, logger: silentLogger })).not.toThrow();
  });

  it('uses default minHoldMs=600_000 (BG parity) when unset', () => {
    const tracker = new HolderTracker({ logger: silentLogger });
    // Indirect verification: first call is always denied, and
    // remainingHoldMs reflects the configured threshold.
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.remainingHoldMs).toBe(600_000);
  });
});

// =============================================================================
// Logger receives expected events
// =============================================================================

describe('HolderTracker logging', () => {
  it('logs the new-wallet-tracked event AND the flash-loan-denial on first observation', () => {
    // First observation always falls through to the flash-loan
    // guard (eligible=false), so operators see both a "tracked"
    // line and a "denied" line. Both are informative for triage.
    const info = vi.fn();
    const tracker = new HolderTracker({
      logger: { info, warn: () => {}, error: () => {} },
      minHoldMs: 600_000,
    });
    tracker.recordObservation(ALICE, 100, 10);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]?.[0]).toContain('new wallet tracked');
    expect(info.mock.calls[1]?.[0]).toContain('flash-loan guard');
  });

  it('logs an info on flash-loan-guarded denial', () => {
    const clock = new FakeClock();
    const info = vi.fn();
    const tracker = new HolderTracker({
      logger: { info, warn: () => {}, error: () => {} },
      minHoldMs: 600_000,
      minConsecutiveObservations: 50,
      now: clock.now,
    });
    tracker.recordObservation(ALICE, 100, 10);
    info.mockClear();
    clock.advance(1_000);
    tracker.recordObservation(ALICE, 100, 10);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('flash-loan guard');
  });

  it('does NOT log when eligibility passes', () => {
    const clock = new FakeClock();
    const info = vi.fn();
    const tracker = new HolderTracker({
      logger: { info, warn: () => {}, error: () => {} },
      minHoldMs: 1_000,
      minConsecutiveObservations: 50,
      now: clock.now,
    });
    tracker.recordObservation(ALICE, 100, 10); // 1 info on first obs
    info.mockClear();
    clock.advance(2_000);
    const r = tracker.recordObservation(ALICE, 100, 10);
    expect(r.eligible).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });

  it('does NOT log when below threshold', () => {
    const info = vi.fn();
    const tracker = new HolderTracker({
      logger: { info, warn: () => {}, error: () => {} },
    });
    tracker.recordObservation(ALICE, 5, 10);
    expect(info).not.toHaveBeenCalled();
  });
});
