'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BrandMark } from '@/components/BrandMark';
import type { ArenaMeteor } from '@/components/arena/Arena';
import { ArenaSceneClient } from '@/components/arena/ArenaSceneClient';
import { clearHudLayout, DraggablePanel } from '@/components/arena/DraggablePanel';
import type { MeteorMode } from '@/components/arena/MeteorStrike';
import { NavRail } from '@/components/arena/NavRail';
import { ShareCardModal } from '@/components/arena/ShareCardModal';
import { RESOURCE_LABEL, asResourceKind } from '@/components/arena/asteroid-orbits';
import {
  type AsteroidNetworkStats,
  type ConnectSnapshot,
  type NetworkStatsSnapshot,
  Session,
  SessionError,
} from '@/lib/session';
import { encodeShareParams, minerCardSpec, raidCardSpec, renderShareCard } from '@/lib/share-card';
import {
  canStake,
  runClaimToWallet,
  runRedeemIou,
  runStakeAction,
  runWagerRaid,
  StakingUnavailableError,
} from '@/lib/staking-client';
import { connect, useSession } from '@/lib/use-session';
import type { WalletSource } from '@/lib/wallet-source';
import { useWalletSource } from '@/lib/wallet-source-providers';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';

/**
 * HUD refresh cadence. The arena pulls `miner_snapshot` and
 * `network_stats` together (one round-trip per refresh, two messages),
 * so polling at 15s == ~8 messages/min. Both message types are on the
 * server's read-only exemption list, so this no longer competes with
 * the per-wallet action budget; the cadence is now purely a UX/cost
 * trade-off rather than a rate-limit one. Game state evolves on the
 * 30-60s tick so faster refresh would mostly redraw identical data.
 */
const POLL_MS = 15_000;

/** A meteor threat tracked client-side for visuals + the deflect prompt. */
interface LiveMeteor extends ArenaMeteor {
  /** In-game credits required to deflect (from the server event). */
  deflectCost: number;
  /** Epoch ms when the meteor strikes if not deflected. */
  impactAt: number;
}

/**
 * The 3D mining arena.
 *
 * The Three.js canvas paints the scene full-bleed; HUD panels overlay
 * it via DOM. There is exactly one canvas on the page — auth state
 * only changes which HUD overlays render on top of it, never the
 * scene itself, so orbit motion stays continuous across sign-in.
 */
