'use client';

import Link from 'next/link';
import { useCallback } from 'react';

import type { ConnectSnapshot } from '@/lib/session';
import { connect, disconnect, useSession } from '@/lib/use-session';
import { useWalletSource } from '@/lib/wallet-source-providers';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';

type AuthDisplayState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; snapshot: ConnectSnapshot }
  | { kind: 'error'; code: string; message: string };

export default function SignInPage() {
  const sessionStore = useSession();
  const wallet = useWalletSource();

  const onSignIn = useCallback(async () => {
    try {
      const source = await wallet.connectWallet();
      await connect(WS_URL, source);
    } catch {
      // The session store already records the error.
    }
  }, [wallet]);

  const onSignOut = useCallback(async () => {
    disconnect();
    await wallet.disconnectWallet();
  }, [wallet]);

  const auth: AuthDisplayState =
    sessionStore.state === 'connected' && sessionStore.snapshot
      ? { kind: 'connected', snapshot: sessionStore.snapshot }
      : sessionStore.state === 'connecting'
        ? { kind: 'connecting' }
        : sessionStore.state === 'error' && sessionStore.error
          ? {
              kind: 'error',
              code: sessionStore.error.code,
              message: sessionStore.error.message,
            }
          : { kind: 'idle' };

  return (
    <div className="relative mx-auto max-w-3xl px-6 py-16 sm:px-8">
      <div className="glow-cyan -top-24 left-1/2 -translate-x-1/2" />

      <div className="relative">
        <p className="eyebrow mb-4">
          {wallet.mode === 'privy' ? 'Sign in' : 'Sign in \u00b7 dev mode'}
        </p>
        <h1 className="mb-3 font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
          {wallet.mode === 'privy' ? 'Connect your wallet' : 'Connect a dev wallet'}
        </h1>
        <p className="mb-10 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
          {wallet.mode === 'privy' ? (
            <>
              Privy opens an external Solana wallet of your choice (Phantom, Solflare, Backpack,
              etc.) and asks it to sign a one-time message. No transaction, no fees, no permissions
              granted. Your holdings are checked read-only on-chain.
            </>
          ) : (
            <>
              A dev keypair generated in your browser signs the auth message against the local
              server. Production builds use Privy + an external Solana wallet. Make sure the server
              is running:{' '}
              <code className="rounded bg-space-900/80 px-1.5 py-0.5 font-mono text-cosmos">
                npm run dev:server
              </code>
              .
            </>
          )}
        </p>

        <section className="glass-panel mb-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="telemetry-label">
              {wallet.mode === 'privy' ? 'Wallet' : 'Dev keypair'}
            </h2>
            <span
              className={`flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] ${
                auth.kind === 'connected'
                  ? 'text-emerald-300'
                  : auth.kind === 'connecting'
                    ? 'text-cosmos'
                    : 'text-white/45'
              }`}
            >
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  auth.kind === 'connected'
                    ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]'
                    : auth.kind === 'connecting'
                      ? 'bg-cosmos shadow-[0_0_6px_#00d4ff]'
                      : 'bg-white/30'
                }`}
              />
              {auth.kind === 'connected'
                ? 'Connected'
                : auth.kind === 'connecting'
                  ? 'Signing in'
                  : 'Idle'}
            </span>
          </div>
          {wallet.source ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
              <dt className="telemetry-label">Wallet address</dt>
              <dd className="break-all font-mono text-xs text-white/85">
                {wallet.source.publicKey}
              </dd>
              <dt className="telemetry-label">Server</dt>
              <dd className="break-all font-mono text-xs text-white/85">{WS_URL}</dd>
              <dt className="telemetry-label">Provider</dt>
              <dd className="font-mono text-xs text-white/85">
                {wallet.mode === 'privy' ? (
                  <a
                    className="inline-flex items-center gap-1 text-cosmos hover:text-cosmos/85"
                    href="https://privy.io"
                    rel="noreferrer"
                    target="_blank"
                  >
                    Privy <span aria-hidden>↗</span>
                  </a>
                ) : (
                  <span>local dev keypair (no Privy app id set)</span>
                )}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-white/55">
              {wallet.ready
                ? wallet.mode === 'privy'
                  ? 'Click "Connect wallet" to pick a Solana wallet via Privy.'
                  : 'Generating dev keypair…'
                : 'Waiting for wallet provider to bootstrap…'}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="btn-primary"
              disabled={!wallet.ready || auth.kind === 'connecting' || auth.kind === 'connected'}
              onClick={onSignIn}
              type="button"
            >
              {auth.kind === 'connecting'
                ? 'Signing in…'
                : auth.kind === 'connected'
                  ? 'Signed in'
                  : wallet.mode === 'privy' && !wallet.source
                    ? 'Connect wallet'
                    : 'Sign in'}
            </button>
            {auth.kind === 'connected' && (
              <button className="btn-secondary" onClick={onSignOut} type="button">
                Sign out
              </button>
            )}
          </div>
        </section>

        {auth.kind === 'error' &&
          (auth.code === 'beta_locked' ? (
            <section className="mb-6 rounded-2xl border border-cosmos/30 bg-cosmos/10 p-6">
              <p className="telemetry-label mb-2 text-cosmos">Closed beta</p>
              <p className="text-sm leading-relaxed text-white/85">{auth.message}</p>
            </section>
          ) : (
            <section className="mb-6 rounded-2xl border border-ember/40 bg-ember/10 p-6">
              <p className="telemetry-label mb-2 text-ember">Sign-in failed</p>
              <p className="mb-1 font-mono text-xs text-ember/85">code: {auth.code}</p>
              <p className="text-sm text-white/85">{auth.message}</p>
            </section>
          ))}

        {auth.kind === 'connected' && (
          <section className="glass-panel-bright p-6">
            <p className="eyebrow mb-3">Connected snapshot</p>
            <dl className="grid gap-3 text-sm sm:grid-cols-[200px_1fr]">
              <SnapshotRow label="Wallet address">
                <span className="break-all font-mono text-xs text-white/90">
                  {auth.snapshot.walletAddress}
                </span>
              </SnapshotRow>
              <SnapshotRow label="Home station">
                <Mono>{auth.snapshot.homeStationAsteroidId ?? '-'}</Mono>
              </SnapshotRow>
              <SnapshotRow label="Active asteroid">
                <Mono>{auth.snapshot.activeAsteroidId ?? '-'}</Mono>
              </SnapshotRow>
              <SnapshotRow label="Total stake">
                <Mono>{auth.snapshot.totalStake.toString()}</Mono>
              </SnapshotRow>
              <SnapshotRow label="Loyalty days">
                <Mono>{auth.snapshot.loyaltyDays.toString()}</Mono>
              </SnapshotRow>
              <SnapshotRow label="Pending yield">
                <Mono>{auth.snapshot.pendingYield.toString()}</Mono>
              </SnapshotRow>
              <SnapshotRow label="Asteroids registered">
                {auth.snapshot.asteroids.length === 0 ? (
                  <Mono>(none yet; the design pass populates these)</Mono>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {auth.snapshot.asteroids.map((a) => (
                      <li
                        className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-white/85"
                        key={a.id}
                      >
                        <span className={`resource-dot resource-dot--${a.resource}`} />
                        {a.name}
                      </li>
                    ))}
                  </ul>
                )}
              </SnapshotRow>
            </dl>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link className="btn-primary" href="/arena">
                Enter the arena
              </Link>
              <Link className="btn-secondary" href="/console">
                Open the test console
              </Link>
              <p className="w-full text-xs text-white/45">
                Your session WebSocket stays open across the route change.
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SnapshotRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="telemetry-label">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs text-white/85">{children}</span>;
}
