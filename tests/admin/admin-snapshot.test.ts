/**
 * Unit tests for the admin snapshot builder.
 *
 * Verifies the read-only snapshot reflects live game state (players,
 * stake tiers, economy, security, events) without mutating anything.
 */

import { describe, expect, it } from 'vitest';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import { LogBuffer } from '../../server/admin/log-buffer.js';
import { buildAdminSnapshot } from '../../server/admin/admin-snapshot.js';
import type { EscrowManager } from '../../server/chain/escrow-manager.js';
import type { PriceOracle } from '../../server/chain/price-oracle.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { GameWorld } from '../../server/game/world.js';

const silentLogger: GameLogger = { info: () => {}, warn: () => {}, error: () => {} };
const ALICE = '11111111111111111111111111111111';

const HOME: AsteroidDefinition = {
  id: 'home',
  name: 'Ceres Outpost',
  resource: 'carbon',
  sector: 'Inner Belt',
  position: { x: 0, y: 0, z: 0 },
  baseDiscoveryTimeMs: 5 * 60 * 1000,
  baseRewardMultiplier: 1.0,
  description: 'test',
};

function makeDeps(world: GameWorld, buffer: LogBuffer) {
  return {
    world,
    buffer,
    persistence: 'memory' as const,
    quarryEnabled: false,
    payoutsOnChain: false,
    startedAt: Date.now() - 5000,
  };
}

describe('buildAdminSnapshot', () => {
  it('reports server flags, uptime and connected count', async () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    await world.connectPlayer(ALICE);
    const snap = buildAdminSnapshot(makeDeps(world, new LogBuffer()));

    expect(snap.server.persistence).toBe('memory');
    expect(snap.server.quarryEnabled).toBe(false);
    expect(snap.server.uptimeSec).toBeGreaterThanOrEqual(4);
    expect(snap.server.connected).toBe(1);
  });

  it('lists players with their authed flag and stake tier', async () => {
    const world = new GameWorld({
      asteroids: [HOME],
      logger: silentLogger,
      chainEnabled: false,
      quarryEnabled: true,
    });
    await world.connectPlayer(ALICE);
    world.stakeManager.setOnChainStake(ALICE, 250_000);

    const snap = buildAdminSnapshot(makeDeps(world, new LogBuffer()));
    const alice = snap.players.find((p) => p.wallet === ALICE);
    expect(alice).toBeDefined();
    expect(alice!.authed).toBe(true);
    expect(alice!.onChainStake).toBe(250_000);
    expect(alice!.tier).toBe('Gold');
    expect(alice!.drillMultiplier).toBe(2.5);
  });

  it('summarises economy with sorted top balances', async () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    await world.connectPlayer(ALICE);
    world.stakeManager.addPendingYield(ALICE, 'home', 250);

    const snap = buildAdminSnapshot(makeDeps(world, new LogBuffer()));
    expect(snap.economy.totalPendingYield).toBe(250);
    expect(snap.economy.walletsWithCredit).toBe(1);
    expect(snap.economy.topBalances[0]).toEqual({ wallet: ALICE, amount: 250 });
  });

  it('reports the holder gate posture and live oracle prices', async () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    await world.connectPlayer(ALICE);
    const updatedAt = Date.now() - 30_000;
    const fakeOracle = {
      getPrice: () => 0.00005446,
      getSolPrice: () => 68.23,
      getUpdatedAt: () => updatedAt,
    } as unknown as PriceOracle;

    const snap = buildAdminSnapshot({
      ...makeDeps(world, new LogBuffer()),
      getPriceOracle: () => fakeOracle,
    });

    expect(snap.holderGate.enabled).toBe(false); // chain off in this fixture
    expect(snap.holderGate.astroidUsd).toBe(0.00005446);
    expect(snap.holderGate.solUsd).toBe(68.23);
    expect(snap.holderGate.oracleUpdatedAt).toBe(updatedAt);
    // With HOLDER_MIN_SOL unset (test env default 0), the gate is the static floor.
    expect(snap.holderGate.pegged).toBe(false);
    expect(snap.holderGate.requiredAstroid).toBe(snap.holderGate.staticFloor);
  });

  it('summarises escrow when a manager is wired, and is null otherwise', async () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    await world.connectPlayer(ALICE);

    const noEscrow = buildAdminSnapshot(makeDeps(world, new LogBuffer()));
    expect(noEscrow.escrow).toBeNull();

    const fakeEscrow = {
      getSummary: () => ({ active: 2, settling: 1, failed: 0, outstanding: 4200 }),
    } as unknown as EscrowManager;
    const withEscrow = buildAdminSnapshot({
      ...makeDeps(world, new LogBuffer()),
      escrowManager: fakeEscrow,
    });
    // No fee accessor → fees null, summary fields passed through.
    expect(withEscrow.escrow).toEqual({
      active: 2,
      settling: 1,
      failed: 0,
      outstanding: 4200,
      fees: null,
    });

    const withFees = buildAdminSnapshot({
      ...makeDeps(world, new LogBuffer()),
      escrowManager: fakeEscrow,
      getEscrowFees: () => ({ feeBps: 200, feeFlat: 5000, feesCollected: 12, rentBurned: 3 }),
    });
    expect(withFees.escrow).toEqual({
      active: 2,
      settling: 1,
      failed: 0,
      outstanding: 4200,
      fees: { feeBps: 200, feeFlat: 5000, feesCollected: 12, rentBurned: 3 },
    });
  });

  it('includes recent log events and the last event id', () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    const buffer = new LogBuffer();
    buffer.push('info', 'discovery on Ceres');
    buffer.push('warn', 'raid incoming');

    const snap = buildAdminSnapshot(makeDeps(world, buffer));
    expect(snap.events.map((e) => e.msg)).toContain('discovery on Ceres');
    expect(snap.lastEventId).toBe(2);
  });

  it('supports incremental event tailing via sinceEventId', () => {
    const world = new GameWorld({ asteroids: [HOME], logger: silentLogger, chainEnabled: false });
    const buffer = new LogBuffer();
    buffer.push('info', 'first');
    buffer.push('info', 'second');

    const snap = buildAdminSnapshot(makeDeps(world, buffer), { sinceEventId: 1 });
    expect(snap.events.map((e) => e.msg)).toEqual(['second']);
  });
});
