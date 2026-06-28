/**
 * World-layer wiring for on-chain raid-wager escrow.
 *
 * The `GameWorld` books a verified wager into the `BetEscrow` ledger on raid
 * start (recording durable liability via `onWagerBooked`) and dispatches the
 * resolved outcome as a single settlement plan through `onWagerSettle` at
 * resolution. These tests drive raids to a win / loss / voluntary-forfeit and
 * assert:
 *
 *   - a verified wager is recorded as durable liability on booking;
 *   - a winning raider's wager is returned in full (no burn / payout);
 *   - a losing raider's wager nets to zero across the three-way split
 *     (40% burn / 40% recirculate / 20% stake-weighted defender spoils), and
 *     undelivered defender share recirculates when nobody is eligible;
 *   - a voluntary abandon burns the whole wager;
 *   - a legacy (no-escrow) raid never touches the hooks; and
 *   - an escrow raid does NOT also charge the in-game stake (no double-spend).
 *
 * The hooks are plain injected callbacks (independent of `chainEnabled`), so
 * we spy on them with `chainEnabled: false` and a real in-memory ledger.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { GameWorld } from '../../server/game/world.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };

const ATK = 'ATKatk1111111111111111111111111111';
const DEF = 'DEFdef2222222222222222222222222222';

const CARBON: AsteroidDefinition = {
  id: 'asteroid-carbon',
  name: 'Bennu Carbonaceous',
  resource: 'carbon',
  sector: 'Inner Belt',
  position: { x: 0, y: 0, z: 0 },
  baseDiscoveryTimeMs: 5 * 60 * 1000,
  baseRewardMultiplier: 1.0,
  description: 'Source station.',
};
const GOLD: AsteroidDefinition = {
  id: 'asteroid-gold',
  name: 'Psyche Strike',
  resource: 'gold',
  sector: 'Outer Belt',
  position: { x: 1, y: 0, z: 0 },
  baseDiscoveryTimeMs: 20 * 60 * 1000,
  baseRewardMultiplier: 1.5,
  description: 'Raid target.',
};

const onWagerBooked = vi.fn();
const onWagerSettle = vi.fn();

let world: GameWorld;

beforeEach(async () => {
  onWagerBooked.mockReset();
  onWagerSettle.mockReset();
  world = new GameWorld({
    asteroids: [CARBON, GOLD],
    logger: silentLogger,
    chainEnabled: false,
    onWagerBooked,
    onWagerSettle,
  });
  await world.connectPlayer(ATK);
  await world.connectPlayer(DEF);
});

/** Stage an attacker (home = CARBON) raiding GOLD with a chain-escrowed wager. */
function stageEscrowRaid(opts: {
  atkStake: number;
  atkPower: number;
  defStake: number;
  defPower: number;
  wager: number;
  wagerId?: string;
}): string {
  world.stake(ATK, CARBON.id, opts.atkStake);
  world.joinAsteroid(ATK, CARBON.id);
  world.reportDrillPower(ATK, opts.atkPower);
  if (opts.defStake > 0) {
    world.stake(DEF, GOLD.id, opts.defStake);
    world.joinAsteroid(DEF, GOLD.id);
    world.reportDrillPower(DEF, opts.defPower);
  }
  const r = world.startExpedition(ATK, GOLD.id, 0, {
    wagerId: opts.wagerId ?? 'wager-1',
    amount: opts.wager,
    txSignature: 'deposit-sig',
  });
  if (!r.ok) throw new Error(`expedition failed: ${r.code}`);
  return r.data.expeditionId;
}

