/**
 * Durable escrow manager — the settlement outbox + restart reconciliation
 * for on-chain raid wagers.
 *
 * These tests drive the manager with an in-memory fake store and a
 * programmable fake chain to assert the money-safety guarantees:
 *   - a verified deposit is recorded as durable `active` liability;
 *   - a win returns, a loss burns + pays defenders (payouts before burn);
 *   - a failed leg leaves the record `settling` + retried, WITHOUT re-running
 *     legs that already landed (no double-pay);
 *   - exhausted retries park the record as `failed` (not lost);
 *   - boot reconciliation refunds orphaned `active` records and resumes
 *     in-flight `settling` ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EscrowManager } from '../../server/chain/escrow-manager.js';
import type { EscrowStore, EscrowWagerRecord, GameLogger } from '../../server/game/interfaces.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory EscrowStore double that records every write. */
function makeStore(seed: EscrowWagerRecord[] = []) {
  const map = new Map<string, EscrowWagerRecord>();
  for (const r of seed) map.set(r.wagerId, { ...r });
  return {
    map,
    store: {
      put: vi.fn((r: EscrowWagerRecord) => {
        map.set(r.wagerId, JSON.parse(JSON.stringify(r)) as EscrowWagerRecord);
      }),
      delete: vi.fn((id: string) => {
        map.delete(id);
      }),
      getUnsettled: vi.fn(() =>
        Array.from(map.values())
          .filter((r) => r.status !== 'settled')
          .map((r) => JSON.parse(JSON.stringify(r)) as EscrowWagerRecord),
      ),
    } satisfies EscrowStore,
  };
}

/**
 * Programmable fake chain. `failFirst` makes the next N calls (across all ops)
 * throw before succeeding, to exercise retry without double-paying done legs.
 */
function makeChain(opts: { failFirst?: number } = {}) {
  let fails = opts.failFirst ?? 0;
  const calls: Array<{ op: string; wallet?: string; amount: number; wagerId: string }> = [];
  const maybeFail = () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('rpc boom');
    }
  };
  return {
    calls,
    chain: {
      returnWager: vi.fn(async (wallet: string, amount: number, wagerId: string) => {
        maybeFail();
        calls.push({ op: 'return', wallet, amount, wagerId });
        return `ret-${wagerId}`;
      }),
      payDefender: vi.fn(async (wallet: string, amount: number, wagerId: string) => {
        maybeFail();
        calls.push({ op: 'payout', wallet, amount, wagerId });
        return `pay-${wallet}`;
      }),
      burnWager: vi.fn(async (amount: number, wagerId: string) => {
        maybeFail();
        calls.push({ op: 'burn', amount, wagerId });
        return `burn-${wagerId}`;
      }),
      recirculateToTreasury: vi.fn(async (amount: number, wagerId: string) => {
        maybeFail();
        calls.push({ op: 'recirculate', amount, wagerId });
        return `recirc-${wagerId}`;
      }),
    },
  };
}

describe('EscrowManager — recording + settlement', () => {
  let store: ReturnType<typeof makeStore>;
  let chain: ReturnType<typeof makeChain>;
  let mgr: EscrowManager;

  beforeEach(() => {
    store = makeStore();
    chain = makeChain();
    mgr = new EscrowManager({ store: store.store, chain: chain.chain, logger: silentLogger });
  });

  it('records a verified deposit as durable active liability', async () => {
    await mgr.recordBooked({ wagerId: 'w1', wallet: 'ATK', amount: 100, expeditionId: 'e1' });
    const rec = store.map.get('w1')!;
    expect(rec.status).toBe('active');
    expect(rec.amount).toBe(100);
    expect(mgr.outstandingLiability()).toBe(100);
  });

  it('returns the full wager on a win, then settles + drops the record', async () => {
    await mgr.recordBooked({ wagerId: 'w1', wallet: 'ATK', amount: 100, expeditionId: 'e1' });
    await mgr.settle({ wagerId: 'w1', returnTo: { wallet: 'ATK', amount: 100 } });

    expect(chain.chain.returnWager).toHaveBeenCalledWith('ATK', 100, 'w1');
    expect(chain.chain.burnWager).not.toHaveBeenCalled();
    expect(store.map.has('w1')).toBe(false); // settled → deleted
    expect(mgr.outstandingLiability()).toBe(0);
  });

  it('pays defenders BEFORE burning on a loss and settles fully', async () => {
    await mgr.recordBooked({ wagerId: 'w2', wallet: 'ATK', amount: 100, expeditionId: 'e2' });
    await mgr.settle({
      wagerId: 'w2',
      burn: 90,
      defenderPayouts: [{ wallet: 'DEF', amount: 10 }],
    });

    // Payout leg runs before the burn leg.
    expect(chain.calls.map((c) => c.op)).toEqual(['payout', 'burn']);
    expect(chain.chain.payDefender).toHaveBeenCalledWith('DEF', 10, 'w2');
    expect(chain.chain.burnWager).toHaveBeenCalledWith(90, 'w2');
    expect(store.map.has('w2')).toBe(false);
  });

  it('runs a 3-way loss split in order: payout → recirculate → burn', async () => {
    await mgr.recordBooked({ wagerId: 'w4', wallet: 'ATK', amount: 100, expeditionId: 'e4' });
    await mgr.settle({
      wagerId: 'w4',
      burn: 40,
      recirculate: 40,
      defenderPayouts: [{ wallet: 'DEF', amount: 20 }],
    });

    expect(chain.calls.map((c) => c.op)).toEqual(['payout', 'recirculate', 'burn']);
    expect(chain.chain.payDefender).toHaveBeenCalledWith('DEF', 20, 'w4');
    expect(chain.chain.recirculateToTreasury).toHaveBeenCalledWith(40, 'w4');
    expect(chain.chain.burnWager).toHaveBeenCalledWith(40, 'w4');
    expect(store.map.has('w4')).toBe(false); // fully settled
  });

  it('refund() returns the deposit to the raider', async () => {
    await mgr.refund('w3', 'ATK', 42);
    expect(chain.chain.returnWager).toHaveBeenCalledWith('ATK', 42, 'w3');
    expect(store.map.has('w3')).toBe(false);
  });
});

