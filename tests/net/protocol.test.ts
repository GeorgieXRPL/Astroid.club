/**
 * Unit tests for `server/net/protocol.ts`.
 *
 * Verifies the zod-validated discriminated union covers every game
 * message, that primitives (`SolanaAddress`, etc.) reject malformed
 * input, that engine control messages still flow through, and that
 * the `requiresAuth` helper agrees with the `POST_AUTH_TYPES` set.
 */

import { describe, expect, it } from 'vitest';

import {
  GameMessage,
  MAX_REPORTED_DRILL_POWER,
  POST_AUTH_TYPES,
  createAstroidProtocol,
  requiresAuth,
} from '../../server/net/protocol.js';

const VALID_WALLET = '11111111111111111111111111111111';
const INVALID_WALLET = 'not_base58_at_all_!!!';

describe('GameMessage schema', () => {
  it('parses request_nonce', () => {
    const r = GameMessage.safeParse({
      type: 'request_nonce',
      walletAddress: VALID_WALLET,
    });
    expect(r.success).toBe(true);
  });

  it('rejects request_nonce with malformed wallet address', () => {
    const r = GameMessage.safeParse({
      type: 'request_nonce',
      walletAddress: INVALID_WALLET,
    });
    expect(r.success).toBe(false);
  });

  it('parses auth with all required fields', () => {
    const r = GameMessage.safeParse({
      type: 'auth',
      walletAddress: VALID_WALLET,
      nonce: 'abcdef0123',
      signature: 'sig-base64-blob',
    });
    expect(r.success).toBe(true);
  });

  it('parses join_asteroid', () => {
    const r = GameMessage.safeParse({ type: 'join_asteroid', asteroidId: 'home' });
    expect(r.success).toBe(true);
  });

  it('rejects join_asteroid with empty asteroidId', () => {
    const r = GameMessage.safeParse({ type: 'join_asteroid', asteroidId: '' });
    expect(r.success).toBe(false);
  });

  it('parses leave_asteroid (no body)', () => {
    const r = GameMessage.safeParse({ type: 'leave_asteroid' });
    expect(r.success).toBe(true);
  });

  it('parses set_home_station', () => {
    const r = GameMessage.safeParse({ type: 'set_home_station', asteroidId: 'home' });
    expect(r.success).toBe(true);
  });

  it('parses report_drill_power with non-negative number', () => {
    const r = GameMessage.safeParse({ type: 'report_drill_power', drillPower: 0 });
    expect(r.success).toBe(true);
    const r2 = GameMessage.safeParse({ type: 'report_drill_power', drillPower: 1234.5 });
    expect(r2.success).toBe(true);
  });

  it('rejects report_drill_power with negative drillPower', () => {
    const r = GameMessage.safeParse({ type: 'report_drill_power', drillPower: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects report_drill_power with non-finite drillPower', () => {
    const r = GameMessage.safeParse({
      type: 'report_drill_power',
      drillPower: Number.POSITIVE_INFINITY,
    });
    expect(r.success).toBe(false);
  });

  it('clamps report_drill_power above the drill-power cap instead of rejecting', () => {
    const overCap = GameMessage.safeParse({
      type: 'report_drill_power',
      drillPower: 1e16,
    });
    expect(overCap.success).toBe(true);
    if (overCap.success && overCap.data.type === 'report_drill_power') {
      expect(overCap.data.drillPower).toBe(MAX_REPORTED_DRILL_POWER);
    }
    const atCap = GameMessage.safeParse({
      type: 'report_drill_power',
      drillPower: 10_000_000,
    });
    expect(atCap.success).toBe(true);
  });

  it('parses stake / unstake with positive amounts', () => {
    expect(GameMessage.safeParse({ type: 'stake', asteroidId: 'home', amount: 100 }).success).toBe(
      true,
    );
    expect(
      GameMessage.safeParse({ type: 'unstake', asteroidId: 'home', amount: 100 }).success,
    ).toBe(true);
  });

  it('rejects stake / unstake with non-positive amount', () => {
    expect(GameMessage.safeParse({ type: 'stake', asteroidId: 'home', amount: 0 }).success).toBe(
      false,
    );
    expect(GameMessage.safeParse({ type: 'unstake', asteroidId: 'home', amount: -1 }).success).toBe(
      false,
    );
  });

  it('parses start_expedition with bet 0 and >0', () => {
    expect(
      GameMessage.safeParse({
        type: 'start_expedition',
        targetAsteroidId: 'rich',
        betAmount: 0,
      }).success,
    ).toBe(true);
    expect(
      GameMessage.safeParse({
        type: 'start_expedition',
        targetAsteroidId: 'rich',
        betAmount: 100,
      }).success,
    ).toBe(true);
  });

  it('rejects start_expedition with negative betAmount', () => {
    const r = GameMessage.safeParse({
      type: 'start_expedition',
      targetAsteroidId: 'rich',
      betAmount: -1,
    });
    expect(r.success).toBe(false);
  });

  it('parses leave_expedition (no body)', () => {
    const r = GameMessage.safeParse({ type: 'leave_expedition' });
    expect(r.success).toBe(true);
  });

  it('parses rally_defense with zero or positive tokenCost', () => {
    expect(
      GameMessage.safeParse({ type: 'rally_defense', asteroidId: 'home', tokenCost: 0 }).success,
    ).toBe(true);
    expect(
      GameMessage.safeParse({ type: 'rally_defense', asteroidId: 'home', tokenCost: 100 }).success,
    ).toBe(true);
  });

  it('parses deflect_meteor with a meteorId', () => {
    expect(
      GameMessage.safeParse({ type: 'deflect_meteor', meteorId: 'meteor_3_1718500000000' }).success,
    ).toBe(true);
  });

  it('rejects deflect_meteor with an empty meteorId', () => {
    expect(GameMessage.safeParse({ type: 'deflect_meteor', meteorId: '' }).success).toBe(false);
  });

  it('rejects rally_defense with negative tokenCost', () => {
    const r = GameMessage.safeParse({
      type: 'rally_defense',
      asteroidId: 'home',
      tokenCost: -1,
    });
    expect(r.success).toBe(false);
  });

  it('parses claim_yield, network_stats, miner_snapshot (all bodyless)', () => {
    expect(GameMessage.safeParse({ type: 'claim_yield' }).success).toBe(true);
    expect(GameMessage.safeParse({ type: 'network_stats' }).success).toBe(true);
    expect(GameMessage.safeParse({ type: 'miner_snapshot' }).success).toBe(true);
  });

  it('every message type accepts an optional requestId', () => {
    expect(
      GameMessage.safeParse({
        type: 'join_asteroid',
        asteroidId: 'home',
        requestId: 'req-1',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown type literal', () => {
    const r = GameMessage.safeParse({ type: 'wat', asteroidId: 'home' });
    expect(r.success).toBe(false);
  });

  it('rejects null / non-objects', () => {
    expect(GameMessage.safeParse(null).success).toBe(false);
    expect(GameMessage.safeParse('string').success).toBe(false);
    expect(GameMessage.safeParse(42).success).toBe(false);
  });
});

describe('requiresAuth helper', () => {
  it('agrees with POST_AUTH_TYPES set membership', () => {
    for (const type of POST_AUTH_TYPES) {
      expect(requiresAuth(type)).toBe(true);
    }
  });

  it('returns false for the auth-flow types (request_nonce / auth)', () => {
    expect(requiresAuth('request_nonce')).toBe(false);
    expect(requiresAuth('auth')).toBe(false);
  });
});

describe('createAstroidProtocol', () => {
  it('parses an engine control message (ping)', () => {
    const p = createAstroidProtocol();
    const r = p.parse({ type: 'ping', id: 1, ts: 1234 });
    expect(r.ok).toBe(true);
  });

  it('parses a JSON-encoded game message', () => {
    const p = createAstroidProtocol();
    const r = p.parse(JSON.stringify({ type: 'network_stats', requestId: 'q1' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.type).toBe('network_stats');
  });

  it('reports a useful error on garbage payloads', () => {
    const p = createAstroidProtocol();
    const r = p.parse('not-json');
    expect(r.ok).toBe(false);
  });

  it('reports an error on shape that satisfies neither control nor game', () => {
    const p = createAstroidProtocol();
    const r = p.parse({ type: 'totally_unknown', x: 1 });
    expect(r.ok).toBe(false);
  });

  it('round-trips encode + parse', () => {
    const p = createAstroidProtocol();
    const msg = { type: 'stake' as const, asteroidId: 'home', amount: 250, requestId: 'a' };
    const round = p.parse(p.encode(msg));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.data).toEqual(msg);
  });
});
