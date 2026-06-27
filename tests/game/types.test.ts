/**
 * Game-formula audit. The values asserted below mirror Black-Gold's
 * `scripts/test-game-formulas.ts` — if any of these change, the port has
 * silently introduced a numerical drift and the audit fails.
 *
 * BG version covered: v3.4.1.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  STAKE_TIERS,
  calculateAttackPower,
  calculateDefensePower,
  calculateEffectiveDrillPower,
  calculateSyndicateMultiplier,
  getAstroidUsdPrice,
  getRaidDrillSoftCap,
  getStakeTier,
  getStakeTierProgress,
  rollSolarFlareMultiplier,
  rollStellarStrikeJackpot,
  setAstroidUsdPrice,
  setRaidDrillSoftCap,
  softCapAttackDrill,
} from '../../server/game/types.js';

describe('STAKE_TIERS — exact values from BG', () => {
  it('has five tiers in monotonic order', () => {
    expect(STAKE_TIERS).toHaveLength(5);
    for (let i = 1; i < STAKE_TIERS.length; i++) {
      expect(STAKE_TIERS[i]!.minStake).toBeGreaterThan(STAKE_TIERS[i - 1]!.minStake);
      expect(STAKE_TIERS[i]!.drillPowerMultiplier).toBeGreaterThan(
        STAKE_TIERS[i - 1]!.drillPowerMultiplier,
      );
    }
  });

  it('uses the raised default thresholds (multipliers unchanged from BG)', () => {
    expect(STAKE_TIERS).toEqual([
      { minStake: 0, name: 'Base', drillPowerMultiplier: 1.0, defenseMultiplier: 1.0 },
      { minStake: 10_000, name: 'Bronze', drillPowerMultiplier: 1.5, defenseMultiplier: 1.2 },
      { minStake: 50_000, name: 'Silver', drillPowerMultiplier: 2.0, defenseMultiplier: 1.5 },
      { minStake: 250_000, name: 'Gold', drillPowerMultiplier: 2.5, defenseMultiplier: 1.8 },
      { minStake: 1_000_000, name: 'Diamond', drillPowerMultiplier: 3.0, defenseMultiplier: 2.0 },
    ]);
  });
});

describe('getStakeTier', () => {
  it('returns Base for stake = 0', () => {
    expect(getStakeTier(0).name).toBe('Base');
  });
  it('returns Base for negative stake (defensive)', () => {
    expect(getStakeTier(-1).name).toBe('Base');
  });
  it('returns Base just below Bronze threshold', () => {
    expect(getStakeTier(9_999).name).toBe('Base');
  });
  it('returns Bronze at the Bronze threshold', () => {
    expect(getStakeTier(10_000).name).toBe('Bronze');
  });
  it('returns Silver just above the Silver threshold', () => {
    expect(getStakeTier(50_001).name).toBe('Silver');
  });
  it('returns Diamond for stake exceeding all thresholds', () => {
    expect(getStakeTier(10_000_000).name).toBe('Diamond');
  });
  it('returns Diamond at MAX_SAFE_INTEGER (overflow guard)', () => {
    expect(getStakeTier(Number.MAX_SAFE_INTEGER).name).toBe('Diamond');
  });
});

describe('calculateEffectiveDrillPower', () => {
  it('applies tier multiplier without loyalty bonus', () => {
    // base 100, stake 10k (Bronze, 1.5x), 0 loyalty days, gold (no bonus)
    expect(calculateEffectiveDrillPower(100, 10_000, 0, 'gold')).toBeCloseTo(150);
  });

  it('applies loyalty bonus only on carbon-class with 7+ days', () => {
    // base 100, stake 10k (Bronze, 1.5x), 7 days, carbon => 1.5 * 1.1 = 1.65
    expect(calculateEffectiveDrillPower(100, 10_000, 7, 'carbon')).toBeCloseTo(165);
  });

  it('does not apply loyalty bonus below 7 days even on carbon', () => {
    expect(calculateEffectiveDrillPower(100, 10_000, 6, 'carbon')).toBeCloseTo(150);
  });

  it('does not apply loyalty bonus on non-carbon even with high days', () => {
    expect(calculateEffectiveDrillPower(100, 10_000, 100, 'silver')).toBeCloseTo(150);
    expect(calculateEffectiveDrillPower(100, 10_000, 100, 'gold')).toBeCloseTo(150);
    expect(calculateEffectiveDrillPower(100, 10_000, 100, 'oil')).toBeCloseTo(150);
  });

  it('returns 0 for base 0 regardless of multiplier', () => {
    expect(calculateEffectiveDrillPower(0, 5000, 7, 'carbon')).toBe(0);
  });
});

describe('calculateDefensePower', () => {
  it('multiplies stake by tier defense multiplier', () => {
    // 50k stake (Silver, 1.5x defense), not home station => 50000 * 1.5 = 75000
    expect(calculateDefensePower(50_000, false)).toBeCloseTo(75_000);
  });

  it('applies 1.5x home-station bonus', () => {
    // 50k stake (Silver, 1.5x), home station => 50000 * 1.5 * 1.5 = 112500
    expect(calculateDefensePower(50_000, true)).toBeCloseTo(112_500);
  });

  it('returns 0 for stake 0 regardless of home-station flag', () => {
    expect(calculateDefensePower(0, true)).toBe(0);
    expect(calculateDefensePower(0, false)).toBe(0);
  });

  it('handles Diamond tier correctly', () => {
    // 1M stake (Diamond, 2.0x), home station => 1_000_000 * 2.0 * 1.5 = 3_000_000
    expect(calculateDefensePower(1_000_000, true)).toBeCloseTo(3_000_000);
  });
});

describe('calculateAttackPower', () => {
  it('returns half drill power plus 10% of stake (below soft cap)', () => {
    expect(calculateAttackPower(200, 1000)).toBeCloseTo(200);
    expect(calculateAttackPower(0, 0)).toBe(0);
    expect(calculateAttackPower(100, 0)).toBeCloseTo(50);
    expect(calculateAttackPower(0, 100)).toBeCloseTo(10);
  });
});

describe('raid drill soft cap (whale balancing)', () => {
  const original = getRaidDrillSoftCap();
  afterEach(() => {
    setRaidDrillSoftCap(original.softCap, original.slope);
  });

  it('defaults to 5M knee / 0.15 slope', () => {
    expect(original.softCap).toBe(5_000_000);
    expect(original.slope).toBeCloseTo(0.15);
  });

  it('passes drill through unchanged at or below the soft cap', () => {
    setRaidDrillSoftCap(5_000_000, 0.15);
    expect(softCapAttackDrill(0)).toBe(0);
    expect(softCapAttackDrill(1_000_000)).toBe(1_000_000);
    expect(softCapAttackDrill(5_000_000)).toBe(5_000_000);
  });

  it('compresses drill above the soft cap with diminishing returns', () => {
    setRaidDrillSoftCap(5_000_000, 0.15);
    // 23M drill → 5M + (23M - 5M) * 0.15 = 5M + 2.7M = 7.7M
    expect(softCapAttackDrill(23_000_000)).toBeCloseTo(7_700_000);
    // attack power for the 23M-drill / 7.66M-stake whale: 7.7M*0.5 + 7.66M*0.1
    expect(calculateAttackPower(23_000_000, 7_660_000)).toBeCloseTo(4_616_000);
  });

  it('stays monotonic — more drill is always (slightly) more attack power', () => {
    setRaidDrillSoftCap(5_000_000, 0.15);
    expect(softCapAttackDrill(10_000_000)).toBeGreaterThan(softCapAttackDrill(8_000_000));
    expect(softCapAttackDrill(50_000_000)).toBeGreaterThan(softCapAttackDrill(23_000_000));
  });

  it('can be disabled with softCap <= 0', () => {
    setRaidDrillSoftCap(0);
    expect(softCapAttackDrill(23_000_000)).toBe(23_000_000);
    expect(calculateAttackPower(23_000_000, 0)).toBeCloseTo(11_500_000);
  });
});

describe('calculateSyndicateMultiplier', () => {
  it('returns 1.0 for 1 or fewer miners', () => {
    expect(calculateSyndicateMultiplier(0)).toBe(1.0);
    expect(calculateSyndicateMultiplier(1)).toBe(1.0);
  });

  it('returns 3.0 for 50+ miners', () => {
    expect(calculateSyndicateMultiplier(50)).toBe(3.0);
    expect(calculateSyndicateMultiplier(100)).toBe(3.0);
  });

  it('scales linearly between 1 and 50', () => {
    // Halfway: 25 miners => 1.0 + 24 * (2/49) = 1.0 + 0.97959… ≈ 1.9796
    expect(calculateSyndicateMultiplier(25)).toBeCloseTo(1.9796, 3);
  });

  it('produces strictly monotonic output across the scaling band', () => {
    let prev = calculateSyndicateMultiplier(2);
    for (let n = 3; n <= 50; n++) {
      const cur = calculateSyndicateMultiplier(n);
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });
});

describe('rollSolarFlareMultiplier (was: rollSilverSurgeMultiplier)', () => {
  it('always returns a value in [0.5, 2.0)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = rollSolarFlareMultiplier();
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThan(2.0);
    }
  });

  it('has a mean approximating 1.25 over many trials', () => {
    let sum = 0;
    const N = 50_000;
    for (let i = 0; i < N; i++) sum += rollSolarFlareMultiplier();
    // Expected mean is 0.5 + 1.5/2 = 1.25; tolerance ±0.02 over 50k samples.
    expect(sum / N).toBeGreaterThan(1.23);
    expect(sum / N).toBeLessThan(1.27);
  });
});

describe('rollStellarStrikeJackpot (was: rollGoldRushJackpot)', () => {
  it('triggers approximately 5% of the time', () => {
    let hits = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) if (rollStellarStrikeJackpot()) hits++;
    // 5% target; ±0.5% tolerance over 100k trials.
    const rate = hits / N;
    expect(rate).toBeGreaterThan(0.045);
    expect(rate).toBeLessThan(0.055);
  });

  it('returns a boolean', () => {
    expect(typeof rollStellarStrikeJackpot()).toBe('boolean');
  });
});

describe('getStakeTier — USD-pegged dynamic thresholds', () => {
  // setAstroidUsdPrice mutates module state; always reset to "unknown" so the
  // static-fallback assertions in the suites above keep passing.
  afterEach(() => setAstroidUsdPrice(0));

  it('falls back to static token thresholds when the price is unknown', () => {
    expect(getAstroidUsdPrice()).toBe(0);
    expect(getStakeTier(9_999).name).toBe('Base');
    expect(getStakeTier(10_000).name).toBe('Bronze');
    expect(getStakeTier(1_000_000).name).toBe('Diamond');
  });

  it('derives token thresholds from the live price (USD targets stay fixed)', () => {
    // At $0.01/token: Bronze $50 → 5,000 tokens, Diamond $400 → 40,000 tokens.
    setAstroidUsdPrice(0.01);
    expect(getStakeTier(4_999).name).toBe('Base');
    expect(getStakeTier(5_000).name).toBe('Bronze'); // $50 / $0.01
    expect(getStakeTier(10_000).name).toBe('Silver'); // $100 / $0.01
    expect(getStakeTier(20_000).name).toBe('Gold'); // $200 / $0.01
    expect(getStakeTier(40_000).name).toBe('Diamond'); // $400 / $0.01
  });

  it('requires more tokens as the price falls (same USD cost)', () => {
    // Cheaper token → more tokens needed for the same dollar tier.
    setAstroidUsdPrice(0.001);
    // Diamond is $400 → 400,000 tokens at $0.001.
    expect(getStakeTier(399_999).name).toBe('Gold'); // still below $400
    expect(getStakeTier(400_000).name).toBe('Diamond');
  });

  it('exposes the live token threshold on the resolved tier', () => {
    // At $0.005: Bronze $50→10k, Silver $100→20k, Gold $200→40k, Diamond $400→80k.
    setAstroidUsdPrice(0.005);
    expect(getStakeTier(50_000).name).toBe('Gold'); // 40k ≤ 50k < 80k
    expect(getStakeTier(10_000).minStake).toBeCloseTo(10_000, 0); // Bronze threshold
    expect(getStakeTier(80_000).name).toBe('Diamond');
  });
});

describe('getStakeTierProgress', () => {
  it('reports the next tier and tokens needed at the live price', () => {
    // At $0.01: Bronze $50→5k, Silver $100→10k.
    setAstroidUsdPrice(0.01);
    const p = getStakeTierProgress(6_000); // Bronze, working toward Silver
    expect(p.tierName).toBe('Bronze');
    expect(p.drillPowerMultiplier).toBe(1.5);
    expect(p.nextTierName).toBe('Silver');
    expect(p.nextTierThreshold).toBeCloseTo(10_000, 0);
    expect(p.tokensToNextTier).toBeCloseTo(4_000, 0); // 10k - 6k
    expect(p.nextTierUsd).toBe(100);
    expect(p.astroidUsdPrice).toBe(0.01);
  });

  it('reports no next tier at the top (Diamond)', () => {
    setAstroidUsdPrice(0.01);
    const p = getStakeTierProgress(1_000_000); // way past Diamond ($400→40k)
    expect(p.tierName).toBe('Diamond');
    expect(p.nextTierName).toBeNull();
    expect(p.nextTierThreshold).toBeNull();
    expect(p.tokensToNextTier).toBe(0);
  });
});