describe('GameWorld escrow wiring — booking on start', () => {
  it('books the wager into the ledger and does NOT charge the in-game stake', () => {
    const expId = stageEscrowRaid({
      atkStake: 5_000,
      atkPower: 100_000,
      defStake: 10,
      defPower: 100,
      wager: 100,
    });

    // Wager lives in the escrow ledger under the wagerId.
    const pool = world.betEscrow.getRaidPool('wager-1');
    expect(pool).toBeDefined();
    expect(pool!.totalAttackerBets).toBe(100);
    expect(world.betEscrow.getLockedBetAmount(ATK)).toBe(100);

    // The verified deposit is recorded as durable liability on booking.
    expect(onWagerBooked).toHaveBeenCalledTimes(1);
    expect(onWagerBooked).toHaveBeenCalledWith(
      expect.objectContaining({
        wagerId: 'wager-1',
        wallet: ATK,
        amount: 100,
        expeditionId: expId,
        targetAsteroid: GOLD.id,
        depositSignature: 'deposit-sig',
      }),
    );

    // The expedition itself carries a ZERO stake-bet (no double-charge).
    const exp = world.expeditions.getExpedition(expId)!;
    expect(exp.bets.get(ATK)).toBe(0);
    // Stake is untouched by the wager.
    expect(world.stakeManager.getStakeAtAsteroid(ATK, CARBON.id)).toBe(5_000);
  });

  it('rejects a non-positive escrow wager', () => {
    world.stake(ATK, CARBON.id, 5_000);
    world.joinAsteroid(ATK, CARBON.id);
    world.reportDrillPower(ATK, 100_000);
    const r = world.startExpedition(ATK, GOLD.id, 0, {
      wagerId: 'wager-x',
      amount: 0,
      txSignature: 'sig',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_input');
  });
});

describe('GameWorld escrow wiring — settlement at resolution', () => {
  it('returns the full wager to a winning raider (no burn / payout)', () => {
    stageEscrowRaid({ atkStake: 5_000, atkPower: 100_000, defStake: 10, defPower: 100, wager: 100 });
    world.raidVault.add(GOLD.id, 1_000);

    const results = world.resolveDueRaids([GOLD.id]);
    expect(results).toHaveLength(1);
    expect(results[0]!.attackersWon).toBe(true);

    expect(onWagerSettle).toHaveBeenCalledTimes(1);
    expect(onWagerSettle).toHaveBeenCalledWith({
      wagerId: 'wager-1',
      returnTo: { wallet: ATK, amount: 100 },
    });

    // Ledger pool resolved; nothing left locked.
    expect(world.betEscrow.getRaidPool('wager-1')!.status).toBe('resolved');
    expect(world.betEscrow.hasLockedBets(ATK)).toBe(false);
  });

  it('splits a loss three ways (burn / recirculate / defender) that net to the wager', () => {
    stageEscrowRaid({ atkStake: 100, atkPower: 100, defStake: 50_000, defPower: 50_000, wager: 100 });

    const results = world.resolveDueRaids([GOLD.id]);
    expect(results).toHaveLength(1);
    expect(results[0]!.attackersWon).toBe(false);

    expect(onWagerSettle).toHaveBeenCalledTimes(1);
    const plan = onWagerSettle.mock.calls[0]![0] as {
      wagerId: string;
      returnTo?: unknown;
      burn?: number;
      recirculate?: number;
      defenderPayouts?: Array<{ wallet: string; amount: number }>;
    };
    expect(plan.wagerId).toBe('wager-1');
    expect(plan.returnTo).toBeUndefined();
    // 40% burn / 40% recirculate / 20% defender spoils → together = wager.
    expect(plan.defenderPayouts).toEqual([{ wallet: DEF, amount: 20 }]);
    expect(plan.recirculate).toBe(40);
    expect(plan.burn).toBe(40);
    expect(plan.burn! + plan.recirculate! + plan.defenderPayouts![0]!.amount).toBe(100);
  });

  it('recirculates the undelivered defender share when no defender is eligible for spoils', () => {
    // DEF stakes + mines GOLD (so GOLD keeps strong defense), but DEF then
    // launches its OWN raid from GOLD — miners on expedition still contribute
    // defense yet are EXCLUDED from spoils. So the GOLD raid is repelled with
    // no eligible defender: the 20% defender share rolls into recirculation,
    // and only the 40% burn share is destroyed.
    world.stake(ATK, CARBON.id, 100);
    world.joinAsteroid(ATK, CARBON.id);
    world.reportDrillPower(ATK, 100);
    world.stake(DEF, GOLD.id, 50_000);
    world.joinAsteroid(DEF, GOLD.id);
    world.reportDrillPower(DEF, 50_000);

    // DEF goes raiding CARBON → now on expedition (still defends GOLD at 50%).
    expect(world.startExpedition(DEF, CARBON.id, 0).ok).toBe(true);

    const r = world.startExpedition(ATK, GOLD.id, 0, {
      wagerId: 'wager-2',
      amount: 100,
      txSignature: 'sig',
    });
    if (!r.ok) throw new Error('expedition failed');

    const results = world.resolveDueRaids([GOLD.id]);
    expect(results[0]!.attackersWon).toBe(false);
    // No eligible defender → no payout; the 20% defender share recirculates
    // (40% recirc + 20% rolled-in = 60), leaving only the 40% burn.
    expect(onWagerSettle).toHaveBeenCalledTimes(1);
    const plan = onWagerSettle.mock.calls[0]![0] as {
      burn?: number;
      recirculate?: number;
      defenderPayouts?: unknown;
    };
    expect(plan.defenderPayouts).toBeUndefined();
    expect(plan.recirculate).toBe(60);
    expect(plan.burn).toBe(40);
  });
});

describe('GameWorld escrow wiring — voluntary forfeit + no-escrow raids', () => {
  it('burns the whole wager when the raider voluntarily abandons', () => {
    stageEscrowRaid({ atkStake: 5_000, atkPower: 100_000, defStake: 10, defPower: 100, wager: 100 });

    expect(world.leaveExpedition(ATK).ok).toBe(true);
    expect(onWagerSettle).toHaveBeenCalledTimes(1);
    expect(onWagerSettle).toHaveBeenCalledWith({ wagerId: 'wager-1', burn: 100 });
    expect(world.betEscrow.hasLockedBets(ATK)).toBe(false);
  });

  it('never touches the escrow hooks for a legacy no-bet raid', () => {
    world.stake(ATK, CARBON.id, 5_000);
    world.joinAsteroid(ATK, CARBON.id);
    world.reportDrillPower(ATK, 100_000);
    const r = world.startExpedition(ATK, GOLD.id, 0); // no escrow param
    expect(r.ok).toBe(true);
    world.raidVault.add(GOLD.id, 1_000);

    world.resolveDueRaids([GOLD.id]);
    expect(onWagerBooked).not.toHaveBeenCalled();
    expect(onWagerSettle).not.toHaveBeenCalled();
  });
});
