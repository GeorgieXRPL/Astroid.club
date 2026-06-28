'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AsteroidNetworkStats,
  type ConnectSnapshot,
  type NetworkStatsSnapshot,
  Session,
  SessionError,
  type UserStakeInfo,
} from '@/lib/session';
import {
  canStake,
  runClaimToWallet,
  runStakeAction,
  type StakeActionKind,
  StakingUnavailableError,
} from '@/lib/staking-client';
import { connect, useSession } from '@/lib/use-session';
import { useWalletSource } from '@/lib/wallet-source-providers';
import type { WalletSource } from '@/lib/wallet-source';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';
const POLL_MS = 5_000;
const MAX_LOG_ENTRIES = 100;

type LogKind = 'sent' | 'ok' | 'err' | 'event';
interface LogEntry {
  id: number;
  ts: number;
  kind: LogKind;
  label: string;
  detail?: string;
}

interface ActiveExpedition {
  expeditionId: string;
  targetAsteroidId: string;
  expiresAt: string;
  startedAt: number;
}

export default function ConsolePage() {
  const sessionStore = useSession();
  const wallet = useWalletSource();

  // Auto-connect once we have a wallet source. In dev mode this is
  // immediate; in privy mode it only fires if the user is already
  // authorized from a previous session — we never silently spring
  // the wallet modal on a cold console visit.
  useEffect(() => {
    if (sessionStore.state !== 'idle') return;
    if (!wallet.source) return;
    connect(WS_URL, wallet.source).catch(() => {
      /* error already published into the store */
    });
  }, [sessionStore.state, wallet.source]);

  if (sessionStore.state !== 'connected' || !sessionStore.session) {
    return <ConsolePlaceholder store={sessionStore} walletMode={wallet.mode} />;
  }

  return <ConsoleBody session={sessionStore.session} initialSnapshot={sessionStore.snapshot} />;
}

function ConsolePlaceholder({
  store,
  walletMode,
}: {
  store: ReturnType<typeof useSession>;
  walletMode: 'privy' | 'dev';
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 sm:px-8">
      <p className="eyebrow mb-4">Console</p>
      <h1 className="mb-3 font-display text-4xl font-bold tracking-tight text-white">
        {store.state === 'connecting'
          ? 'Connecting…'
          : store.state === 'error'
            ? 'Sign-in failed'
            : 'Sign in to drive the world'}
      </h1>
      {store.state === 'error' && store.error ? (
        <div className="glass-panel mb-6 border-ember/40 bg-ember/10 p-6">
          <p className="telemetry-label mb-2 text-ember">{store.error.code}</p>
          <p className="text-sm text-white/85">{store.error.message}</p>
        </div>
      ) : (
        <p className="mb-8 text-sm leading-relaxed text-white/60">
          The console drives every server message (join, stake, drill, expedition, claim) over a
          long-lived authenticated WebSocket.{' '}
          {walletMode === 'privy'
            ? 'Connect your Solana wallet to begin.'
            : 'Sign in with the dev keypair to begin.'}
        </p>
      )}
      <Link className="btn-primary" href="/sign-in">
        Go to sign-in
      </Link>
    </div>
  );
}

