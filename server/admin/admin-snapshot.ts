/**
 * Builds the live admin snapshot: a single JSON document the admin
 * console polls to render server health, live gameplay, the economy,
 * per-player state, and the recent log feed.
 *
 * Read-only: this module only *reads* game state. No control actions
 * live here — keeping the snapshot side-effect-free means polling it can
 * never mutate the game.
 */

import { runtime } from '../config/runtime.js';
import { getStakeTier } from '../game/types.js';
import type { GameWorld } from '../game/world.js';

import type { LogBuffer, LogEntry } from './log-buffer.js';

export type PersistenceMode = 'postgres' | 'redis' | 'memory';

export interface AdminSnapshotDeps {
  world: GameWorld;
  buffer: LogBuffer;
  persistence: PersistenceMode;
  quarryEnabled: boolean;
  payoutsOnChain: boolean;
  startedAt: number;
}

export interface AdminPlayer {
  wallet: string;
  authed: boolean;
  homeAsteroidId: string | null;
  activeAsteroidId: string | null;
  onChainStake: number;
  tier: string;
  drillMultiplier: number;
  /** Effective drill power currently contributed (post stake-tier multiplier). */
  drillPower: number;
  pendingYield: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  loyaltyDays: number;
  onExpedition: boolean;
  cooldowns: string[];
}

export interface AdminSnapshot {
  ts: number;
  server: {
    uptimeSec: number;
    chainEnabled: boolean;
    quarryEnabled: boolean;
    payoutsOnChain: boolean;
    persistence: PersistenceMode;
    connected: number;
  };
  network: ReturnType<GameWorld['getNetworkStats']>;
  security: ReturnType<GameWorld['antiCheat']['getStats']>;
  economy: {
    totalPendingYield: number;
    walletsWithCredit: number;
    /** Lifetime mining rewards credited across all wallets (gross). */
    totalEarned: number;
    /** Lifetime rewards moved on-chain across all wallets (claimed/redeemed). */
    totalRedeemed: number;
    /**
     * Emission governor health: current issuance scale, outstanding liability
     * vs the backing budget, and rolling daily issuance. Null when no governor
     * is configured.
     */
    emission: ReturnType<GameWorld['yieldOrchestrator']['getEmissionStatus']>;
    topBalances: Array<{ wallet: string; amount: number }>;
  };
  players: AdminPlayer[];
  /** In-flight expeditions + recently resolved raid outcomes. */
  raids: ReturnType<GameWorld['getRaidsOverview']>;
  /** Incoming + recently resolved meteor strikes. */
  meteors: ReturnType<GameWorld['getMeteorsOverview']>;
  events: LogEntry[];
  lastEventId: number;
}

/** Assemble the full admin snapshot from live game state. */
export function buildAdminSnapshot(
  deps: AdminSnapshotDeps,
  opts: { eventLimit?: number; sinceEventId?: number } = {},
): AdminSnapshot {
  const { world, buffer } = deps;
  const sm = world.stakeManager;
  const authed = new Set(world.getAuthedWallets());

  const players: AdminPlayer[] = sm.getAllMinerStates().map((s) => {
    const onChainStake = sm.getOnChainStake(s.walletAddress);
    const tier = getStakeTier(onChainStake);
    return {
      wallet: s.walletAddress,
      authed: authed.has(s.walletAddress),
      homeAsteroidId: s.homeStationAsteroidId,
      activeAsteroidId: s.activeAsteroidId,
      onChainStake,
      tier: tier.name,
      drillMultiplier: tier.drillPowerMultiplier,
      drillPower: world.getReportedDrillPower(s.walletAddress),
      pendingYield: sm.getPendingYield(s.walletAddress),
      lifetimeEarned: sm.getLifetimeEarned(s.walletAddress),
      lifetimeRedeemed: sm.getLifetimeRedeemed(s.walletAddress),
      loyaltyDays: s.loyaltyDays,
      onExpedition: Boolean(s.currentExpeditionId),
      cooldowns: s.cooldowns.map((c) => c.type),
    };
  });

  const balances = Array.from(sm.getAllPendingYield().entries())
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1]);
  const topBalances = balances.slice(0, 25).map(([wallet, amount]) => ({ wallet, amount }));

  return {
    ts: Date.now(),
    server: {
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      chainEnabled: runtime.chainEnabled,
      quarryEnabled: deps.quarryEnabled,
      payoutsOnChain: deps.payoutsOnChain,
      persistence: deps.persistence,
      connected: authed.size,
    },
    network: world.getNetworkStats(),
    security: world.antiCheat.getStats(),
    economy: {
      totalPendingYield: sm.getTotalPendingYield(),
      walletsWithCredit: balances.length,
      totalEarned: players.reduce((sum, p) => sum + p.lifetimeEarned, 0),
      totalRedeemed: players.reduce((sum, p) => sum + p.lifetimeRedeemed, 0),
      emission: world.yieldOrchestrator.getEmissionStatus(),
      topBalances,
    },
    players,
    raids: world.getRaidsOverview(),
    meteors: world.getMeteorsOverview(),
    events: buffer.recent(opts.eventLimit ?? 300, opts.sinceEventId ?? 0),
    lastEventId: buffer.lastId,
  };
}