describe('EscrowManager — failure + retry', () => {
  it('keeps the record settling and retries only the not-yet-done leg', async () => {
    const store = makeStore();
    // Fail exactly once: the payout lands, the burn fails the first time.
    const chain = makeChain({ failFirst: 0 });
    // Make ONLY the burn fail the first time by wrapping it.
    let burnFails = 1;
    chain.chain.burnWager = vi.fn(async (amount: number, wagerId: string) => {
      if (burnFails > 0) {
        burnFails -= 1;
        throw new Error('burn boom');
      }
      chain.calls.push({ op: 'burn', amount, wagerId });
      return `burn-${wagerId}`;
    });
    const mgr = new EscrowManager({ store: store.store, chain: chain.chain, logger: silentLogger });

    await mgr.recordBooked({ wagerId: 'w1', wallet: 'ATK', amount: 100, expeditionId: 'e1' });
    await mgr.settle({ wagerId: 'w1', burn: 90, defenderPayouts: [{ wallet: 'DEF', amount: 10 }] });

    // Payout landed; burn failed → record still settling, retries=1, payout done.
    const rec = store.map.get('w1')!;
    expect(rec.status).toBe('settling');
    expect(rec.retries).toBe(1);
    const payoutLeg = rec.legs!.find((l) => l.kind === 'payout')!;
    const burnLeg = rec.legs!.find((l) => l.kind === 'burn')!;
    expect(payoutLeg.done).toBe(true);
    expect(burnLeg.done).toBe(false);
    expect(chain.chain.payDefender).toHaveBeenCalledTimes(1);

    // Resume: only the burn should re-run (payout NOT repeated → no double-pay).
    await mgr['runLegs'](store.map.get('w1') as EscrowWagerRecord);
    expect(chain.chain.payDefender).toHaveBeenCalledTimes(1); // unchanged
    expect(burnLeg.done || store.map.get('w1') === undefined).toBe(true);
    expect(store.map.has('w1')).toBe(false); // now fully settled
  });

  it('parks a record as failed after exhausting maxRetries (never lost)', async () => {
    const store = makeStore();
    const chain = makeChain({ failFirst: 100 }); // always fails
    const mgr = new EscrowManager({
      store: store.store,
      chain: chain.chain,
      logger: silentLogger,
      maxRetries: 3,
    });
    await mgr.recordBooked({ wagerId: 'w1', wallet: 'ATK', amount: 100, expeditionId: 'e1' });
    // Three settle attempts (each bumps retries by 1 on the failing leg).
    await mgr.settle({ wagerId: 'w1', returnTo: { wallet: 'ATK', amount: 100 } });
    await mgr['runLegs'](store.map.get('w1') as EscrowWagerRecord);
    await mgr['runLegs'](store.map.get('w1') as EscrowWagerRecord);

    const rec = store.map.get('w1')!;
    expect(rec.status).toBe('failed');
    expect(rec.retries).toBeGreaterThanOrEqual(3);
    // Still on the books for manual recovery — never silently dropped.
    expect(store.map.has('w1')).toBe(true);
  });
});

describe('EscrowManager — boot reconciliation', () => {
  it('refunds orphaned active records (raid lost to a restart)', async () => {
    const store = makeStore([
      { wagerId: 'orphan', wallet: 'ATK', amount: 75, status: 'active', retries: 0 },
    ]);
    const chain = makeChain();
    const mgr = new EscrowManager({ store: store.store, chain: chain.chain, logger: silentLogger });

    await mgr.reconcileOnBoot();

    expect(chain.chain.returnWager).toHaveBeenCalledWith('ATK', 75, 'orphan');
    expect(store.map.has('orphan')).toBe(false); // refunded + settled
  });

  it('resumes an in-flight settling record without re-running done legs', async () => {
    const store = makeStore([
      {
        wagerId: 'mid',
        wallet: 'ATK',
        amount: 100,
        status: 'settling',
        retries: 1,
        legs: [
          { kind: 'payout', wallet: 'DEF', amount: 10, done: true, signature: 'pay-DEF' },
          { kind: 'burn', amount: 90, done: false },
        ],
      },
    ]);
    const chain = makeChain();
    const mgr = new EscrowManager({ store: store.store, chain: chain.chain, logger: silentLogger });

    await mgr.reconcileOnBoot();

    // Only the burn leg re-runs; the already-paid defender is NOT paid again.
    expect(chain.chain.payDefender).not.toHaveBeenCalled();
    expect(chain.chain.burnWager).toHaveBeenCalledWith(90, 'mid');
    expect(store.map.has('mid')).toBe(false);
  });

  it('surfaces but does not auto-retry failed records', async () => {
    const store = makeStore([
      {
        wagerId: 'parked',
        wallet: 'ATK',
        amount: 50,
        status: 'failed',
        retries: 10,
        lastError: 'boom',
        legs: [{ kind: 'return', wallet: 'ATK', amount: 50, done: false }],
      },
    ]);
    const chain = makeChain();
    const mgr = new EscrowManager({ store: store.store, chain: chain.chain, logger: silentLogger });

    await mgr.reconcileOnBoot();
    expect(chain.chain.returnWager).not.toHaveBeenCalled();
    expect(store.map.has('parked')).toBe(true);
  });
});
