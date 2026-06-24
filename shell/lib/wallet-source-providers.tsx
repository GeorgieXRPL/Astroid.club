'use client';

/**
 * Wallet-source providers — Privy and dev keypair behind one Context.
 *
 * Pages call `useWalletSource()` and get back the same shape regardless
 * of which mode the build is in:
 *
 *   {
 *     source: WalletSource | null,   // null until a wallet is connected
 *     ready: boolean,                // SDK has finished bootstrapping
 *     mode: 'privy' | 'dev',
 *     connectWallet(): Promise<WalletSource>,   // opens picker if needed
 *     disconnectWallet(): Promise<void>,
 *   }
 *
 * Mode is decided at module load by `wallet-mode.ts`. The matching
 * provider is mounted by `RootWalletProviders` in `layout.tsx`. Two
 * provider trees, one consumer interface — pages don't know or care
 * which one they're talking to.
 *
 * The Privy provider is loaded LAZILY via `next/dynamic`. That keeps
 * dev-mode SSR free of Privy's heavyweight peer-dep graph (it pulls
 * in 600+ packages including optional `@solana/kit` peers). When
 * `WALLET_MODE === 'dev'` the Privy chunk is never even fetched.
 */

import dynamic from 'next/dynamic';
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { devKeypairAsWalletSource, getOrCreateDevKeypair } from './dev-keypair';
import { PRIVY_APP_ID, WALLET_MODE } from './wallet-mode';
import { WalletSourceContext, type WalletSourceContextValue } from './wallet-source-context';
import type { WalletSource } from './wallet-source';

/* -------------------------------------------------------------------------- */
/*  Public hook                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe to the active wallet source. The component must be
 * rendered inside `<RootWalletProviders>` (which the root layout
 * already mounts).
 */
export function useWalletSource(): WalletSourceContextValue {
  const ctx = useContext(WalletSourceContext);
  if (!ctx) {
    throw new Error('useWalletSource must be used inside <RootWalletProviders>');
  }
  return ctx;
}

/* -------------------------------------------------------------------------- */
/*  Top-level switch                                                           */
/* -------------------------------------------------------------------------- */

// Lazy-loaded Privy provider. `ssr: false` keeps Privy's import graph
// off the server pass entirely — none of its optional peer deps need
// to resolve under SSR. The chunk is only fetched once the privy-mode
// gate below mounts the lazy component on the client.
const PrivyWalletShellLazy = dynamic(
  () => import('./wallet-source-privy').then((m) => m.PrivyWalletShell),
  {
    ssr: false,
    loading: () => null,
  },
);

/**
 * Mounts the right wallet-source provider for the current build. Use
 * this once at the root of the app (layout.tsx).
 */
export function RootWalletProviders({ children }: { children: ReactNode }) {
  if (WALLET_MODE === 'privy' && PRIVY_APP_ID) {
    return <PrivyModeGate appId={PRIVY_APP_ID}>{children}</PrivyModeGate>;
  }
  return <DevWalletProvider>{children}</DevWalletProvider>;
}

/* -------------------------------------------------------------------------- */
/*  Privy mode gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Two-phase mount for privy mode. SSR and the very first client paint
 * publish a "still booting" stub Context so the rest of the page can
 * render normally — locked landing copy, footer, header all SSR fine.
 * Once we're hydrated on the client we swap in the real Privy shell,
 * which lazy-loads the SDK chunk and starts publishing real wallet
 * state.
 *
 * Without this two-phase trick the entire app subtree under
 * `next/dynamic({ssr: false})` gets stripped from SSR — the user would
 * land on a blank page until Privy's 600-package chunk arrived. With
 * it, the page is interactive in well under a second; the wallet
 * picker just isn't available until the SDK is ready.
 */
function PrivyModeGate({ appId, children }: { appId: string; children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  if (!hydrated) {
    return (
      <WalletSourceContext.Provider value={PRIVY_SSR_STUB}>{children}</WalletSourceContext.Provider>
    );
  }

  return <PrivyWalletShellLazy appId={appId}>{children}</PrivyWalletShellLazy>;
}

/**
 * Sentinel Context used during SSR / first-paint in privy mode. Tells
 * pages "we're a privy build but the wallet machinery isn't online
 * yet" — the verify CTA stays disabled (`ready: false`) and any
 * unexpected `connectWallet()` call rejects loudly so the consumer
 * can react instead of silently hanging.
 */
const PRIVY_SSR_STUB: WalletSourceContextValue = {
  source: null,
  ready: false,
  mode: 'privy',
  connectWallet: () => Promise.reject(new Error('Privy SDK is still loading')),
  disconnectWallet: () => Promise.resolve(),
};

/* -------------------------------------------------------------------------- */
/*  Dev mode                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Local-development fallback. Reads / generates the dev keypair from
 * localStorage and publishes it through the same Context shape. No
 * Privy provider is mounted, so the dev bundle stays heavy-dep-free.
 */
function DevWalletProvider({ children }: { children: ReactNode }) {
  // Two-phase mount, mirroring `PrivyModeGate`. The dev keypair lives
  // in localStorage, which is unavailable during SSR. Creating it
  // eagerly (e.g. in `useMemo`) makes the FIRST client render diverge
  // from the server HTML — `ready: false` on the server vs `ready:
  // true` on the client — which trips React's hydration check on the
  // verify CTA's `disabled` attribute. Instead we publish `source:
  // null` for SSR + first paint, then create the keypair in an effect
  // so the state update (and the CTA enabling) lands after hydration.
  const [source, setSource] = useState<WalletSource | null>(null);
  useEffect(() => {
    setSource(devKeypairAsWalletSource(getOrCreateDevKeypair()));
  }, []);

  const connectWallet = useCallback(async (): Promise<WalletSource> => {
    // The keypair is synchronous to create. If the user clicks before
    // the mount effect has run, build it on demand so the CTA never
    // dead-ends instead of throwing.
    return source ?? devKeypairAsWalletSource(getOrCreateDevKeypair());
  }, [source]);

  const disconnectWallet = useCallback(async (): Promise<void> => {
    // Dev mode has no real session to tear down. We deliberately
    // DON'T rotate the keypair here — local dev expects a stable
    // wallet across tab reloads. Use `rotateDevKeypair()` directly
    // if you need to reset.
  }, []);

  const value = useMemo<WalletSourceContextValue>(
    () => ({
      source,
      ready: source !== null,
      mode: 'dev',
      connectWallet,
      disconnectWallet,
    }),
    [source, connectWallet, disconnectWallet],
  );

  return <WalletSourceContext.Provider value={value}>{children}</WalletSourceContext.Provider>;
}