function ConsoleBody({
  session,
  initialSnapshot,
}: {
  session: Session;
  initialSnapshot: ConnectSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<ConnectSnapshot | null>(initialSnapshot);
  const [stats, setStats] = useState<NetworkStatsSnapshot | null>(null);
  const [activeExpedition, setActiveExpedition] = useState<ActiveExpedition | null>(null);

  // Form state — kept here so all input is colocated with the
  // buttons. Each section grabs what it needs from these.
  const [stakeAsteroidId, setStakeAsteroidId] = useState<string>('');
  const [stakeAmount, setStakeAmount] = useState<number>(100);
  const [drillPower, setDrillPower] = useState<number>(5_000);
  const [raidTarget, setRaidTarget] = useState<string>('');
  const [betAmount, setBetAmount] = useState<number>(0);
  const [rallyAmount, setRallyAmount] = useState<number>(50);

  const logBuffer = useRef<LogEntry[]>([]);
  const [logVersion, setLogVersion] = useState(0);
  const nextLogId = useRef(1);

  const append = useCallback((kind: LogKind, label: string, detail?: string) => {
    const entry: LogEntry = {
      id: nextLogId.current++,
      ts: Date.now(),
      kind,
      label,
      detail,
    };
    logBuffer.current = [entry, ...logBuffer.current].slice(0, MAX_LOG_ENTRIES);
    setLogVersion((v) => v + 1);
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      const data = await session.send<ConnectSnapshot>({ type: 'miner_snapshot' });
      setSnapshot(data);
    } catch (err) {
      if (err instanceof SessionError) {
        append('err', 'miner_snapshot', `${err.code}: ${err.message}`);
      }
    }
  }, [session, append]);

  const refreshStats = useCallback(async () => {
    try {
      const data = await session.send<NetworkStatsSnapshot>({ type: 'network_stats' });
      setStats(data);
    } catch (err) {
      if (err instanceof SessionError) {
        append('err', 'network_stats', `${err.code}: ${err.message}`);
      }
    }
  }, [session, append]);

  /** Run a fire-and-forget action, then immediately refresh both panels. */
  const runAction = useCallback(
    async <T,>(label: string, message: Record<string, unknown> & { type: string }) => {
      append('sent', label, summariseRequest(message));
      try {
        const data = await session.send<T>(message);
        append('ok', label, data ? JSON.stringify(data) : undefined);
        refreshSnapshot();
        refreshStats();
        return data;
      } catch (err) {
        if (err instanceof SessionError) {
          append('err', label, `${err.code}: ${err.message}`);
        } else {
          append('err', label, err instanceof Error ? err.message : String(err));
        }
        return null;
      }
    },
    [append, refreshSnapshot, refreshStats, session],
  );

  // Initial load + periodic poll.
  useEffect(() => {
    refreshSnapshot();
    refreshStats();
    const id = setInterval(() => {
      refreshSnapshot();
      refreshStats();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refreshSnapshot, refreshStats]);

  // Subscribe to ALL server-pushed events. We don't know the full
  // event taxonomy yet (broadcastEvent is wired in the gateway, but
  // emitters land in later slices) — this listener-of-listeners is
  // future-proofing.
  useEffect(() => {
    const events = [
      'discovery_found',
      'raid_started',
      'raid_resolved',
      'rally_defense',
      'syndicate_payout',
      'refinery_distribution',
      'yield_payout',
      'solar_flare',
      'stellar_strike',
    ];
    const unsubs = events.map((e) =>
      session.on(e, (data) => {
        append('event', e, data ? JSON.stringify(data) : undefined);
      }),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [session, append]);

  // Pre-populate the asteroid selectors with the first registered
  // asteroid the moment the snapshot lands.
  useEffect(() => {
    if (!snapshot) return;
    if (!stakeAsteroidId && snapshot.asteroids[0]) {
      setStakeAsteroidId(snapshot.asteroids[0].id);
    }
    if (!raidTarget && snapshot.asteroids[0]) {
      setRaidTarget(snapshot.asteroids[0].id);
    }
  }, [snapshot, stakeAsteroidId, raidTarget]);

  const asteroids = snapshot?.asteroids ?? [];
  const statsByAsteroid = useMemo(() => {
    const map = new Map<string, AsteroidNetworkStats>();
    if (stats) for (const a of stats.asteroids) map.set(a.asteroidId, a);
    return map;
  }, [stats]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12 sm:px-8">
      <header className="mb-10">
        <p className="eyebrow mb-3">Console &middot; dev test surface</p>
        <h1 className="font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Drive the world
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/60">
          A button for every server message. Every action below emits a typed wire frame to the live{' '}
          <code className="font-mono text-cosmos">GameWorld</code>; replies stream into the event
          log. Polls <code className="font-mono text-cosmos">miner_snapshot</code> and{' '}
          <code className="font-mono text-cosmos">network_stats</code> every {POLL_MS / 1000}s.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <MinerSnapshotPanel snapshot={snapshot} stats={stats} />

          {/* Primary wallet actions — claim rewards + on-chain staking — kept
              up top with the stats so the things players actually do are front
              and centre. */}
          <YieldPanel
            snapshot={snapshot}
            session={session}
            append={append}
            onRefresh={refreshSnapshot}
          />

          <OnChainStakingPanel session={session} append={append} />

          {/* Everything else collapses into clearly-titled drawers so the page
              stays short and scannable. */}
          <Collapsible
            description="Browse every asteroid, join to mine, or set your home station."
            title="Asteroids"
          >
            <AsteroidGridPanel
              asteroids={asteroids}
              snapshot={snapshot}
              statsByAsteroid={statsByAsteroid}
              onJoin={(id) =>
                runAction<void>('join_asteroid', { type: 'join_asteroid', asteroidId: id })
              }
              onLeave={() => runAction<void>('leave_asteroid', { type: 'leave_asteroid' })}
              onSetHome={(id) =>
                runAction<void>('set_home_station', { type: 'set_home_station', asteroidId: id })
              }
            />
          </Collapsible>

          <Collapsible
            description="Report your base drill rate. The server applies your stake-tier multiplier and returns the effective power."
            title="Drill power"
          >
            <DrillPowerPanel
              drillPower={drillPower}
              setDrillPower={setDrillPower}
              onSubmit={() =>
                runAction<{ effective: number }>('report_drill_power', {
                  type: 'report_drill_power',
                  drillPower,
                })
              }
            />
          </Collapsible>

          <Collapsible
            description="Legacy per-asteroid in-game staking (dev/testing only). Real staking is the on-chain panel above."
            title="In-game stake (legacy)"
          >
            <StakePanel
              asteroids={asteroids}
              stakeAsteroidId={stakeAsteroidId}
              setStakeAsteroidId={setStakeAsteroidId}
              stakeAmount={stakeAmount}
              setStakeAmount={setStakeAmount}
              onStake={() =>
                runAction<void>('stake', {
                  type: 'stake',
                  asteroidId: stakeAsteroidId,
                  amount: stakeAmount,
                })
              }
              onUnstake={() =>
                runAction<{ warning?: string }>('unstake', {
                  type: 'unstake',
                  asteroidId: stakeAsteroidId,
                  amount: stakeAmount,
                })
              }
            />
          </Collapsible>

          <Collapsible
            description="Launch raids on rival asteroids to steal treasury, or rally to defend an asteroid you hold."
            title="Expeditions & defense"
          >
            <ExpeditionPanel
              asteroids={asteroids}
              snapshot={snapshot}
              raidTarget={raidTarget}
              setRaidTarget={setRaidTarget}
              betAmount={betAmount}
              setBetAmount={setBetAmount}
              rallyAmount={rallyAmount}
              setRallyAmount={setRallyAmount}
              activeExpedition={activeExpedition}
              onStart={async () => {
                const r = await runAction<{ expeditionId: string; expiresAt: string }>(
                  'start_expedition',
                  {
                    type: 'start_expedition',
                    targetAsteroidId: raidTarget,
                    betAmount,
                  },
                );
                if (r) {
                  setActiveExpedition({
                    expeditionId: r.expeditionId,
                    targetAsteroidId: raidTarget,
                    expiresAt: r.expiresAt,
                    startedAt: Date.now(),
                  });
                }
              }}
              onLeave={async () => {
                const r = await runAction<void>('leave_expedition', { type: 'leave_expedition' });
                if (r === undefined) setActiveExpedition(null);
              }}
              onRally={(asteroidId) =>
                runAction<void>('rally_defense', {
                  type: 'rally_defense',
                  asteroidId,
                  tokenCost: rallyAmount,
                })
              }
            />
          </Collapsible>
        </div>

        <aside className="lg:sticky lg:top-6 lg:h-fit">
          <EventLog entries={logBuffer.current} version={logVersion} />
        </aside>
      </div>
    </div>
  );
}

// ============================================================================
// Collapsible drawer
// ============================================================================

function Collapsible({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="glass-panel overflow-hidden">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 p-5 text-left transition hover:bg-white/[0.03] sm:p-6"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block font-display text-lg text-white">{title}</span>
          {description && (
            <span className="mt-1 block text-xs leading-relaxed text-white/50">{description}</span>
          )}
        </span>
        <span aria-hidden className="shrink-0 font-mono text-2xl leading-none text-white/55">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="border-t border-white/5 p-5 sm:p-6">{children}</div>}
    </section>
  );
}

// ============================================================================
// Snapshot
// ============================================================================

function MinerSnapshotPanel({
  snapshot,
  stats,
}: {
  snapshot: ConnectSnapshot | null;
  stats: NetworkStatsSnapshot | null;
}) {
  return (
    <section className="glass-panel-bright p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="telemetry-label">Your miner</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cosmos">live</span>
      </div>
      {!snapshot ? (
        <p className="text-sm text-white/55">Loading snapshot…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Wallet" mono value={short(snapshot.walletAddress)} />
          <Stat label="Home station" value={snapshot.homeStationAsteroidId ?? '-'} />
          <Stat label="Active asteroid" value={snapshot.activeAsteroidId ?? '-'} />
          <Stat label="Total stake" mono value={fmt(snapshot.totalStake)} />
          <Stat label="Loyalty days" mono value={fmt(snapshot.loyaltyDays)} />
          <Stat label="Claimable rewards" mono accent value={fmt(snapshot.pendingYield)} />
          <Stat label="Lifetime earned" mono value={fmt(snapshot.lifetimeEarned)} />
          <Stat label="Lifetime claimed" mono value={fmt(snapshot.lifetimeRedeemed)} />
        </div>
      )}
      {stats && (
        <>
          <div className="my-5 border-t border-white/5" />
          <div className="mb-3 telemetry-label">Network</div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Miners" mono value={fmt(stats.totalMiners)} />
            <Stat label="Drill power" mono value={fmt(stats.totalDrillPower)} />
            <Stat label="Total stake" mono value={fmt(stats.totalStake)} />
            <Stat label="Discoveries" mono value={fmt(stats.totalDiscoveries)} />
            <Stat label="Active raids" mono accent value={fmt(stats.activeExpeditions)} />
          </div>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="telemetry-label mb-1">{label}</div>
      <div
        className={`text-base ${mono ? 'font-mono' : 'font-display'} ${
          accent ? 'text-cosmos' : 'text-white/90'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// ============================================================================
// Asteroids
// ============================================================================

function AsteroidGridPanel({
  asteroids,
  snapshot,
  statsByAsteroid,
  onJoin,
  onLeave,
  onSetHome,
}: {
  asteroids: ReadonlyArray<{ id: string; name: string; resource: string }>;
  snapshot: ConnectSnapshot | null;
  statsByAsteroid: Map<string, AsteroidNetworkStats>;
  onJoin: (id: string) => void;
  onLeave: () => void;
  onSetHome: (id: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {asteroids.length === 0 && (
        <p className="text-sm text-white/55">No asteroids registered yet.</p>
      )}
      {asteroids.map((a) => {
          const s = statsByAsteroid.get(a.id);
          const isHome = snapshot?.homeStationAsteroidId === a.id;
          const isActive = snapshot?.activeAsteroidId === a.id;
          return (
            <article
              className={`relative rounded-xl border p-4 transition ${
                isActive
                  ? 'border-cosmos/45 bg-cosmos/5'
                  : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
              }`}
              key={a.id}
            >
              <div className="mb-2 flex items-center gap-2">
                <span className={`resource-dot resource-dot--${a.resource}`} />
                <h3 className="font-display text-base text-white">{a.name}</h3>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                  {a.resource}
                </span>
              </div>
              {s && (
                <dl className="mb-3 grid grid-cols-3 gap-2 text-xs">
                  <Mini label="Miners" value={fmt(s.minerCount)} />
                  <Mini label="Drill" value={fmt(s.drillPower)} />
                  <Mini label="Stake" value={fmt(s.totalStake)} />
                </dl>
              )}
              <div className="mb-3 flex flex-wrap gap-1">
                {isActive && <Tag color="cosmos">You&rsquo;re here</Tag>}
                {isHome && <Tag color="ember">Home</Tag>}
                {s?.hasDefenseBuff && <Tag color="emerald">Buffed</Tag>}
                {s?.hasAttackDebuff && <Tag color="ember">Debuffed</Tag>}
                {s && s.activeRaidCount > 0 && (
                  <Tag color="ember">{s.activeRaidCount} raid(s) inbound</Tag>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-ghost"
                  disabled={isActive}
                  onClick={() => onJoin(a.id)}
                  type="button"
                >
                  Join
                </button>
                {isActive && (
                  <button className="btn-ghost" onClick={() => onLeave()} type="button">
                    Leave
                  </button>
                )}
                <button
                  className="btn-ghost"
                  disabled={isHome}
                  onClick={() => onSetHome(a.id)}
                  type="button"
                >
                  {isHome ? 'Home' : 'Set as home'}
                </button>
              </div>
            </article>
          );
        })}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-space-950/50 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className="font-mono text-sm text-white/85">{value}</div>
    </div>
  );
}

function Tag({
  children,
  color,
}: {
  children: React.ReactNode;
  color: 'cosmos' | 'ember' | 'emerald';
}) {
  const palette = {
    cosmos: 'border-cosmos/40 bg-cosmos/10 text-cosmos',
    ember: 'border-ember/40 bg-ember/10 text-ember',
    emerald: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${palette[color]}`}
    >
      {children}
    </span>
  );
}

// ============================================================================
// Drill power
// ============================================================================

function DrillPowerPanel({
  drillPower,
  setDrillPower,
  onSubmit,
}: {
  drillPower: number;
  setDrillPower: (n: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="field flex-1 min-w-[200px]">
        <span className="telemetry-label">Drill power (base units)</span>
        <input
          className="field-input"
          min={0}
          onChange={(e) => setDrillPower(Number(e.target.value))}
          step={100}
          type="number"
          value={drillPower}
        />
      </label>
      <button className="btn-primary" onClick={onSubmit} type="button">
        Report
      </button>
    </div>
  );
}

// ============================================================================
// Stake
// ============================================================================

function StakePanel({
  asteroids,
  stakeAsteroidId,
  setStakeAsteroidId,
  stakeAmount,
  setStakeAmount,
  onStake,
  onUnstake,
}: {
  asteroids: ReadonlyArray<{ id: string; name: string; resource: string }>;
  stakeAsteroidId: string;
  setStakeAsteroidId: (id: string) => void;
  stakeAmount: number;
  setStakeAmount: (n: number) => void;
  onStake: () => void;
  onUnstake: () => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto_auto]">
      <label className="field">
        <span className="telemetry-label">Asteroid</span>
        <select
          className="field-input"
          onChange={(e) => setStakeAsteroidId(e.target.value)}
          value={stakeAsteroidId}
        >
          {asteroids.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.resource})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="telemetry-label">Amount</span>
        <input
          className="field-input"
          min={1}
          onChange={(e) => setStakeAmount(Number(e.target.value))}
          step={100}
          type="number"
          value={stakeAmount}
        />
      </label>
      <button
        className="btn-primary self-end"
        disabled={!stakeAsteroidId || stakeAmount <= 0}
        onClick={onStake}
        type="button"
      >
        Stake
      </button>
      <button
        className="btn-secondary self-end"
        disabled={!stakeAsteroidId || stakeAmount <= 0}
        onClick={onUnstake}
        type="button"
      >
        Unstake
      </button>
    </div>
  );
}

// ============================================================================
// Expedition / raid
// ============================================================================

function ExpeditionPanel({
  asteroids,
  snapshot,
  raidTarget,
  setRaidTarget,
  betAmount,
  setBetAmount,
  rallyAmount,
  setRallyAmount,
  activeExpedition,
  onStart,
  onLeave,
  onRally,
}: {
  asteroids: ReadonlyArray<{ id: string; name: string; resource: string }>;
  snapshot: ConnectSnapshot | null;
  raidTarget: string;
  setRaidTarget: (id: string) => void;
  betAmount: number;
  setBetAmount: (n: number) => void;
  rallyAmount: number;
  setRallyAmount: (n: number) => void;
  activeExpedition: ActiveExpedition | null;
  onStart: () => void;
  onLeave: () => void;
  onRally: (asteroidId: string) => void;
}) {
  const home = snapshot?.homeStationAsteroidId;
  return (
    <div>
      {!home && (
        <p className="mb-4 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 font-mono text-xs text-ember">
          You need a home station before you can launch an expedition.
        </p>
      )}

      <div className="mb-5">
        <p className="mb-3 text-sm text-white/55">Launch a raid against a rival asteroid.</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
          <label className="field">
            <span className="telemetry-label">Target asteroid</span>
            <select
              className="field-input"
              onChange={(e) => setRaidTarget(e.target.value)}
              value={raidTarget}
            >
              {asteroids
                .filter((a) => a.id !== home)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.resource})
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="telemetry-label">Bet amount</span>
            <input
              className="field-input"
              min={0}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              step={10}
              type="number"
              value={betAmount}
            />
          </label>
          <button
            className="btn-ember self-end"
            disabled={!home || !raidTarget}
            onClick={onStart}
            type="button"
          >
            Launch raid
          </button>
        </div>
      </div>

      {activeExpedition && (
        <div className="mb-5 rounded-md border border-cosmos/30 bg-cosmos/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="telemetry-label text-cosmos">Active expedition</span>
            <button className="btn-ghost" onClick={onLeave} type="button">
              Abandon
            </button>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-xs">
            <Mini label="Target" value={activeExpedition.targetAsteroidId} />
            <Mini label="Expedition id" value={short(activeExpedition.expeditionId)} />
            <Mini label="Expires in" value={formatExpiresIn(activeExpedition.expiresAt)} />
          </dl>
        </div>
      )}

      <div className="mb-3 border-t border-white/5 pt-4">
        <p className="mb-3 text-sm text-white/55">
          Rally defense at any asteroid. Costs are deducted from your stake there.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="field min-w-[180px]">
            <span className="telemetry-label">Rally cost</span>
            <input
              className="field-input"
              min={0}
              onChange={(e) => setRallyAmount(Number(e.target.value))}
              step={10}
              type="number"
              value={rallyAmount}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {asteroids.map((a) => (
              <button className="btn-ghost" key={a.id} onClick={() => onRally(a.id)} type="button">
                Rally @ {a.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Yield
// ============================================================================

function YieldPanel({
  snapshot,
  session,
  append,
  onRefresh,
}: {
  snapshot: ConnectSnapshot | null;
  session: Session;
  append: (kind: LogKind, label: string, detail?: string) => void;
  onRefresh: () => void;
}) {
  const wallet = useWalletSource();
  const [busy, setBusy] = useState(false);
  const available = canStake(wallet.source);
  const pending = snapshot?.pendingYield ?? 0;

  const onClaim = useCallback(async () => {
    if (!wallet.source || pending <= 0) return;
    append('sent', 'claim', `amount=${pending}`);
    setBusy(true);
    try {
      const result = await runClaimToWallet(session, wallet.source as WalletSource, pending);
      append(result.ok ? 'ok' : 'err', 'claim', result.message);
      if (result.bridgeSignature) append('event', 'bridge_iou', result.bridgeSignature);
      if (result.redeemSignature) append('event', 'redeem_swap', result.redeemSignature);
      onRefresh();
    } catch (err) {
      if (err instanceof StakingUnavailableError) append('err', 'claim', err.message);
      else if (err instanceof SessionError) append('err', 'claim', `${err.code}: ${err.message}`);
      else append('err', 'claim', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [session, wallet.source, pending, append, onRefresh]);

  return (
    <section className="glass-panel p-6">
      <h2 className="telemetry-label mb-4">Mining rewards</h2>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Stat label="Claimable" mono accent value={fmt(pending)} />
        <Stat label="Lifetime earned" mono value={fmt(snapshot?.lifetimeEarned ?? 0)} />
        <Stat label="Lifetime claimed" mono value={fmt(snapshot?.lifetimeRedeemed ?? 0)} />
      </div>
      <p className="mb-4 text-sm leading-relaxed text-white/55">
        Move your mined rewards out to your wallet as real{' '}
        <span className="text-cosmos">$ASTROID</span>. Your wallet signs once; nothing leaves the
        accumulator until it confirms.
      </p>
      {!available && (
        <p className="mb-4 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 font-mono text-xs text-ember">
          Connect a Solana wallet (or set NEXT_PUBLIC_SOLANA_RPC_URL in dev mode) to claim to your
          wallet.
        </p>
      )}
      <button
        className="btn-primary"
        disabled={!available || busy || pending <= 0}
        onClick={onClaim}
        type="button"
      >
        {busy ? 'Claiming…' : `Claim ${fmt(pending)} → $ASTROID`}
      </button>
    </section>
  );
}

// ============================================================================
// On-chain staking (Quarry)
// ============================================================================

function OnChainStakingPanel({
  session,
  append,
}: {
  session: Session;
  append: (kind: LogKind, label: string, detail?: string) => void;
}) {
  const wallet = useWalletSource();
  const [info, setInfo] = useState<UserStakeInfo | null>(null);
  const [amount, setAmount] = useState<number>(100);
  const [busy, setBusy] = useState<StakeActionKind | null>(null);
  const [chainOff, setChainOff] = useState(false);

  const available = canStake(wallet.source);

  const refresh = useCallback(async () => {
    try {
      const data = await session.getStakeInfo();
      setInfo(data);
      setChainOff(false);
    } catch (err) {
      if (err instanceof SessionError) {
        if (err.code === 'chain_disabled') setChainOff(true);
        else append('err', 'stake_info', `${err.code}: ${err.message}`);
      }
      setInfo(null);
    }
  }, [session, append]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (kind: StakeActionKind, amountOverride?: number) => {
      if (!wallet.source) return;
      const amt = amountOverride ?? amount;
      const label = `${kind}_tx`;
      append('sent', label, kind === 'claim' ? undefined : `amount=${amt}`);
      setBusy(kind);
      try {
        const result = await runStakeAction(session, wallet.source as WalletSource, kind, amt);
        append(result.ok ? 'ok' : 'err', label, result.signature ?? result.message);
        if (result.signature) append('event', label, result.message);
        await refresh();
      } catch (err) {
        if (err instanceof StakingUnavailableError) {
          append('err', label, err.message);
        } else if (err instanceof SessionError) {
          append('err', label, `${err.code}: ${err.message}`);
        } else {
          append('err', label, err instanceof Error ? err.message : String(err));
        }
      } finally {
        setBusy(null);
      }
    },
    [session, wallet.source, amount, append, refresh],
  );

  return (
    <section className="glass-panel p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="telemetry-label">On-chain staking &middot; Quarry</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cosmos">
          {wallet.mode}
        </span>
      </div>

      <p className="mb-4 text-sm leading-relaxed text-white/55">
        Lock $ASTROID to raise your drill tier and defense. Tiers are priced in USD and scale with
        the live price (Bronze / Silver / Gold / Diamond &asymp; $50 / $100 / $200 / $400).{' '}
        <span className="text-white/40">&ldquo;Redeem Creds&rdquo;</span> turns Astroid Creds in
        your wallet into $ASTROID (1:1) and finishes any unfinished claim.
      </p>

      {chainOff && (
        <p className="mb-4 rounded-md border border-white/15 bg-white/[0.03] px-3 py-2 font-mono text-xs text-white/60">
          On-chain staking is disabled on this gateway (<code>CHAIN_ENABLED=false</code>). The
          controls below are inert until you connect to a chain-enabled deployment.
        </p>
      )}

      {!available && !chainOff && (
        <p className="mb-4 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 font-mono text-xs text-ember">
          {wallet.mode === 'privy'
            ? 'Connect a Solana wallet to sign on-chain transactions.'
            : 'Dev mode needs NEXT_PUBLIC_SOLANA_RPC_URL set to submit transactions.'}
        </p>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat label="Staked $ASTROID" mono accent value={fmt(info?.stakedAmount ?? 0)} />
        <Stat label="Staking rewards (Creds)" mono value={fmt(info?.pendingRewards ?? 0)} />
        <Stat
          label="Last stake"
          value={info?.lastStakeTime ? short(new Date(info.lastStakeTime).toLocaleString()) : '-'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <label className="field">
          <span className="telemetry-label">Amount</span>
          <input
            className="field-input"
            min={1}
            onChange={(e) => setAmount(Number(e.target.value))}
            step={100}
            type="number"
            value={amount}
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button
            className="btn-primary"
            disabled={!available || busy !== null || amount <= 0}
            onClick={() => run('stake')}
            type="button"
          >
            {busy === 'stake' ? 'Staking…' : 'Stake'}
          </button>
          <button
            className="btn-secondary"
            disabled={!available || busy !== null || amount <= 0}
            onClick={() => run('unstake')}
            type="button"
          >
            {busy === 'unstake' ? 'Unstaking…' : 'Unstake'}
          </button>
          <button
            className="btn-secondary"
            disabled={!available || busy !== null || (info?.stakedAmount ?? 0) <= 0}
            onClick={() => run('unstake', info?.stakedAmount ?? 0)}
            title="Unstake your entire staked $ASTROID position"
            type="button"
          >
            {busy === 'unstake' ? 'Unstaking…' : `Unstake all${info?.stakedAmount ? ` (${fmt(info.stakedAmount)})` : ''}`}
          </button>
          <button
            className="btn-ghost"
            disabled={!available || busy !== null}
            onClick={() => run('claim')}
            title="Claim Quarry staking rewards (not mining rewards)"
            type="button"
          >
            {busy === 'claim' ? 'Claiming…' : 'Claim staking rewards'}
          </button>
          <button
            className="btn-ghost"
            disabled={!available || busy !== null || amount <= 0}
            onClick={() => run('redeem')}
            title="Convert Astroid Creds in your wallet to $ASTROID (1:1)"
            type="button"
          >
            {busy === 'redeem' ? 'Redeeming…' : 'Redeem Creds → $ASTROID'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Event log
// ============================================================================

function EventLog({ entries, version }: { entries: LogEntry[]; version: number }) {
  // version is unused in markup but binding it forces a re-render
  // when the buffer mutates without us cloning it on every push.
  void version;
  return (
    <section className="glass-panel p-4 lg:max-h-[80vh] lg:overflow-y-auto">
      <h2 className="telemetry-label mb-3">Event log</h2>
      {entries.length === 0 ? (
        <p className="font-mono text-xs text-white/45">No traffic yet.</p>
      ) : (
        <ol className="space-y-1.5 font-mono text-[11px]">
          {entries.map((e) => (
            <li className="flex gap-2 leading-snug" key={e.id}>
              <span className="shrink-0 text-white/30">{formatTime(e.ts)}</span>
              <span
                className={`shrink-0 uppercase tracking-[0.16em] ${
                  e.kind === 'ok'
                    ? 'text-emerald-300'
                    : e.kind === 'err'
                      ? 'text-ember'
                      : e.kind === 'event'
                        ? 'text-cosmos'
                        : 'text-white/55'
                }`}
              >
                {e.kind}
              </span>
              <span className="break-words text-white/85">
                {e.label}
                {e.detail && <span className="text-white/55"> &middot; {e.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

function short(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatExpiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const sec = Math.floor(ms / 1000);
  const mins = Math.floor(sec / 60);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${sec % 60}s`;
  return `${sec}s`;
}

function summariseRequest(message: Record<string, unknown>): string {
  const { type, ...rest } = message;
  void type;
  const entries = Object.entries(rest).filter(([k]) => k !== 'requestId');
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}
