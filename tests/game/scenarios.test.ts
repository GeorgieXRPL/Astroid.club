/**
 * BG-parity scenario tests.
 *
 * Direct port of `Black-Gold-main/scripts/test-game-simulation.ts`
 * — every BG suite ports to a `describe` here, every BG test ports
 * to an `it` with the same scenario, rethemed to space.
 *
 * Why we need these despite ~370 per-module unit tests: the BG sim
 * suite catches bugs that live in the *seams* between modules.
 * Per-module tests can all pass while the world-level wiring drops
 * a write or routes to the wrong module. These scenarios drive the
 * `GameWorld` (or directly its modules where BG did) and assert on
 * observable end-state, the same way BG asserted against its
 * singletons.
 *
 * Naming convention preserved: each `describe` block names its BG
 * suite. Each `it` includes the BG test name verbatim so a future
 * maintainer can `rg` for "Stake at multiple mines" and find both
 * the BG source and the astroid port.
 *
 * Asteroid setup mirrors BG's four-mine fixture (one per resource
 * class). The IDs differ; the resource semantics do not. The
 * `carbon` class still has the loyalty bonus quirk; `gold` still
 * has the Stellar-Strike (was Gold-Rush) jackpot; `oil` still has
 * syndicate scaling; `silver` still has Solar-Flare (was
 * Silver-Surge) volatility.
 *
 * Authentication: BG had no auth; astroid's `GameWorld` gates
 * every action behind `authedWallets`. Each test's `beforeEach`
 * connects the wallets it'll use. This is the only systematic
 * deviation from BG's source.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import {
  STAKE_TIERS,
  calculateAttackPower,
  calculateDefensePower,
  calculateEffectiveDrillPower,
} from '../../server/game/types.js';
import { GameWorld } from '../../server/game/world.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Wallet base58-ish strings (length 32 each, same constraint as BG).
const WALLET_A = 'AAaa11111111111111111111111111111';
const WALLET_B = 'BBbb22222222222222222222222222222';
const WALLET_C = 'CCcc33333333333333333333333333333';
const WALLET_D = 'DDdd44444444444444444444444444444';
const WALLET_E = 'EEee55555555555555555555555555555';
const WALLET_F = 'FFff66666666666666666666666666666';
const WALLET_ATK = 'ATKatk1111111111111111111111111111';
const WALLET_DEF = 'DEFdef2222222222222222222222222222';

// Asteroid fixtures — one per BG resource class.
const CARBON_ASTEROID: AsteroidDefinition = {
  id: 'asteroid-carbon',
  name: 'Bennu Carbonaceous',
  resource: 'carbon',
  sector: 'Inner Belt',
  position: { x: 0, y: 0, z: 0 },
  baseDiscoveryTimeMs: 5 * 60 * 1000,
  baseRewardMultiplier: 1.0,
  description: 'Steady drill, loyalty bonus after 7 days.',
};

const GOLD_ASTEROID: AsteroidDefinition = {
  id: 'asteroid-gold',
  name: 'Psyche Strike',
  resource: 'gold',
  sector: 'Outer Belt',
  position: { x: 1, y: 0, z: 0 },
  baseDiscoveryTimeMs: 20 * 60 * 1000,
  baseRewardMultiplier: 1.5,
  description: 'Jackpot strikes; raid magnet.',
};

const OIL_ASTEROID: AsteroidDefinition = {
  id: 'asteroid-oil',
  name: 'Themis Volatiles',
  resource: 'oil',
  sector: 'Trojan Cluster',
  position: { x: 2, y: 0, z: 0 },
  baseDiscoveryTimeMs: 10 * 60 * 1000,
  baseRewardMultiplier: 1.2,
  description: 'Yields scale with miner count.',
};

const SILVER_ASTEROID: AsteroidDefinition = {
  id: 'asteroid-silver',
  name: 'Vesta Speculation',
  resource: 'silver',
  sector: 'Inner Belt',
  position: { x: 3, y: 0, z: 0 },
  baseDiscoveryTimeMs: 8 * 60 * 1000,
  baseRewardMultiplier: 1.3,
  description: 'High-variance yields.',
};

const ALL_ASTEROIDS = [CARBON_ASTEROID, GOLD_ASTEROID, OIL_ASTEROID, SILVER_ASTEROID];

const CARBON = CARBON_ASTEROID.id;
const GOLD = GOLD_ASTEROID.id;
const OIL = OIL_ASTEROID.id;
const SILVER = SILVER_ASTEROID.id;

function makeWorld(): GameWorld {
  return new GameWorld({
    asteroids: ALL_ASTEROIDS,
    logger: silentLogger,
    chainEnabled: false,
  });
}

async function connectAll(world: GameWorld, wallets: string[]): Promise<void> {
  for (const w of wallets) await world.connectPlayer(w);
}

// =============================================================================
// SUITE 1: Asteroid Registration and Joining (BG: Mine Registration)
// =============================================================================

describe('BG Sim Suite 1: Asteroid Registration and Joining', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C]);
  });

  it('Registry initializes with all asteroids', () => {
    const a = world.registry.getAsteroid(CARBON);
    expect(a).toBeDefined();
    expect(a!.activeMiners.size).toBe(0);
  });

  it('Add miner to asteroid increases count', () => {
    expect(world.joinAsteroid(WALLET_A, CARBON).ok).toBe(true);
    const a = world.registry.getAsteroid(CARBON)!;
    expect(a.activeMiners.size).toBe(1);
    expect(a.activeMiners.has(WALLET_A)).toBe(true);
  });

  it('Remove miner from asteroid decreases count', () => {
    world.joinAsteroid(WALLET_A, CARBON);
    world.leaveAsteroid(WALLET_A);
    expect(world.registry.getAsteroid(CARBON)!.activeMiners.size).toBe(0);
  });

  it('Join different asteroid removes from previous', () => {
    world.joinAsteroid(WALLET_A, CARBON);
    expect(world.registry.getAsteroid(CARBON)!.activeMiners.size).toBe(1);
    world.joinAsteroid(WALLET_A, GOLD);
    expect(world.registry.getAsteroid(CARBON)!.activeMiners.size).toBe(0);
    expect(world.registry.getAsteroid(GOLD)!.activeMiners.size).toBe(1);
  });

  it('Invalid asteroid ID returns undefined / rejection', () => {
    expect(world.registry.getAsteroid('nonexistent-asteroid')).toBeUndefined();
    const r = world.joinAsteroid(WALLET_A, 'nonexistent-asteroid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_asteroid');
  });

  it('Total miners tracks across asteroids', () => {
    world.joinAsteroid(WALLET_A, CARBON);
    world.joinAsteroid(WALLET_B, GOLD);
    expect(world.registry.getTotalMiners()).toBe(2);
  });

  it('Drill-power tracking on add/remove', () => {
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 25_000);
    expect(world.registry.getTotalDrillPower()).toBeGreaterThanOrEqual(25_000);
  });
});

// =============================================================================
// SUITE 2: Staking Lifecycle (BG: Staking Lifecycle)
// =============================================================================

describe('BG Sim Suite 2: Staking Lifecycle', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C, WALLET_D, WALLET_E, WALLET_F]);
  });

  it('Stake at asteroid records amount', () => {
    expect(world.stake(WALLET_A, CARBON, 100).ok).toBe(true);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_A, CARBON)).toBe(100);
  });

  it('First stake auto-sets home station', () => {
    world.stake(WALLET_A, CARBON, 100);
    const state = world.stakeManager.getMinerState(WALLET_A);
    expect(state.homeStationAsteroidId).toBe(CARBON);
  });

  it('Stake tiers: Base -> Bronze -> Silver -> Gold -> Diamond', () => {
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_B, CARBON).name).toBe('Base');
    world.stake(WALLET_B, CARBON, 10_000);
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_B, CARBON).name).toBe('Bronze');
    world.stake(WALLET_B, CARBON, 40_000); // 50k total
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_B, CARBON).name).toBe('Silver');
    world.stake(WALLET_B, CARBON, 200_000); // 250k total
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_B, CARBON).name).toBe('Gold');
    world.stake(WALLET_B, CARBON, 750_000); // 1M total
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_B, CARBON).name).toBe('Diamond');
  });

  it('Stake at multiple asteroids tracks separately', () => {
    world.stake(WALLET_C, CARBON, 200);
    world.stake(WALLET_C, GOLD, 300);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_C, CARBON)).toBe(200);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_C, GOLD)).toBe(300);
    expect(world.stakeManager.getTotalStake(WALLET_C)).toBe(500);
  });

  it('Partial unstake reduces amount and may downgrade tier', () => {
    world.stake(WALLET_D, CARBON, 50_000);
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_D, CARBON).name).toBe('Silver');
    expect(world.unstake(WALLET_D, CARBON, 20_000).ok).toBe(true);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_D, CARBON)).toBe(30_000);
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_D, CARBON).name).toBe('Bronze');
  });

  it('Full unstake leaves zero balance', () => {
    world.stake(WALLET_E, CARBON, 500);
    world.unstake(WALLET_E, CARBON, 500);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_E, CARBON)).toBe(0);
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_E, CARBON).name).toBe('Base');
  });

  it('Re-stake after full unstake works', () => {
    world.stake(WALLET_F, CARBON, 500);
    world.unstake(WALLET_F, CARBON, 500);
    world.stake(WALLET_F, CARBON, 250_000);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_F, CARBON)).toBe(250_000);
    expect(world.stakeManager.getStakeTierAtAsteroid(WALLET_F, CARBON).name).toBe('Gold');
  });

  it('Stake 0 or negative amount rejected', () => {
    const r0 = world.stake(WALLET_A, CARBON, 0);
    expect(r0.ok).toBe(false);
    if (!r0.ok) expect(r0.code).toBe('invalid_input');
    const rNeg = world.stake(WALLET_A, CARBON, -100);
    expect(rNeg.ok).toBe(false);
    if (!rNeg.ok) expect(rNeg.code).toBe('invalid_input');
  });

  it('Unstake from asteroid with no stake fails', () => {
    const r = world.unstake(WALLET_A, CARBON, 100);
    expect(r.ok).toBe(false);
  });

  it('Unstake more than staked caps to staked amount (BG quirk preserved)', () => {
    world.stake(WALLET_B, CARBON, 100);
    // BG capped overshoots silently. Astroid does the same — see
    // stake-manager.ts. Verify: we end up at zero after a 9999 unstake.
    world.unstake(WALLET_B, CARBON, 9999);
    expect(world.stakeManager.getStakeAtAsteroid(WALLET_B, CARBON)).toBe(0);
  });
});

// =============================================================================
// SUITE 3: Drill Power and Defense Power (BG: Hashrate and Defense Power)
// =============================================================================

describe('BG Sim Suite 3: Drill Power and Defense Power', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C, WALLET_D, WALLET_E, WALLET_F]);
  });

  it('Effective drill power scales with stake tier', () => {
    world.stake(WALLET_A, CARBON, 50_000); // Silver tier
    const effective = world.stakeManager.getEffectiveDrillPower(WALLET_A, 10_000, CARBON);
    expect(effective).toBeCloseTo(20_000, 0); // 10000 * 2.0
  });

  it('Carbon loyalty bonus after 7 days', () => {
    world.stake(WALLET_B, CARBON, 10_000); // Bronze (1.5x)
    const state = world.stakeManager.getMinerState(WALLET_B);
    state.loyaltyDays = 7;
    const stakes = world.stakeManager.getWalletStakes(WALLET_B);
    expect(stakes.length).toBeGreaterThan(0);
    if (stakes[0]) stakes[0].loyaltyDays = 7;
    const effective = world.stakeManager.getEffectiveDrillPower(WALLET_B, 10_000, CARBON);
    // 10000 * 1.5 * 1.1 = 16500
    expect(effective).toBeCloseTo(16_500, 0);
  });

  it('No loyalty bonus for non-carbon asteroids', () => {
    world.stake(WALLET_C, GOLD, 10_000); // Bronze (1.5x)
    const state = world.stakeManager.getMinerState(WALLET_C);
    state.loyaltyDays = 30;
    const effective = world.stakeManager.getEffectiveDrillPower(WALLET_C, 10_000, GOLD);
    expect(effective).toBeCloseTo(15_000, 0); // No loyalty multiplier
  });

  it('Defense power with home-station bonus', () => {
    world.stake(WALLET_D, CARBON, 50_000); // Silver, sets home
    const defense = world.stakeManager.getDefensePower(WALLET_D, CARBON);
    // 50000 * 1.5 * 1.5 = 112500
    expect(defense).toBeCloseTo(112_500, 0);
  });

  it('Defense power without home-station bonus', () => {
    world.stake(WALLET_E, CARBON, 50_000); // Home = CARBON
    world.stake(WALLET_E, GOLD, 50_000); // Visiting GOLD (Silver)
    const defense = world.stakeManager.getDefensePower(WALLET_E, GOLD);
    // 50000 * 1.5 * 1.0 (no home bonus) = 75000
    expect(defense).toBeCloseTo(75_000, 0);
  });

  it('Total defense power sums all stakers', () => {
    world.stake(WALLET_A, CARBON, 100);
    world.stake(WALLET_B, CARBON, 100);
    expect(world.stakeManager.getTotalDefensePower(CARBON)).toBeGreaterThan(0);
  });
});

// =============================================================================
// SUITE 4: Cooldown System (BG: Cooldown System)
// =============================================================================

describe('BG Sim Suite 4: Cooldown System', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C, WALLET_D, WALLET_E, WALLET_F]);
  });

  it('Apply home_station_switch cooldown blocks action', () => {
    world.cooldowns.applyCooldown(WALLET_A, 'home_station_switch');
    const error = world.cooldowns.checkAction(WALLET_A, 'home_station_switch');
    expect(error).not.toBeNull();
    expect(typeof error).toBe('string');
  });

  it('Different cooldown types are independent', () => {
    world.cooldowns.applyCooldown(WALLET_B, 'expedition_start');
    expect(world.cooldowns.checkAction(WALLET_B, 'home_station_switch')).toBeNull();
  });

  it('Cooldown has correct remaining time', () => {
    world.cooldowns.applyCooldown(WALLET_C, 'expedition_start'); // 10 minutes
    const remaining = world.cooldowns.getRemainingCooldown(WALLET_C, 'expedition_start');
    expect(remaining).toBeGreaterThan(9 * 60_000);
    expect(remaining).toBeLessThanOrEqual(10 * 60_000);
  });

  it('Clear cooldown allows action', () => {
    world.cooldowns.applyCooldown(WALLET_D, 'rally_defense');
    world.cooldowns.clearCooldown(WALLET_D, 'rally_defense');
    expect(world.cooldowns.checkAction(WALLET_D, 'rally_defense')).toBeNull();
  });

  it('Cleanup removes expired cooldowns', () => {
    world.cooldowns.applyCooldown(WALLET_E, 'expedition_recovery');
    const active = world.cooldowns.getActiveCooldowns(WALLET_E);
    expect(active.length).toBeGreaterThan(0);
    // Force-expire by mutating the entry's expiry timestamp.
    if (active[0]) active[0].expiresAt = new Date(Date.now() - 1_000);
    world.cooldowns.cleanupExpired();
    expect(world.cooldowns.getActiveCooldowns(WALLET_E).length).toBe(0);
  });

  it('No cooldown on fresh wallet', () => {
    expect(world.cooldowns.checkAction(WALLET_F, 'expedition_start')).toBeNull();
  });
});

// =============================================================================
// SUITE 5: Expedition Lifecycle (BG: Expedition Lifecycle)
// =============================================================================

describe('BG Sim Suite 5: Expedition Lifecycle', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C, WALLET_D]);
  });

  it('Create expedition from source to target', async () => {
    world.stake(WALLET_A, CARBON, 500);
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 10_000);

    const r = world.startExpedition(WALLET_A, GOLD, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const exp = world.expeditions
        .getActiveExpeditions()
        .find((e) => e.id === r.data.expeditionId);
      expect(exp).toBeDefined();
      expect(exp!.status).toBe('active');
      expect(exp!.sourceAsteroidId).toBe(CARBON);
      expect(exp!.targetAsteroidId).toBe(GOLD);
      expect(exp!.attackPower).toBeGreaterThan(0);
    }
  });

  it('Cannot raid own asteroid', () => {
    world.stake(WALLET_B, CARBON, 500);
    world.joinAsteroid(WALLET_B, CARBON);
    world.reportDrillPower(WALLET_B, 10_000);

    const r = world.startExpedition(WALLET_B, CARBON, 0); // home = CARBON, target = CARBON
    expect(r.ok).toBe(false);
  });

  it('Without home station, expedition is rejected', () => {
    // No prior stake → no home station
    const r = world.startExpedition(WALLET_C, GOLD, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('home_station_required');
  });

  it('Cannot start two expeditions simultaneously', () => {
    world.stake(WALLET_D, CARBON, 500);
    world.joinAsteroid(WALLET_D, CARBON);
    world.reportDrillPower(WALLET_D, 10_000);

    const exp1 = world.startExpedition(WALLET_D, SILVER, 0);
    expect(exp1.ok).toBe(true);

    // Even after clearing the cooldown (BG semantic), the second
    // expedition is rejected because the wallet is still on the
    // first one.
    world.cooldowns.clearCooldown(WALLET_D, 'expedition_start');
    const exp2 = world.startExpedition(WALLET_D, OIL, 0);
    expect(exp2.ok).toBe(false);
  });

  it('Cannot raid asteroid with active defense buff (immunity)', () => {
    world.stake(WALLET_A, CARBON, 500);
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 10_000);
    world.registry.applyDefenseBuff(SILVER);

    const r = world.startExpedition(WALLET_A, SILVER, 0);
    expect(r.ok).toBe(false);
  });

  it('Join existing expedition adds attack power', () => {
    world.stake(WALLET_A, CARBON, 500);
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 10_000);
    world.stake(WALLET_B, CARBON, 500);
    world.joinAsteroid(WALLET_B, CARBON);
    world.reportDrillPower(WALLET_B, 10_000);

    const r = world.startExpedition(WALLET_A, OIL, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const exp = world.expeditions.getActiveExpeditions().find((e) => e.id === r.data.expeditionId)!;
    const initial = exp.attackPower;
    const joined = world.expeditions.joinExpedition(exp.id, WALLET_B, 10_000, 0);
    expect(joined).toBe(true);
    expect(exp.attackPower).toBeGreaterThan(initial);
  });

  it('Leave expedition forfeits bet (returns true)', () => {
    world.stake(WALLET_A, CARBON, 500);
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 10_000);
    const r = world.startExpedition(WALLET_A, GOLD, 50);
    expect(r.ok).toBe(true);
    expect(world.leaveExpedition(WALLET_A).ok).toBe(true);
  });

  it('Cooldown applied after expedition creation', () => {
    world.stake(WALLET_A, CARBON, 500);
    world.joinAsteroid(WALLET_A, CARBON);
    world.reportDrillPower(WALLET_A, 10_000);
    world.startExpedition(WALLET_A, GOLD, 0);
    expect(world.cooldowns.checkAction(WALLET_A, 'expedition_start')).not.toBeNull();
  });
});

// =============================================================================
// SUITE 6: Raid Resolution (BG: Raid Resolution)
// =============================================================================

describe('BG Sim Suite 6: Raid Resolution', () => {
  let world: GameWorld;
  beforeEach(async () => {
    world = makeWorld();
    await connectAll(world, [WALLET_ATK, WALLET_DEF]);
  });

  /**
   * Helper: stage an attacker at CARBON with `atkStake`/`atkPower` and
   * a defender at `targetId` with `defStake`/`defPower`, then start
   * the expedition. Returns the expedition id.
   */
  function stageRaid(
    targetId: string,
    atkStake: number,
    atkPower: number,
    defStake: number,
    defPower: number,
    betAmount = 0,
  ): string {
    world.stake(WALLET_ATK, CARBON, atkStake);
    world.joinAsteroid(WALLET_ATK, CARBON);
    world.reportDrillPower(WALLET_ATK, atkPower);
    world.stake(WALLET_DEF, targetId, defStake);
    world.joinAsteroid(WALLET_DEF, targetId);
    world.reportDrillPower(WALLET_DEF, defPower);
    const r = world.startExpedition(WALLET_ATK, targetId, betAmount);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expedition failed');
    return r.data.expeditionId;
  }

  it('Attacker wins when power overwhelms defense', () => {
    const id = stageRaid(GOLD, 5_000, 100_000, 10, 100);
    world.raidEngine.setPendingYield(GOLD, 1_000);
    const result = world.raidEngine.resolveRaid(id);
    expect(result).not.toBeNull();
    expect(result!.attackersWon).toBe(true);
    expect(result!.stolenYield).toBeGreaterThan(0);
  });

  it('Tick-driven resolution steals from the treasury and credits attacker pending yield', () => {
    stageRaid(GOLD, 5_000, 100_000, 10, 100);
    // Fund the target asteroid's raid-vault treasury — the steal source.
    world.raidVault.add(GOLD, 1_000);
    const events: Array<{ event: string; data: unknown }> = [];
    world.setBroadcaster((event, data) => events.push({ event, data }));

    const before = world.stakeManager.getPendingYield(WALLET_ATK);
    const results = world.resolveDueRaids([GOLD]);

    expect(results.length).toBe(1);
    expect(results[0]!.attackersWon).toBe(true);
    expect(results[0]!.stolenYield).toBeGreaterThan(0);
    // Attacker is credited the stolen yield as redeemable pending balance.
    expect(world.stakeManager.getPendingYield(WALLET_ATK)).toBeGreaterThan(before);
    // The treasury is debited (transfer, not mint).
    expect(world.raidVault.getBalance(GOLD)).toBeLessThan(1_000);
    // Clients are notified.
    expect(events.some((e) => e.event === 'raid_resolved')).toBe(true);
  });

  it('Defender wins when defense holds', () => {
    // Bet must be <= 20% of stake (100 * 0.2 = 20)
    const id = stageRaid(SILVER, 100, 100, 5_000, 50_000, 20);
    const result = world.raidEngine.resolveRaid(id);
    expect(result).not.toBeNull();
    expect(result!.attackersWon).toBe(false);
  });

  it('Defender spoils: bets burned on failed raid', () => {
    const initialBurned = world.raidEngine.getStats().totalBurned;
    const id = stageRaid(SILVER, 100, 100, 5_000, 50_000, 20);
    const result = world.raidEngine.resolveRaid(id);
    expect(result!.attackersWon).toBe(false);
    expect(world.raidEngine.getStats().totalBurned).toBeGreaterThan(initialBurned);
  });

  it('Defense buff applied after successful defense', () => {
    const id = stageRaid(SILVER, 100, 100, 5_000, 50_000, 0);
    world.raidEngine.resolveRaid(id);
    expect(world.registry.hasRaidImmunity(SILVER)).toBe(true);
  });

  it('Resolve all raids against one asteroid yields >= 1 result', () => {
    stageRaid(OIL, 100, 100, 5_000, 50_000, 0);
    const results = world.raidEngine.resolveAllRaids(OIL);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// SUITE 7: Bet Escrow (BG: Bet Escrow)
// =============================================================================

describe('BG Sim Suite 7: Bet Escrow', () => {
  let world: GameWorld;
  beforeEach(() => {
    world = makeWorld();
  });

  it('Create raid pool', () => {
    const pool = world.betEscrow.createRaidPool('raid-1', GOLD, CARBON);
    expect(pool.raidId).toBe('raid-1');
    expect(pool.status).toBe('active');
    expect(pool.totalAttackerBets).toBe(0);
  });

  it('Place bet locks tokens', () => {
    world.betEscrow.createRaidPool('raid-2', GOLD, CARBON);
    const bet = world.betEscrow.placeBet('raid-2', WALLET_A, CARBON, 100, 'attacker', 'sig123');
    expect(bet.amount).toBe(100);
    expect(bet.status).toBe('locked');
    expect(world.betEscrow.hasLockedBets(WALLET_A)).toBe(true);
    expect(world.betEscrow.getLockedBetAmount(WALLET_A)).toBe(100);
  });

  it('Cannot place duplicate bet on same raid', () => {
    world.betEscrow.createRaidPool('raid-3', GOLD, CARBON);
    world.betEscrow.placeBet('raid-3', WALLET_A, CARBON, 100, 'attacker', 'sig1');
    expect(() => {
      world.betEscrow.placeBet('raid-3', WALLET_A, CARBON, 50, 'attacker', 'sig2');
    }).toThrow();
  });

  it('Resolve raid: defenders win, bets burned', () => {
    world.betEscrow.createRaidPool('raid-4', GOLD, CARBON);
    world.betEscrow.placeBet('raid-4', WALLET_A, CARBON, 100, 'attacker', 'sig1');
    const defenderStakes = new Map<string, number>([[WALLET_B, 500]]);
    const resolution = world.betEscrow.resolveRaid('raid-4', 'defender', defenderStakes);
    expect(resolution.winningSide).toBe('defender');
    expect(resolution.totalBurned).toBeGreaterThan(0);
    expect(resolution.totalDistributedToDefenders).toBe(10); // 10% of 100
  });

  it('Resolve raid: attackers win, bets returned', () => {
    world.betEscrow.createRaidPool('raid-5', GOLD, CARBON);
    world.betEscrow.placeBet('raid-5', WALLET_A, CARBON, 200, 'attacker', 'sig1');
    const resolution = world.betEscrow.resolveRaid('raid-5', 'attacker', new Map());
    expect(resolution.winningSide).toBe('attacker');
    expect(resolution.totalReturnedToWinners).toBe(200);
    expect(resolution.totalBurned).toBe(0);
  });

  it('Cleanup old resolved pools', () => {
    world.betEscrow.createRaidPool('raid-old', GOLD, CARBON);
    world.betEscrow.placeBet('raid-old', WALLET_A, CARBON, 50, 'attacker', 'sig1');
    world.betEscrow.resolveRaid('raid-old', 'defender', new Map());
    const pool = world.betEscrow.getRaidPool('raid-old');
    expect(pool).toBeDefined();
    if (pool) pool.resolvedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const cleaned = world.betEscrow.cleanupResolvedPools(24 * 60 * 60 * 1000);
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// SUITE 8: Refinery Distribution (BG: Vault Distribution)
// =============================================================================

describe('BG Sim Suite 8: Refinery Distribution', () => {
  let world: GameWorld;
  beforeEach(() => {
    world = makeWorld();
  });

  it('Yield split: 70% finder, 30% refinery', () => {
    const split = world.refinery.calculateYieldSplit(1_000);
    expect(split.finderShare).toBe(700);
    expect(split.refineryShare).toBe(300);
  });

  it('Add yield to refinery', () => {
    world.refinery.addToRefinery(CARBON, 300);
    const stats = world.refinery.getRefineryStats(CARBON);
    expect(stats).toBeDefined();
    expect(stats!.balance).toBe(300);
    expect(stats!.pendingDistribution).toBe(300);
  });

  it('Distribute refinery proportionally to contributors', () => {
    world.refinery.addToRefinery(CARBON, 1_000);
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_A,
      currentDrillPower: 20_000,
      stakeAmount: 500,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_B,
      currentDrillPower: 10_000,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    const result = world.refinery.distributeRefinery(CARBON);
    expect(result).not.toBeNull();
    expect(result!.totalDistributed).toBeGreaterThan(0);
    expect(result!.minerCount).toBe(2);
    const payoutA = result!.payouts.get(WALLET_A) ?? 0;
    const payoutB = result!.payouts.get(WALLET_B) ?? 0;
    expect(payoutA).toBeGreaterThan(payoutB); // A: more drill power AND staked
  });

  it('No contributors = no distribution', () => {
    world.refinery.addToRefinery(CARBON, 1_000);
    expect(world.refinery.distributeRefinery(CARBON)).toBeNull();
  });

  it('Below minimum threshold = no distribution', () => {
    world.refinery.addToRefinery(CARBON, 0.5); // < MIN_DISTRIBUTION_AMOUNT (1)
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_A,
      currentDrillPower: 10_000,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    expect(world.refinery.distributeRefinery(CARBON)).toBeNull();
  });

  it('Contributions cleared after distribution', () => {
    world.refinery.addToRefinery(CARBON, 100);
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_A,
      currentDrillPower: 10_000,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    world.refinery.distributeRefinery(CARBON);
    const stats = world.refinery.getRefineryStats(CARBON);
    expect(stats!.contributorCount).toBe(0);
  });

  it('Pending distribution resets after payout', () => {
    world.refinery.addToRefinery(CARBON, 500);
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_A,
      currentDrillPower: 10_000,
      stakeAmount: 0,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    world.refinery.distributeRefinery(CARBON);
    expect(world.refinery.getRefineryStats(CARBON)!.pendingDistribution).toBe(0);
  });
});

// =============================================================================
// SUITE 9: Full Game Flow (BG: Full Game Flow Integration)
// =============================================================================

describe('BG Sim Suite 9: Full Game Flow', () => {
  it('Complete lifecycle: join → stake → raid → resolution', async () => {
    const world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B]);

    world.joinAsteroid(WALLET_A, CARBON);
    world.stake(WALLET_A, CARBON, 1_000); // Gold tier
    world.reportDrillPower(WALLET_A, 25_000);

    world.joinAsteroid(WALLET_B, GOLD);
    world.stake(WALLET_B, GOLD, 5_000); // Diamond tier
    world.reportDrillPower(WALLET_B, 50_000);

    const r = world.startExpedition(WALLET_A, GOLD, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    world.raidEngine.setPendingYield(GOLD, 500);
    const result = world.raidEngine.resolveRaid(r.data.expeditionId);
    expect(result).not.toBeNull();
    expect(typeof result!.attackersWon).toBe('boolean');
    expect(result!.defensePower).toBeGreaterThanOrEqual(0);
    expect(result!.attackPower).toBeGreaterThanOrEqual(0);
  });

  it('Multi-player scenario: 3 miners at different asteroids', async () => {
    const world = makeWorld();
    await connectAll(world, [WALLET_A, WALLET_B, WALLET_C]);

    world.joinAsteroid(WALLET_A, CARBON);
    world.stake(WALLET_A, CARBON, 500);
    world.reportDrillPower(WALLET_A, 20_000);

    world.joinAsteroid(WALLET_B, SILVER);
    world.stake(WALLET_B, SILVER, 1_000);
    world.reportDrillPower(WALLET_B, 30_000);

    world.joinAsteroid(WALLET_C, OIL);
    world.stake(WALLET_C, OIL, 200);
    world.reportDrillPower(WALLET_C, 15_000);

    expect(world.registry.getTotalMiners()).toBeGreaterThanOrEqual(3);
    expect(world.stakeManager.getTotalStake(WALLET_A)).toBe(500);
    expect(world.stakeManager.getTotalStake(WALLET_B)).toBe(1_000);
    expect(world.stakeManager.getTotalStake(WALLET_C)).toBe(200);

    const r = world.startExpedition(WALLET_A, SILVER, 0);
    expect(r.ok).toBe(true);
    expect(world.expeditions.getActiveExpeditions().length).toBeGreaterThanOrEqual(1);
  });

  it('Refinery distribution after discovery', () => {
    const world = makeWorld();
    const split = world.refinery.calculateYieldSplit(100);
    expect(split.finderShare).toBe(70);
    expect(split.refineryShare).toBe(30);
    world.refinery.addToRefinery(CARBON, split.refineryShare);

    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_A,
      currentDrillPower: 30_000,
      stakeAmount: 1_000,
      loyaltyDays: 7,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });
    world.refinery.updateMinerContribution({
      asteroidId: CARBON,
      walletAddress: WALLET_B,
      currentDrillPower: 10_000,
      stakeAmount: 100,
      loyaltyDays: 0,
      resource: 'carbon',
      deltaSeconds: 3_600,
    });

    const result = world.refinery.distributeRefinery(CARBON);
    expect(result).not.toBeNull();
    expect(result!.totalDistributed).toBeLessThanOrEqual(30);
    const payoutA = result!.payouts.get(WALLET_A) ?? 0;
    const payoutB = result!.payouts.get(WALLET_B) ?? 0;
    expect(payoutA).toBeGreaterThan(0);
    expect(payoutB).toBeGreaterThanOrEqual(0);
    expect(payoutA).toBeGreaterThan(payoutB);
  });

  it('Economic balance: burns reduce circulating $ASTROID', async () => {
    const world = makeWorld();
    await connectAll(world, [WALLET_ATK, WALLET_DEF]);

    world.stake(WALLET_ATK, CARBON, 100);
    world.joinAsteroid(WALLET_ATK, CARBON);
    world.reportDrillPower(WALLET_ATK, 100);
    world.stake(WALLET_DEF, SILVER, 5_000);
    world.joinAsteroid(WALLET_DEF, SILVER);
    world.reportDrillPower(WALLET_DEF, 50_000);

    const initialBurned = world.raidEngine.getStats().totalBurned;
    const r = world.startExpedition(WALLET_ATK, SILVER, 20); // Bet ≤ 20% of stake
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    world.raidEngine.resolveRaid(r.data.expeditionId);
    expect(world.raidEngine.getStats().totalBurned).toBeGreaterThan(initialBurned);
  });
});

// =============================================================================
// FORMULA AUDIT BOOKEND: re-assert BG formula values that the unit
// tests already cover, but anchored against the imports above so a
// regression in the import path is also caught here.
// =============================================================================

describe('BG formula audit (anchored re-assertions)', () => {
  it('STAKE_TIERS shape: Base floor and Diamond ceiling (raised thresholds)', () => {
    expect(STAKE_TIERS).toHaveLength(5);
    expect(STAKE_TIERS[0]).toEqual({
      minStake: 0,
      name: 'Base',
      drillPowerMultiplier: 1.0,
      defenseMultiplier: 1.0,
    });
    expect(STAKE_TIERS[4]).toEqual({
      minStake: 1_000_000,
      name: 'Diamond',
      drillPowerMultiplier: 3.0,
      defenseMultiplier: 2.0,
    });
  });

  it('calculateEffectiveDrillPower applies multipliers like BG', () => {
    expect(calculateEffectiveDrillPower(10_000, 0, 0, 'carbon')).toBe(10_000);
    expect(calculateEffectiveDrillPower(10_000, 10_000, 0, 'carbon')).toBe(15_000);
    expect(calculateEffectiveDrillPower(10_000, 1_000_000, 0, 'carbon')).toBe(30_000);
    expect(calculateEffectiveDrillPower(10_000, 10_000, 7, 'carbon')).toBe(16_500);
    expect(calculateEffectiveDrillPower(10_000, 10_000, 7, 'gold')).toBe(15_000);
  });

  it('calculateDefensePower applies tier and home-station bonus like BG', () => {
    expect(calculateDefensePower(10_000, false)).toBe(12_000);
    expect(calculateDefensePower(10_000, true)).toBe(18_000);
    expect(calculateDefensePower(50_000, false)).toBe(75_000);
    expect(calculateDefensePower(50_000, true)).toBe(112_500);
    expect(calculateDefensePower(250_000, true)).toBe(675_000);
    expect(calculateDefensePower(1_000_000, true)).toBe(3_000_000);
  });

  it('calculateAttackPower components match BG (50% drill + 10% stake)', () => {
    expect(calculateAttackPower(10_000, 100)).toBe(5_010);
    expect(calculateAttackPower(0, 1_000)).toBe(100);
    expect(calculateAttackPower(50_000, 0)).toBe(25_000);
    expect(calculateAttackPower(0, 0)).toBe(0);
  });
});