export default function ArenaPage() {
  const sessionStore = useSession();
  const wallet = useWalletSource();

  // Auto-connect when we have a wallet source already in hand:
  //   - dev mode: the keypair is always available, so this fires on
  //     mount and the arena is usable without a /sign-in detour.
  //   - privy mode: only fires if the user already authorized this
  //     app in a previous session (Privy persists), so we never
  //     spring the wallet modal on a cold visit. The disconnected
  //     overlay's CTA does that explicitly when the user opts in.
  useEffect(() => {
    if (sessionStore.state !== 'idle') return;
    if (!wallet.source) return;
    connect(WS_URL, wallet.source).catch(() => {
      /* error already published into the store */
    });
  }, [sessionStore.state, wallet.source]);

  return (
    <div className="relative h-[calc(100vh-180px)] min-h-[640px] w-full overflow-hidden">
      {sessionStore.state === 'connected' && sessionStore.session ? (
        <ConnectedArena session={sessionStore.session} initialSnapshot={sessionStore.snapshot} />
      ) : (
        <DisconnectedArena store={sessionStore} walletMode={wallet.mode} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Disconnected: canvas with a default snapshot + sign-in CTA                 */
/* -------------------------------------------------------------------------- */

function DisconnectedArena({
  store,
  walletMode,
}: {
  store: ReturnType<typeof useSession>;
  walletMode: 'privy' | 'dev';
}) {
  return (
    <>
      <div className="absolute inset-0 z-0">
        <ArenaSceneClient
          asteroids={[]}
          selectedAsteroidId={null}
          homeAsteroidId={null}
          activeAsteroidId={null}
          onSelectAsteroid={() => {
            /* no-op until signed in */
          }}
        />
      </div>
      <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
        <div className="glass-panel-bright max-w-md p-7 text-center">
          <p className="eyebrow mb-3">
            {store.state === 'connecting' ? 'Connecting' : 'Sign in to mine'}
          </p>
          <h2 className="mb-4 font-display text-2xl text-white">
            {store.state === 'error'
              ? store.error?.code === 'beta_locked'
                ? 'Closed beta'
                : 'Sign-in failed'
              : 'A door is about to open'}
          </h2>
          {store.state === 'error' && store.error ? (
            store.error.code === 'beta_locked' ? (
              <>
                <p className="mb-4 text-sm leading-relaxed text-cosmos/90">{store.error.message}</p>
                <Link className="btn-primary" href="/">
                  Back to astroid.club
                </Link>
              </>
            ) : (
              <>
                <p className="mb-4 font-mono text-xs text-ember">
                  {store.error.code}: {store.error.message}
                </p>
                <Link className="btn-primary" href="/sign-in">
                  Try again
                </Link>
              </>
            )
          ) : store.state === 'connecting' ? (
            <p className="text-sm text-white/55">
              {walletMode === 'privy' ? 'Verifying signature…' : 'Authenticating dev keypair…'}
            </p>
          ) : (
            <>
              <p className="mb-5 text-sm leading-relaxed text-white/65">
                Drag to look around, scroll to zoom. Click an asteroid to mine it once you&rsquo;re
                signed in.
              </p>
              <Link className="btn-primary" href="/sign-in">
                {walletMode === 'privy' ? 'Connect your wallet' : 'Connect a dev wallet'}
              </Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Connected: canvas + live HUD                                               */
/* -------------------------------------------------------------------------- */

function ConnectedArena({
  session,
  initialSnapshot,
}: {
  session: Session;
  initialSnapshot: ConnectSnapshot | null;
}) {
  const wallet = useWalletSource();
  const [snap, setSnap] = useState<ConnectSnapshot | null>(initialSnapshot);
  const [stats, setStats] = useState<NetworkStatsSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drillPower, setDrillPower] = useState(5_000);
  const [stakeAmount, setStakeAmount] = useState(100);
  const [betAmount, setBetAmount] = useState(0);
  const [raidFeed, setRaidFeed] = useState<string[]>([]);
  // Live meteor threats (for the 3D visuals + deflect prompt). Keyed by the
  // server meteor id; resolved meteors flip to 'struck'/'deflected' for the
  // impact flash, then are dropped after the animation settles.
  const [meteors, setMeteors] = useState<LiveMeteor[]>([]);
  const [deflecting, setDeflecting] = useState(false);
  // Bumped to snap every draggable HUD panel back to its default position.
  const [hudResetKey, setHudResetKey] = useState(0);
  // Amount left as IOU-ASTROID in the wallet when a claim's redeem step
  // didn't finish (e.g. the player was too slow to sign). Drives the
  // "Finish claim" recovery button so those rewards aren't stranded.
  const [pendingRedeem, setPendingRedeem] = useState(0);
  // Shareable-card state: a generate-in-progress flag, plus the most recent
  // raid outcome attributable to this client (so the share button has data).
  const [sharing, setSharing] = useState(false);
  const [shareModal, setShareModal] = useState<{
    blob: Blob;
    tweet: string;
    kind: string;
    title: string;
    shareUrl: string;
  } | null>(null);
  const [lastRaid, setLastRaid] = useState<{
    won: boolean;
    stolenYield: number;
    targetName: string;
    betAmount: number;
  } | null>(null);
  // The raid this client launched, kept in a ref so the broadcast
  // `raid_resolved` handler can attribute the outcome to the player without
  // re-subscribing on every change.
  const pendingMyRaid = useRef<{ targetId: string; targetName: string; betAmount: number } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([
        session.send<ConnectSnapshot>({ type: 'miner_snapshot' }),
        session.send<NetworkStatsSnapshot>({ type: 'network_stats' }),
      ]);
      setSnap(s);
      setStats(n);
    } catch {
      /* polled refresh — don't surface every transient failure */
    }
  }, [session]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Live raid feed: the server pushes raid_started / raid_resolved to every
  // client. Surface outcomes in a small ticker and refresh stats so treasury /
  // inbound-raid counts update immediately.
  useEffect(() => {
    const nameFor = (id?: string) =>
      (id && snap?.asteroids.find((a) => a.id === id)?.name) || 'an asteroid';
    const offStarted = session.on('raid_started', (d) => {
      const r = d as { targetAsteroidId?: string };
      setRaidFeed((f) => [`Raid launched on ${nameFor(r.targetAsteroidId)}.`, ...f].slice(0, 6));
      void refresh();
    });
    const offResolved = session.on('raid_resolved', (d) => {
      const r = d as { attackersWon?: boolean; stolenYield?: number; asteroidId?: string };
      const msg = r.attackersWon
        ? `Raid on ${nameFor(r.asteroidId)} succeeded — ${fmt(r.stolenYield ?? 0)} $ASTROID carried off.`
        : `Raid on ${nameFor(r.asteroidId)} was repelled.`;
      setRaidFeed((f) => [msg, ...f].slice(0, 6));
      const mine = pendingMyRaid.current;
      if (mine && mine.targetId === r.asteroidId) {
        setLastRaid({
          won: !!r.attackersWon,
          stolenYield: r.stolenYield ?? 0,
          targetName: mine.targetName,
          betAmount: mine.betAmount,
        });
        pendingMyRaid.current = null;
      }
      void refresh();
    });
    return () => {
      offStarted();
      offResolved();
    };
  }, [session, refresh, snap?.asteroids]);

  // Live meteor strikes: the server pushes meteor_incoming / meteor_resolved.
  // Track threats for the 3D visuals + the deflect prompt; flip resolved ones
  // to their impact animation, then drop them once it settles.
  useEffect(() => {
    const nameFor = (id?: string) =>
      (id && snap?.asteroids.find((a) => a.id === id)?.name) || 'an asteroid';
    const offIncoming = session.on('meteor_incoming', (d) => {
      const m = d as {
        meteorId?: string;
        asteroidId?: string;
        deflectCost?: number;
        impactAt?: string;
      };
      if (!m.meteorId || !m.asteroidId) return;
      const live: LiveMeteor = {
        meteorId: m.meteorId,
        asteroidId: m.asteroidId,
        mode: 'incoming',
        deflectCost: m.deflectCost ?? 0,
        impactAt: m.impactAt ? new Date(m.impactAt).getTime() : Date.now() + 90_000,
      };
      setMeteors((list) => [...list.filter((x) => x.meteorId !== live.meteorId), live]);
      setRaidFeed((f) => [`☄ Meteor inbound on ${nameFor(m.asteroidId)}!`, ...f].slice(0, 6));
    });
    const offResolved = session.on('meteor_resolved', (d) => {
      const m = d as {
        meteorId?: string;
        asteroidId?: string;
        deflected?: boolean;
        skimmed?: number;
      };
      if (!m.meteorId) return;
      const mode: MeteorMode = m.deflected ? 'deflected' : 'struck';
      setMeteors((list) =>
        list.map((x) => (x.meteorId === m.meteorId ? { ...x, mode } : x)),
      );
      setRaidFeed((f) =>
        [
          m.deflected
            ? `🛡 Meteor on ${nameFor(m.asteroidId)} deflected — treasury topped up.`
            : `☄ Meteor struck ${nameFor(m.asteroidId)} — ${fmt(m.skimmed ?? 0)} $ASTROID lost.`,
          ...f,
        ].slice(0, 6),
      );
      // Let the impact animation play, then drop the meteor and refresh stats.
      setTimeout(() => {
        setMeteors((list) => list.filter((x) => x.meteorId !== m.meteorId));
        void refresh();
      }, 1600);
    });
    return () => {
      offIncoming();
      offResolved();
    };
  }, [session, refresh, snap?.asteroids]);

  // Auto-dismiss the raid/meteor feed after a quiet period so the popup doesn't
  // linger on screen. Each new event resets the timer (this effect re-runs
  // whenever the feed changes).
  useEffect(() => {
    if (raidFeed.length === 0) return;
    const id = setTimeout(() => setRaidFeed([]), 12_000);
    return () => clearTimeout(id);
  }, [raidFeed]);

  const callAction = useCallback(
    async <T,>(
      label: string,
      message: Record<string, unknown> & { type: string },
    ): Promise<T | null> => {
      setBusy(label);
      setError(null);
      try {
        const data = await session.send<T>(message);
        await refresh();
        return data;
      } catch (err) {
        if (err instanceof SessionError) {
          setError({ code: err.code, message: err.message });
        } else if (err instanceof Error) {
          setError({ code: 'unknown', message: err.message });
        }
        return null;
      } finally {
        setBusy(null);
      }
    },
    [session, refresh],
  );

  // On-chain stake. Quarry is the source of truth, so the in-game
  // `stake` message is rejected (`use_onchain_staking`); the arena must
  // build + sign a real $ASTROID stake via the same flow as the console
  // panel. Quarry staking is a single global position (not per-asteroid),
  // so the selected asteroid is irrelevant to the amount being staked.
  const onStake = useCallback(async () => {
    if (!canStake(wallet.source) || !wallet.source) {
      setError({
        code: 'staking_unavailable',
        message: 'Connect a Solana wallet to stake $ASTROID on-chain.',
      });
      return;
    }
    setBusy('stake');
    setError(null);
    try {
      const result = await runStakeAction(
        session,
        wallet.source as WalletSource,
        'stake',
        stakeAmount,
      );
      if (!result.ok) {
        setError({ code: 'stake_failed', message: result.message });
      }
      await refresh();
    } catch (err) {
      if (err instanceof StakingUnavailableError) {
        setError({ code: 'staking_unavailable', message: err.message });
      } else if (err instanceof SessionError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'unknown', message: err.message });
      }
    } finally {
      setBusy(null);
    }
  }, [session, wallet.source, stakeAmount, refresh]);

  // Launch a raid with an on-chain escrowed wager: build a deposit, sign +
  // submit it with the wallet, then the gateway verifies + launches. Mirrors
  // the redeem UX (wallet-first signing). A 0-wager raid skips this and uses
  // the plain `start_expedition` path below.
  const launchWagerRaid = useCallback(
    async (targetAsteroidId: string, amount: number): Promise<void> => {
      if (!canStake(wallet.source) || !wallet.source) {
        setError({
          code: 'staking_unavailable',
          message: 'Connect a Solana wallet to place an on-chain wager.',
        });
        return;
      }
      setBusy('start_expedition');
      setError(null);
      setNotice(null);
      try {
        const result = await runWagerRaid(
          session,
          wallet.source as WalletSource,
          targetAsteroidId,
          amount,
        );
        if (result.ok) {
          setNotice(result.message);
        } else {
          setError({ code: 'wager_failed', message: result.message });
        }
        await refresh();
      } catch (err) {
        if (err instanceof StakingUnavailableError) {
          setError({ code: 'staking_unavailable', message: err.message });
        } else if (err instanceof SessionError) {
          setError({ code: err.code, message: err.message });
        } else if (err instanceof Error) {
          setError({ code: 'unknown', message: err.message });
        }
      } finally {
        setBusy(null);
      }
    },
    [session, wallet.source, refresh],
  );

  // Claim accrued mining rewards out to the wallet as real $ASTROID. This
  // BRIDGES the in-game IOU credits on-chain (server-signed) then has the
  // user sign an atomic redeem swap → $ASTROID. Credits leave the in-game
  // accumulator only once the bridge confirms (refunded on failure), so the
  // old "click claim and the rewards vanish" behaviour is gone.
  const onClaim = useCallback(async () => {
    if (!canStake(wallet.source) || !wallet.source) {
      setError({
        code: 'staking_unavailable',
        message: 'Connect a Solana wallet to claim your rewards to your wallet.',
      });
      return;
    }
    if (!snap || snap.pendingYield <= 0) return;
    setBusy('claim');
    setError(null);
    setNotice(null);
    try {
      const amount = snap.pendingYield;
      const result = await runClaimToWallet(session, wallet.source as WalletSource, amount);
      if (result.ok) {
        setNotice(result.message);
        setPendingRedeem(0);
      } else {
        setError({
          code: result.bridgedOnly ? 'redeem_incomplete' : 'claim_failed',
          message: result.message,
        });
        // The bridge moved the credits to IOU-ASTROID in the wallet but the
        // redeem swap didn't finish. Offer a one-click recovery instead of
        // stranding the rewards (the in-game claimable already shows 0).
        if (result.bridgedOnly) setPendingRedeem(amount);
      }
      await refresh();
    } catch (err) {
      if (err instanceof StakingUnavailableError) {
        setError({ code: 'staking_unavailable', message: err.message });
      } else if (err instanceof SessionError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'unknown', message: err.message });
      }
    } finally {
      setBusy(null);
    }
  }, [session, wallet.source, snap, refresh]);

  // Recovery for a claim that stopped at the bridge step: finish the redeem
  // swap for the IOU-ASTROID now sitting in the wallet.
  const onFinishRedeem = useCallback(async () => {
    if (!canStake(wallet.source) || !wallet.source || pendingRedeem <= 0) return;
    setBusy('claim');
    setError(null);
    setNotice(null);
    try {
      const result = await runRedeemIou(session, wallet.source as WalletSource, pendingRedeem);
      if (result.ok) {
        setNotice(result.message);
        setPendingRedeem(0);
      } else {
        setError({ code: 'redeem_incomplete', message: result.message });
      }
      await refresh();
    } catch (err) {
      if (err instanceof StakingUnavailableError) {
        setError({ code: 'staking_unavailable', message: err.message });
      } else if (err instanceof SessionError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'unknown', message: err.message });
      }
    } finally {
      setBusy(null);
    }
  }, [session, wallet.source, pendingRedeem, refresh]);

  const onSelect = useCallback((id: string) => {
    setSelectedId(id);
    setError(null);
  }, []);

  // The most urgent incoming meteor (if any) drives the deflect prompt.
  const incomingMeteor = useMemo(
    () => meteors.find((m) => m.mode === 'incoming') ?? null,
    [meteors],
  );
  // Asteroid ids with a still-inbound meteor — surfaced as a nav-rail alert.
  const meteorAsteroidIds = useMemo(
    () => meteors.filter((m) => m.mode === 'incoming').map((m) => m.asteroidId),
    [meteors],
  );

  // Pay to deflect a meteor: the cost is consumed from in-game credits and
  // routed straight into the asteroid's treasury (vault).
  const onDeflect = useCallback(async () => {
    if (!incomingMeteor) return;
    setDeflecting(true);
    setError(null);
    try {
      await session.send<{ asteroidId: string; cost: number; vaultBalance: number }>({
        type: 'deflect_meteor',
        meteorId: incomingMeteor.meteorId,
      });
      setRaidFeed((f) =>
        [`🛡 You paid ${fmt(incomingMeteor.deflectCost)} to deflect the meteor.`, ...f].slice(0, 6),
      );
      await refresh();
    } catch (err) {
      if (err instanceof SessionError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'unknown', message: err.message });
      }
    } finally {
      setDeflecting(false);
    }
  }, [session, incomingMeteor, refresh]);

  // Shareable cards (roadmap §3.4): render a branded PNG client-side, then open
  // a preview modal so the player chooses to copy / download / post — rather
  // than a surprise auto-download.
  const runShare = useCallback(
    async (spec: Parameters<typeof renderShareCard>[0], tweet: string, title: string) => {
      setSharing(true);
      setNotice(null);
      try {
        const blob = await renderShareCard(spec);
        // Phase 2: a /share?… link that unfurls with the server-rendered card.
        const shareUrl =
          typeof window !== 'undefined'
            ? `${window.location.origin}/share?${encodeShareParams(spec)}`
            : 'https://astroid.club';
        setShareModal({ blob, tweet, kind: spec.kind, title, shareUrl });
      } catch {
        setNotice('Could not generate the card. Please try again.');
      } finally {
        setSharing(false);
      }
    },
    [],
  );

  const onShareRun = useCallback(() => {
    if (!snap) return;
    const earned = Math.round(snap.lifetimeEarned).toLocaleString('en-US');
    void runShare(
      minerCardSpec(snap, stats),
      `I've mined ${earned} $ASTROID in the belt on astroid.club. Stake, raid, defend, repeat. ⛏`,
      'Share your mining run',
    );
  }, [snap, stats, runShare]);

  const onShareRaid = useCallback(() => {
    if (!lastRaid) return;
    const looted = Math.round(lastRaid.stolenYield).toLocaleString('en-US');
    const tweet = lastRaid.won
      ? `Just raided ${lastRaid.targetName} for ${looted} $ASTROID on astroid.club. ⚔`
      : `Hit ${lastRaid.targetName}'s defenses on astroid.club — they held. I'll be back. ⚔`;
    void runShare(
      raidCardSpec({
        won: lastRaid.won,
        stolenYield: lastRaid.stolenYield,
        targetName: lastRaid.targetName,
        betAmount: lastRaid.betAmount,
      }),
      tweet,
      lastRaid.won ? 'Share your raid' : 'Share your assault',
    );
  }, [lastRaid, runShare]);

  // Run a sequence of messages under one busy/error/refresh cycle. Used so
  // mining can join + report drill atomically (you can't report drill power
  // until the server has registered you as joined — see `joinAndReportDrill`).
  const runSequence = useCallback(
    async (label: string, steps: () => Promise<void>): Promise<void> => {
      setBusy(label);
      setError(null);
      try {
        await steps();
        await refresh();
      } catch (err) {
        if (err instanceof SessionError) {
          setError({ code: err.code, message: err.message });
        } else if (err instanceof Error) {
          setError({ code: 'unknown', message: err.message });
        }
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const selectedAsteroid = snap?.asteroids.find((a) => a.id === selectedId) ?? null;

  // "Mine here" / "Set drill": joining and reporting drill power are two
  // server steps, but the server rejects a drill report unless you've already
  // joined ("must join an asteroid first"). Always send the join first — it's
  // idempotent server-side (re-joining the asteroid you're already on is a
  // no-op re-register) — instead of trusting snap.activeAsteroidId. The
  // snapshot can claim you're mining when the server registry has no record of
  // you (e.g. after a restart restores your home station), so guarding the join
  // on activeAsteroidId would skip it and every drill report would fail.
  const joinAndReportDrill = useCallback(
    (label: string) => {
      if (!selectedAsteroid) return;
      const asteroidId = selectedAsteroid.id;
      void runSequence(label, async () => {
        await session.send<void>({ type: 'join_asteroid', asteroidId });
        await session.send<{ effective: number }>({ type: 'report_drill_power', drillPower });
      });
    },
    [runSequence, selectedAsteroid, session, drillPower],
  );
  const selectedStats = useMemo(() => {
    if (!stats || !selectedId) return null;
    return stats.asteroids.find((a) => a.asteroidId === selectedId) ?? null;
  }, [stats, selectedId]);

  const resetHud = useCallback(() => {
    clearHudLayout(['identity', 'network', 'navrail', 'action']);
    setHudResetKey((k) => k + 1);
  }, []);

  // Single-source the HUD panels as render closures so the mobile (flow) and
  // desktop (draggable) layers stay in sync without duplicating prop lists.
  const renderIdentity = () => (
    <IdentityPanel
      busy={busy}
      notice={notice}
      onClaim={onClaim}
      onDismissNotice={() => setNotice(null)}
      onFinishRedeem={onFinishRedeem}
      onShareRun={onShareRun}
      onStake={onStake}
      pendingRedeem={pendingRedeem}
      setStakeAmount={setStakeAmount}
      sharing={sharing}
      snapshot={snap}
      stakeAmount={stakeAmount}
      stats={stats}
    />
  );

  const renderNetwork = () => (stats ? <NetworkStatsHud stats={stats} /> : null);

  const renderNav = () => (
    <NavRail
      asteroids={snap?.asteroids ?? []}
      stats={stats}
      meteorAsteroidIds={meteorAsteroidIds}
      selectedId={selectedId}
      homeId={snap?.homeStationAsteroidId ?? null}
      activeId={snap?.activeAsteroidId ?? null}
      onSelect={onSelect}
    />
  );

  const renderMeteorToast = () =>
    incomingMeteor ? (
      <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border border-orange-400/40 bg-orange-500/10 p-3 shadow-[0_0_30px_-8px_rgba(255,122,60,0.6)]">
        <span className="text-2xl leading-none">☄</span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-orange-200">
            Meteor inbound on{' '}
            {snap?.asteroids.find((a) => a.id === incomingMeteor.asteroidId)?.name ?? 'an asteroid'}
          </p>
          <p className="font-mono text-[10px] text-white/60">
            Deflect to skim nothing and top up the treasury, or eat a vault skim + yield hit.
          </p>
        </div>
        <button
          className="shrink-0 rounded-md border border-orange-400/50 bg-orange-400/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-orange-100 transition hover:bg-orange-400/25 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={deflecting}
          onClick={onDeflect}
          type="button"
        >
          {deflecting ? 'Deflecting…' : `Deflect (${fmt(incomingMeteor.deflectCost)})`}
        </button>
      </div>
    ) : null;

  const renderRaidFeed = () =>
    raidFeed.length > 0 ? (
      <div className="glass-panel-bright pointer-events-auto max-w-md p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="telemetry-label">Raid feed</p>
          {lastRaid && (
            <button
              className="inline-flex items-center gap-1 rounded border border-cosmos/30 bg-cosmos/5 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-cosmos transition hover:bg-cosmos/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={sharing}
              onClick={onShareRaid}
              title="Generate a shareable card of your last raid"
              type="button"
            >
              {sharing ? 'Generating…' : 'Share raid'}
            </button>
          )}
        </div>
        <ul className="space-y-0.5">
          {raidFeed.map((line, i) => (
            <li className="font-mono text-[11px] leading-relaxed text-white/70" key={`${line}-${i}`}>
              {line}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const renderActionArea = () =>
    selectedAsteroid ? (
      <AsteroidActionPanel
        asteroid={selectedAsteroid}
        busy={busy}
        drillPower={drillPower}
        error={error}
        onClose={() => setSelectedId(null)}
        betAmount={betAmount}
        onLaunchRaid={() => {
          pendingMyRaid.current = {
            targetId: selectedAsteroid.id,
            targetName: selectedAsteroid.name,
            betAmount,
          };
          if (betAmount > 0) {
            // Wagered raid: escrow the wager on-chain (wallet-first signing),
            // then the gateway verifies + launches.
            void launchWagerRaid(selectedAsteroid.id, betAmount);
          } else {
            // No-wager raid: launch directly.
            void callAction<{ expeditionId: string }>('start_expedition', {
              type: 'start_expedition',
              targetAsteroidId: selectedAsteroid.id,
              betAmount: 0,
            });
          }
        }}
        onLeave={() => callAction<void>('leave_asteroid', { type: 'leave_asteroid' })}
        onLeaveRaid={() => callAction<void>('leave_expedition', { type: 'leave_expedition' })}
        onMine={() => joinAndReportDrill('join_asteroid')}
        onRally={() =>
          callAction<void>('rally_defense', {
            type: 'rally_defense',
            asteroidId: selectedAsteroid.id,
            tokenCost: stakeAmount,
          })
        }
        onReportDrill={() => joinAndReportDrill('report_drill_power')}
        onSetHome={() =>
          callAction<void>('set_home_station', {
            type: 'set_home_station',
            asteroidId: selectedAsteroid.id,
          })
        }
        setBetAmount={setBetAmount}
        setDrillPower={setDrillPower}
        snapshot={snap}
        stakeAmount={stakeAmount}
        stats={selectedStats}
      />
    ) : (
      <SelectionHint />
    );

  return (
    <>
      <div className="absolute inset-0 z-0">
        <ArenaSceneClient
          asteroids={snap?.asteroids ?? []}
          selectedAsteroidId={selectedId}
          homeAsteroidId={snap?.homeStationAsteroidId ?? null}
          activeAsteroidId={snap?.activeAsteroidId ?? null}
          onSelectAsteroid={onSelect}
          meteors={meteors}
        />
      </div>

      {/* ───────────────── Mobile HUD (flow layout, no dragging) ───────────────── */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col sm:hidden">
        <div className="flex items-start justify-between gap-2 p-3">
          {renderIdentity()}
          {renderNetwork()}
        </div>
        {incomingMeteor && <div className="pointer-events-none px-4 pb-2">{renderMeteorToast()}</div>}
        {raidFeed.length > 0 && (
          <div className="pointer-events-none px-4">
            <div className="mx-auto max-w-md">{renderRaidFeed()}</div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-3">
          {renderActionArea()}
        </div>
      </div>

      {/* ───────────── Desktop HUD (draggable panels, PC only) ───────────── */}
      <div className="pointer-events-none absolute inset-0 z-10 hidden sm:block">
        <Link
          aria-label="astroid.club home"
          className="pointer-events-auto absolute bottom-4 left-4 z-10 inline-flex opacity-60 transition-opacity hover:opacity-100"
          href="/"
        >
          <BrandMark size={24} />
        </Link>

        {snap && (
          <DraggablePanel
            bumpKey={hudResetKey}
            defaultPos={() => ({ x: 16, y: 16 })}
            storageId="identity"
          >
            {renderIdentity()}
          </DraggablePanel>
        )}

        {stats && (
          <DraggablePanel
            bumpKey={hudResetKey}
            defaultPos={(vw) => ({ x: vw - 196, y: 16 })}
            storageId="network"
          >
            {renderNetwork()}
          </DraggablePanel>
        )}

        {snap && snap.asteroids.length > 0 && (
          <DraggablePanel
            bumpKey={hudResetKey}
            // Start ~40% down the left edge: clears the (taller) identity HUD up
            // top while leaving room for the rail's max-h-55vh below it so the
            // whole rail stays on-screen by default.
            defaultPos={(_vw, vh) => ({ x: 16, y: Math.round(vh * 0.4) })}
            storageId="navrail"
          >
            {renderNav()}
          </DraggablePanel>
        )}

        {selectedAsteroid ? (
          <DraggablePanel
            bumpKey={hudResetKey}
            className="w-[min(760px,86vw)]"
            defaultPos={(vw, vh) => ({ x: Math.max(16, (vw - 760) / 2), y: Math.max(16, vh - 420) })}
            storageId="action"
          >
            <div className="max-h-[82vh] overflow-y-auto overscroll-contain">
              {renderActionArea()}
            </div>
          </DraggablePanel>
        ) : (
          <div className="absolute bottom-6 left-1/2 w-full max-w-md -translate-x-1/2 px-4">
            <SelectionHint />
          </div>
        )}

        {incomingMeteor && (
          <div className="pointer-events-none absolute left-1/2 top-3 w-full max-w-md -translate-x-1/2 px-4">
            {renderMeteorToast()}
          </div>
        )}
        {raidFeed.length > 0 && (
          <div className="pointer-events-none absolute left-1/2 top-24 w-full max-w-md -translate-x-1/2 px-4">
            {renderRaidFeed()}
          </div>
        )}

        <button
          className="pointer-events-auto absolute bottom-4 right-4 z-10 rounded-md border border-white/10 bg-space-950/70 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45 backdrop-blur transition hover:border-white/25 hover:text-white/80"
          onClick={resetHud}
          title="Reset HUD panels to their default positions"
          type="button"
        >
          Reset HUD
        </button>
      </div>

      {shareModal && (
        <ShareCardModal
          blob={shareModal.blob}
          kind={shareModal.kind}
          onClose={() => setShareModal(null)}
          shareUrl={shareModal.shareUrl}
          title={shareModal.title}
          tweet={shareModal.tweet}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  HUD pieces                                                                 */
/* -------------------------------------------------------------------------- */

function IdentityPanel({
  snapshot,
  stats,
  busy,
  notice,
  onClaim,
  onDismissNotice,
  onFinishRedeem,
  onShareRun,
  onStake,
  stakeAmount,
  setStakeAmount,
  pendingRedeem,
  sharing,
}: {
  snapshot: ConnectSnapshot | null;
  stats: NetworkStatsSnapshot | null;
  busy: string | null;
  notice: string | null;
  onClaim: () => void;
  onDismissNotice: () => void;
  onFinishRedeem: () => void;
  onShareRun: () => void;
  onStake: () => void;
  stakeAmount: number;
  setStakeAmount: (n: number) => void;
  pendingRedeem: number;
  sharing: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Default to collapsed on small screens to reclaim arena space; expand on
  // wider viewports. Runs after mount so it doesn't desync SSR markup.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) setCollapsed(true);
  }, []);
  if (!snapshot) return null;
  const canClaim = snapshot.pendingYield > 0;
  const claiming = busy === 'claim';
  const staking = busy === 'stake';
  // Spend balances surfaced so it's clear what each action draws from:
  //  • deflecting meteors spends in-game CREDITS (= claimable pending yield)
  //  • raid wagers risk STAKED $ASTROID, capped at 20% of your home stake
  const credits = snapshot.pendingYield;
  const maxWager = snapshot.homeStationAsteroidId ? snapshot.totalStake * 0.2 : 0;
  return (
    <div className="pointer-events-auto glass-panel-bright w-[56vw] max-w-xs px-3 py-2.5 sm:w-auto sm:px-4 sm:py-3">
      <div className="mb-1 flex items-center gap-2">
        <span aria-hidden className="live-dot" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300">
          Connected
        </span>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          className="ml-auto -my-1 rounded px-2 py-1 font-mono text-lg leading-none text-white/55 transition hover:bg-white/10 hover:text-white"
          onClick={() => setCollapsed((c) => !c)}
          type="button"
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>
      <div className="font-mono text-[11px] text-white/85">{short(snapshot.walletAddress)}</div>
      {collapsed && canClaim && (
        <div className="mt-1 font-mono text-[11px] font-semibold text-emerald-300">
          {fmt(snapshot.pendingYield)} claimable
        </div>
      )}
      {snapshot.activeExpedition && (
        <RaidInProgress expedition={snapshot.activeExpedition} snapshot={snapshot} />
      )}
      {collapsed ? null : (
        <>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        <Pill label="Home" value={snapshot.homeStationAsteroidId ?? '-'} />
        <Pill
          accent={!!snapshot.activeAsteroidId}
          label="Mining"
          value={snapshot.activeAsteroidId ?? '-'}
        />
        <Pill label="Stake" value={fmt(snapshot.totalStake)} />
        {snapshot.tier && (
          <Pill
            accent
            label="Tier"
            value={`${snapshot.tier.tierName} ${snapshot.tier.drillPowerMultiplier}×`}
          />
        )}
      </div>
      {snapshot.tier &&
        (snapshot.tier.nextTierName ? (
          <div className="mt-1 font-mono text-[10px] leading-relaxed text-white/55">
            Stake{' '}
            <span className="font-semibold text-cosmos">
              {fmt(snapshot.tier.tokensToNextTier)}
            </span>{' '}
            more $ASTROID → <span className="text-white/85">{snapshot.tier.nextTierName}</span>
            {snapshot.tier.nextTierDrillMultiplier
              ? ` (${snapshot.tier.nextTierDrillMultiplier}× drill`
              : ''}
            {snapshot.tier.nextTierUsd ? `, ~$${snapshot.tier.nextTierUsd})` : ')'}
          </div>
        ) : (
          <div className="mt-1 font-mono text-[10px] text-emerald-300/80">
            Max drill tier reached
          </div>
        ))}

      {/* Mining-rewards accumulator: claimable now + lifetime earned /
          claimed, so a claim never erases the record of what was earned. */}
      <div className="mt-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
          Mining rewards
        </div>
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300/80">
            Claimable
          </span>
          <span className="font-mono text-sm font-semibold text-emerald-300">
            {fmt(snapshot.pendingYield)}
          </span>
        </div>
        <div className="mt-1 flex justify-between gap-3 font-mono text-[10px] text-white/45">
          <span>Earned {fmt(snapshot.lifetimeEarned)}</span>
          <span>Claimed {fmt(snapshot.lifetimeRedeemed)}</span>
        </div>
      </div>

      {/* Spend balances: makes it explicit which pool each action draws from. */}
      <div className="mt-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
          Spend balances
        </div>
        <div className="flex items-baseline justify-between font-mono text-[10px]">
          <span className="uppercase tracking-[0.14em] text-cosmos/80">Credits · deflect</span>
          <span className="font-semibold text-cosmos">{fmt(credits)}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between font-mono text-[10px]">
          <span className="uppercase tracking-[0.14em] text-ember/80">Suggested wager</span>
          <span className="font-semibold text-ember">{fmt(maxWager)}</span>
        </div>
        <div className="mt-1.5 border-t border-white/10 pt-1.5 font-mono text-[9px] leading-relaxed text-white/40">
          Deflecting meteors spends credits (your claimable balance). Raid wagers escrow real
          $ASTROID from your connected wallet — a win returns your wager, a loss burns 90% and pays
          10% to the defenders.
        </div>
      </div>

      {/* Stake $ASTROID — consolidated here (was at the bottom action panel). */}
      <div className="mt-2 flex items-end gap-2">
        <label className="field flex-1">
          <span className="telemetry-label">Stake amount</span>
          <input
            className="field-input"
            disabled={staking}
            min={1}
            onChange={(e) => setStakeAmount(Number(e.target.value))}
            step={100}
            type="number"
            value={stakeAmount}
          />
        </label>
        <button
          className="shrink-0 rounded-md border border-cosmos/40 bg-cosmos/10 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-cosmos transition hover:bg-cosmos/15 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={staking || stakeAmount <= 0}
          onClick={onStake}
          type="button"
        >
          {staking ? 'Staking…' : `Stake ${fmt(stakeAmount)}`}
        </button>
      </div>

      {canClaim && (
        <button
          className="mt-2 w-full rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-300 transition hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={claiming}
          onClick={onClaim}
          type="button"
        >
          {claiming ? 'Claiming…' : `Claim ${fmt(snapshot.pendingYield)} → $ASTROID`}
        </button>
      )}
      {pendingRedeem > 0 && (
        <button
          className="mt-2 w-full rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-300 transition hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={claiming}
          onClick={onFinishRedeem}
          title="Your rewards were bridged to IOU-ASTROID but the redeem step didn't finish. Finish it now — nothing was lost."
          type="button"
        >
          {claiming ? 'Finishing…' : `Finish claim ${fmt(pendingRedeem)} → $ASTROID`}
        </button>
      )}
      <button
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-cosmos/30 bg-cosmos/5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-cosmos transition hover:bg-cosmos/10 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={sharing}
        onClick={onShareRun}
        title="Generate a shareable card of your mining run"
        type="button"
      >
        {sharing ? 'Generating…' : 'Share my run'}
      </button>
      {notice && (
        <button
          className="mt-2 w-full rounded-md border border-emerald-400/30 bg-emerald-400/5 px-3 py-1.5 text-left font-mono text-[10px] leading-relaxed text-emerald-200/90"
          onClick={onDismissNotice}
          title="Dismiss"
          type="button"
        >
          {notice}
        </button>
      )}
      {stats && stats.activeExpeditions > 0 && (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ember">
          {stats.activeExpeditions} raid{stats.activeExpeditions === 1 ? '' : 's'} active
        </div>
      )}
        </>
      )}
    </div>
  );
}

function NetworkStatsHud({ stats }: { stats: NetworkStatsSnapshot }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) setCollapsed(true);
  }, []);
  return (
    <div className="pointer-events-auto glass-panel w-[30vw] max-w-[10rem] px-2.5 py-2 text-right sm:w-auto sm:max-w-xs sm:px-4 sm:py-3">
      <div className="mb-1.5 flex items-center justify-end gap-2 sm:mb-2">
        <p className="telemetry-label">Network</p>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand network stats' : 'Collapse network stats'}
          className="-my-1 rounded px-2 py-1 font-mono text-lg leading-none text-white/55 transition hover:bg-white/10 hover:text-white"
          onClick={() => setCollapsed((c) => !c)}
          type="button"
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>
      {!collapsed && (
        <div className="space-y-0.5 font-mono text-[10px] text-white/85 sm:text-[11px]">
          <div>{fmt(stats.totalMiners)} miners</div>
          <div>{fmt(stats.totalDrillPower)} drill</div>
          <div>{fmt(stats.totalStake)} staked</div>
          <div>{fmt(stats.totalDiscoveries)} discoveries</div>
        </div>
      )}
    </div>
  );
}

/** Persistent "raid in progress" indicator shown in the identity HUD. */
function RaidInProgress({
  expedition,
  snapshot,
}: {
  expedition: NonNullable<ConnectSnapshot['activeExpedition']>;
  snapshot: ConnectSnapshot;
}) {
  const targetName =
    snapshot.asteroids.find((a) => a.id === expedition.targetAsteroidId)?.name ??
    expedition.targetAsteroidId;
  const winning = expedition.attackPower >= expedition.defenseToBeat;
  return (
    <div className="mt-2 rounded-md border border-ember/40 bg-ember/10 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">
          Raid in progress
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] leading-relaxed text-white/85">
        Striking <span className="text-white">{targetName}</span>
      </p>
      <p className="font-mono text-[10px] leading-relaxed text-white/55">
        Your strike {fmt(expedition.attackPower)} vs {fmt(expedition.defenseToBeat)} needed —{' '}
        <span className={winning ? 'text-emerald-300' : 'text-ember'}>
          {winning ? 'projected to break through' : 'not enough power yet'}
        </span>
        . Resolves when the target next strikes ore.
      </p>
    </div>
  );
}

function SelectionHint() {
  return (
    <div className="pointer-events-none mx-auto mt-auto max-w-md text-center sm:mt-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
        Drag to look · scroll to zoom · click an asteroid to mine
      </p>
    </div>
  );
}

function AsteroidActionPanel({
  asteroid,
  stats,
  snapshot,
  busy,
  error,
  drillPower,
  setDrillPower,
  stakeAmount,
  onMine,
  onLeave,
  onSetHome,
  onReportDrill,
  onLaunchRaid,
  onLeaveRaid,
  onRally,
  betAmount,
  setBetAmount,
  onClose,
}: {
  asteroid: { id: string; name: string; resource: string; flavor: string; sector: string };
  stats: AsteroidNetworkStats | null;
  snapshot: ConnectSnapshot | null;
  busy: string | null;
  error: { code: string; message: string } | null;
  drillPower: number;
  setDrillPower: (n: number) => void;
  stakeAmount: number;
  onMine: () => void;
  onLeave: () => void;
  onSetHome: () => void;
  onReportDrill: () => void;
  onLaunchRaid: () => void;
  onLeaveRaid: () => void;
  onRally: () => void;
  betAmount: number;
  setBetAmount: (n: number) => void;
  onClose: () => void;
}) {
  const resource = asResourceKind(asteroid.resource);
  const isActive = snapshot?.activeAsteroidId === asteroid.id;
  const isHome = snapshot?.homeStationAsteroidId === asteroid.id;
  const canRaid = !!snapshot?.homeStationAsteroidId && !isHome;
  const onExpedition = !!snapshot?.onExpedition;
  const underAttack = (stats?.activeRaidCount ?? 0) > 0;
  const isBusy = busy !== null;

  // The 8-box stat grid is the panel's biggest space hog; collapse it by
  // default on mobile so the 3D scene stays visible behind the sheet.
  const [statsOpen, setStatsOpen] = useState(true);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) setStatsOpen(false);
  }, []);

  return (
    // `mt-auto` pins the sheet to the bottom of the scrollable panel area on
    // mobile (and is reset on desktop, where a spacer handles positioning).
    // The area's own overflow scrolls it, so it can never spill past the
    // viewport and clip the action buttons.
    <div className="pointer-events-auto mx-auto mt-auto w-full max-w-3xl sm:mt-0">
      <div className="glass-panel-bright p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className={`resource-dot resource-dot--${resource}`} />
              <h3 className="font-display text-xl text-white">{asteroid.name}</h3>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
                {asteroid.flavor}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                · {asteroid.sector}
              </span>
              {isActive && <Tag color="cosmos">Mining</Tag>}
              {isHome && <Tag color="ember">Home</Tag>}
            </div>
            <p className="text-xs text-white/55">{RESOURCE_LABEL[resource]}</p>
          </div>
          <button
            aria-label="Deselect asteroid"
            className="btn-ghost"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        {isActive && (
          <div className="mb-4 flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ember" />
            </span>
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ember">
              Drilling · {fmt(stats?.drillPower ?? drillPower)} drill power
            </span>
          </div>
        )}

        <div className="mb-4">
          <button
            aria-expanded={statsOpen}
            className="mb-2 flex w-full items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/45 transition hover:text-white/75"
            onClick={() => setStatsOpen((o) => !o)}
            type="button"
          >
            <span>Asteroid stats</span>
            <span aria-hidden className="text-base leading-none">
              {statsOpen ? '▴' : '▾'}
            </span>
          </button>
          {statsOpen &&
            (stats ? (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Mini label="Miners" value={fmt(stats.minerCount)} />
                <Mini label="Drill power" value={fmt(stats.drillPower)} />
                <Mini label="Total stake" value={fmt(stats.totalStake)} />
                <Mini label="Discoveries" value={fmt(stats.discoveriesFound)} />
                <Mini label="Treasury" value={`${fmt(stats.refineryBalance)} $ASTROID`} />
                <Mini label="Defense" value={fmt(stats.defensePower)} />
                <Mini label="Inbound raids" value={fmt(stats.activeRaidCount)} />
                <Mini label="Stealable" value={fmt(stats.stealableYield)} />
              </dl>
            ) : (
              // Stats arrive on a separate `network_stats` poll, so a freshly
              // selected asteroid (or a transient refresh miss) can land here
              // with no row yet. Show a loading state instead of hiding the
              // whole block — players were reading the missing Treasury row as
              // "the treasury disappeared".
              <p className="font-mono text-[11px] text-white/40">Loading live stats…</p>
            ))}
        </div>

        {error && (
          <p className="mb-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 font-mono text-xs text-ember">
            {error.code}: {error.message}
          </p>
        )}

        {/* Drill power gets its own row (capped width) so it can't be squeezed
            into a sliver by the wrapping action buttons below it. Staking moved
            to the top stats panel. */}
        <div className="space-y-3">
          <label className="field w-full sm:max-w-[16rem]">
            <span className="telemetry-label">Drill power</span>
            <input
              className="field-input"
              disabled={isBusy}
              min={0}
              onChange={(e) => setDrillPower(Number(e.target.value))}
              step={100}
              type="number"
              value={drillPower}
            />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            {!isActive ? (
              <button className="btn-primary" disabled={isBusy} onClick={onMine} type="button">
                {busy === 'join_asteroid' ? 'Joining…' : 'Mine here'}
              </button>
            ) : (
              <button className="btn-secondary" disabled={isBusy} onClick={onLeave} type="button">
                {busy === 'leave_asteroid' ? 'Leaving…' : 'Leave'}
              </button>
            )}
            <button
              className="btn-secondary"
              disabled={isBusy || isHome}
              onClick={onSetHome}
              type="button"
            >
              {isHome ? 'Your home' : busy === 'set_home_station' ? 'Setting…' : 'Set as home'}
            </button>
            <button className="btn-ghost" disabled={isBusy} onClick={onReportDrill} type="button">
              {busy === 'report_drill_power' ? '…' : 'Set drill'}
            </button>
            {canRaid && (
              <button className="btn-ember" disabled={isBusy} onClick={onLaunchRaid} type="button">
                {busy === 'start_expedition' ? 'Launching…' : `Raid${betAmount > 0 ? ` (${fmt(betAmount)})` : ''}`}
              </button>
            )}
            {onExpedition && (
              <button
                className="btn-secondary"
                disabled={isBusy}
                onClick={onLeaveRaid}
                type="button"
              >
                {busy === 'leave_expedition' ? 'Recalling…' : 'Recall raid'}
              </button>
            )}
            {underAttack && (
              <button className="btn-secondary" disabled={isBusy} onClick={onRally} type="button">
                {busy === 'rally_defense' ? 'Rallying…' : `Rally (${fmt(stakeAmount)})`}
              </button>
            )}
          </div>
        </div>

        {canRaid && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="field">
              <span className="telemetry-label">Raid wager (optional · escrowed on-chain)</span>
              <input
                className="field-input"
                disabled={isBusy}
                min={0}
                onChange={(e) => setBetAmount(Number(e.target.value))}
                step={50}
                type="number"
                value={betAmount}
              />
            </label>
            <p className="self-end font-mono text-[10px] leading-relaxed text-white/45">
              Beat {fmt(stats?.defensePower ?? 0)} defense to carry off up to{' '}
              {fmt(stats?.stealableYield ?? 0)} $ASTROID from this asteroid&rsquo;s treasury. A wager
              escrows real $ASTROID from your wallet — returned on a win, 90% burned (10% to
              defenders) on a loss.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1 ${accent ? 'text-cosmos' : 'text-white/85'}`}
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">
        {label}
      </span>
      <span className="font-mono text-[11px]">{value}</span>
    </span>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-space-950/55 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className="font-mono text-[13px] text-white/85 sm:text-sm">{value}</div>
    </div>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color: 'cosmos' | 'ember' }) {
  const palette = {
    cosmos: 'border-cosmos/40 bg-cosmos/10 text-cosmos',
    ember: 'border-ember/40 bg-ember/10 text-ember',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${palette[color]}`}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

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
