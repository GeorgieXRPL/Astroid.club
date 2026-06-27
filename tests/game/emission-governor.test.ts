import { describe, expect, it } from 'vitest';

import { EmissionGovernor } from '../../server/game/emission-governor.js';

describe('EmissionGovernor', () => {
  describe('disabled', () => {
    it('is a no-op when budget and dailyCap are both 0', () => {
      const g = new EmissionGovernor({ budget: 0, dailyCap: 0 });
      expect(g.enabled).toBe(false);
      expect(g.scale(0)).toBe(1);
      expect(g.scale(1_000_000)).toBe(1);
      expect(g.apply(100, 999_999)).toBe(100);
    });
  });

  describe('backing taper', () => {
    it('issues full yield while well under the taper band', () => {
      // budget 1000, taper 0.25 => full yield until outstanding >= 750.
      const g = new EmissionGovernor({ budget: 1000, taperFraction: 0.25 });
      expect(g.scale(0)).toBe(1);
      expect(g.scale(700)).toBe(1);
      expect(g.scale(750)).toBe(1);
    });

    it('tapers linearly across the band', () => {
      const g = new EmissionGovernor({ budget: 1000, taperFraction: 0.25 });
      // band = 250 (from 750 -> 1000). At outstanding 875 headroom=125 => 0.5.
      expect(g.scale(875)).toBeCloseTo(0.5, 5);
      // At 812.5 headroom=187.5 => 0.75.
      expect(g.scale(812.5)).toBeCloseTo(0.75, 5);
    });

    it('stops issuance at or above budget', () => {
      const g = new EmissionGovernor({ budget: 1000, taperFraction: 0.25 });
      expect(g.scale(1000)).toBe(0);
      expect(g.scale(1500)).toBe(0);
      expect(g.apply(100, 1000)).toBe(0);
    });
  });

  describe('rolling daily cap', () => {
    it('blocks issuance once the 24h window is full and recovers after it ages out', () => {
      let now = 1_000_000;
      const g = new EmissionGovernor({ budget: 0, dailyCap: 500, now: () => now });
      expect(g.scale(0)).toBe(1);
      g.record(300);
      expect(g.scale(0)).toBe(1);
      g.record(250); // windowSum = 550 >= 500
      expect(g.scale(0)).toBe(0);

      // Advance just under 24h: still capped.
      now += 24 * 60 * 60 * 1000 - 10;
      expect(g.scale(0)).toBe(0);

      // Advance past 24h: the early records age out, headroom returns.
      now += 100;
      expect(g.scale(0)).toBe(1);
    });
  });

  describe('combined throttles', () => {
    it('takes the stricter of backing taper and daily cap', () => {
      const now = 0;
      const g = new EmissionGovernor({
        budget: 1000,
        taperFraction: 0.25,
        dailyCap: 1_000_000,
        now: () => now,
      });
      // Daily cap is huge; backing taper dominates.
      expect(g.scale(875)).toBeCloseTo(0.5, 5);
    });
  });

  describe('dynamic budget (treasury peg)', () => {
    it('uses the dynamic budget over the static floor when it returns > 0', () => {
      let backing = 2000;
      const g = new EmissionGovernor({
        budget: 1000, // static floor
        taperFraction: 0.25,
        getBudget: () => backing,
      });
      // Pegged to 2000: band = 500, full until outstanding 1500.
      expect(g.scale(1500)).toBe(1);
      expect(g.scale(1750)).toBeCloseTo(0.5, 5);
      expect(g.scale(2000)).toBe(0);

      // Treasury drawn down to 1200: budget shrinks, taper bites sooner.
      backing = 1200;
      expect(g.scale(1100)).toBeCloseTo((1200 - 1100) / (1200 * 0.25), 5);
      expect(g.scale(1200)).toBe(0);
    });

    it('falls back to the static floor when the dynamic budget is 0 (pre-poll)', () => {
      const g = new EmissionGovernor({
        budget: 1000,
        taperFraction: 0.25,
        getBudget: () => 0, // not polled yet
      });
      expect(g.scale(500)).toBe(1);
      expect(g.scale(1000)).toBe(0); // static floor still protects
    });

    it('is enabled whenever a dynamic budget accessor is wired', () => {
      const g = new EmissionGovernor({ budget: 0, dailyCap: 0, getBudget: () => 5000 });
      expect(g.enabled).toBe(true);
      expect(g.getStatus(0).budget).toBe(5000);
    });
  });

  describe('getStatus', () => {
    it('reports headroom, scale, and daily issuance', () => {
      const now = 0;
      const g = new EmissionGovernor({ budget: 1000, dailyCap: 400, now: () => now });
      g.record(100);
      const status = g.getStatus(600);
      expect(status.budget).toBe(1000);
      expect(status.outstanding).toBe(600);
      expect(status.headroom).toBe(400);
      expect(status.dailyIssued).toBe(100);
      expect(status.dailyCap).toBe(400);
      expect(status.scale).toBeGreaterThan(0);
      expect(status.scale).toBeLessThanOrEqual(1);
    });
  });
});
