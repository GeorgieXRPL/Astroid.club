'use client';

/**
 * Privy implementation of the {@link WalletSource} contract.
 *
 * This file is loaded LAZILY (`next/dynamic`, `ssr: false`) by
 * `wallet-source-providers.tsx`, and only when the build is in privy
 * mode (`NEXT_PUBLIC_PRIVY_APP_ID` set).
 *
 * The lazy-load matters for two reasons:
 *
 *   1. **Dev mode keeps a small bundle.** When no Privy app id is
 *      configured the Privy SDK is never even fetched at runtime.
 *      Local dev iteration stays snappy and the shell starts in
 *      seconds.
 *   2. **SSR stays simple.** Privy's package transitively imports
 *      a handful of optional Solana peer packages (`@solana/kit`,
 *      `@solana-program/memo`, ...). Those are intended for embedded
 *      wallet transaction signing — code paths we never exercise.
 *      But Webpack and the Node runtime will still try to resolve
 *      them statically. Loading this module only on the client
 *      sidesteps the whole SSR resolution dance.
 *
 * The exported component publishes its `WalletSource` to the shared
 * Context defined in `./wallet-source-context`. That keeps the
 * consumer hook (`useWalletSource()`) location-stable: pages don't
 * care which provider is mounted above them.
 */

import { PrivyProvider, useLogin, useLogout, usePrivy } from '@privy-io/react-auth';
import {
  toSolanaWalletConnectors,
  useSignAndSendTransaction,
  useSignMessage,
  useSignTransaction,
  useWallets as useSolanaWallets,
  type ConnectedStandardSolanaWallet,
} from '@privy-io/react-auth/solana';
import bs58 from 'bs58';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';

import { WalletSourceContext, type WalletSourceContextValue } from './wallet-source-context';
import type { SignableTransaction, WalletSource } from './wallet-source';

/**
 * Which Solana cluster the external wallet should submit staking
 * transactions to. External wallets (Phantom/Solflare/...) use their
 * own RPC for the chosen chain, so this only has to name the cluster.
 * Defaults to devnet for safe pre-launch testing.
 */
const SOLANA_CHAIN = (process.env.NEXT_PUBLIC_SOLANA_CHAIN ??
  'solana:devnet') as `solana:${string}`;

interface PrivyWalletShellProps {
  appId: string;
  children: ReactNode;
}

/**
 * Silence one specific React dev-mode warning that the Privy SDK
 * triggers internally:
 *
 *   "Each child in a list should have a unique \"key\" prop. Check
 *    the render method of `Fragment`."
 *
 * The Fragment in question is inside Privy's bundled `react-auth`
 * package; we have no source-level fix without forking the SDK. The
 * warning is emitted only by React in development and has no runtime
 * impact (rendering is correct, reconciliation is correct), but it
 * pollutes the console for every `PrivyProvider` mount.
 *
 * The filter is intentionally narrow: it matches React's exact
 * format string, not any free-form text. If Privy ships a fix the
 * warning vanishes naturally; if React changes its wording the
 * filter no-ops and the warning becomes visible again, which is the
 * desired behaviour for any future incarnations.
 */
function suppressPrivyKeyWarning(): void {
  if (typeof window === 'undefined') return;
  const w = window as typeof window & { __privyKeyWarningPatched?: boolean };
  if (w.__privyKeyWarningPatched) return;
  w.__privyKeyWarningPatched = true;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (
      typeof first === 'string' &&
      first.includes('Each child in a list should have a unique "key" prop') &&
      first.includes('Fragment')
    ) {
      return;
    }
    original(...args);
  };
}

/**
 * Mount Privy with the locked-down "external Solana wallets only"
 * config, then publish the active wallet through Context.
 */
/**
 * Privy locked-down to Solana-only at every layer the SDK exposes:
 *
 *  1. `appearance.walletChainType: 'solana-only'`
 *     Filters the wallet picker to Solana-compatible wallets only.
 *
 *  2. `appearance.walletList: [...curated Solana wallets...]`
 *     Without this, Privy falls back to the WalletConnect registry on
 *     mobile and surfaces every wallet that has ever announced Solana
 *     support (1inch, AB Pay, Alicebob, dozens of others). The curated
 *     list pins the modal to the four big-name Solana wallets plus an
 *     escape hatch for desktop browser-extension auto-detect and a
 *     Solana-flavoured WalletConnect QR for everything else.
 *
 *  3. `loginMethods: ['wallet']`
 *     Removes every non-wallet login surface: no email, SMS, Google,
 *     Apple, Twitter, Discord, Farcaster, passkey, etc.
 *
 *  4. `externalWallets.solana.connectors` (only Solana adapters)
 *     We supply Solana standard-wallet connectors and nothing else;
 *     there is no `externalWallets.ethereum` field configured.
 *
 *  5. `embeddedWallets.{solana,ethereum}.createOnLogin: 'off'`
 *     Privy never custodies a wallet for the user.
 *
 * IMPORTANT: Privy also reads from the *dashboard* settings at
 * https://dashboard.privy.io for the configured app id. The dashboard
 * is allowed to widen what the SDK config narrows. The dashboard's
 * "Login methods" and "Supported chains" toggles should also be set
 * to wallet-only / Solana-only as a defense in depth.
 */
const SOLANA_WALLET_LIST = [
  // The four wallets the vast majority of $ASTROID holders will be
  // on, ordered by current Solana market share. Jupiter Wallet is
  // included because Jupiter's mobile app has an in-app browser that
  // routes its users back here; without the explicit entry the modal
  // wouldn't surface a deep-link option for them.
  //
  // Detected browser extensions get appended automatically (no-op on
  // mobile, useful on desktop) — anything else with a Solana standard
  // wallet adapter installed gets picked up there.
  'phantom',
  'solflare',
  'backpack',
  'jupiter',
  'detected_solana_wallets',
  // Solana-flavoured WalletConnect for everything else. This is QR-only
  // on desktop and is silently skipped on mobile, where the curated
  // wallets already cover deep-link sign-in.
  'wallet_connect_qr_solana',
] as const;

export function PrivyWalletShell({ appId, children }: PrivyWalletShellProps) {
  suppressPrivyKeyWarning();
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          walletChainType: 'solana-only',
          walletList: [...SOLANA_WALLET_LIST],
          showWalletLoginFirst: true,
          theme: 'dark',
          accentColor: '#00d4ff',
          logo: '/icon.svg',
        },
        loginMethods: ['wallet'],
        externalWallets: {
          solana: {
            // shouldAutoConnect=false avoids extension popups on
            // every cold page load. The modal only opens when the
            // user clicks "Verify".
            connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
          },
          // Deliberately no `ethereum` key. Omitting it means Privy
          // does not register any EVM connectors for this app, so
          // even if `walletChainType` were widened in a future tweak
          // there would still be no MetaMask / Coinbase / Rainbow
          // entry to surface in the modal.
        },
        embeddedWallets: {
          solana: { createOnLogin: 'off' },
          ethereum: { createOnLogin: 'off' },
        },
      }}
    >
      <PrivyWalletSourcePublisher>{children}</PrivyWalletSourcePublisher>
    </PrivyProvider>
  );
}

function PrivyWalletSourcePublisher({ children }: { children: ReactNode }) {
  const { ready: privyReady, authenticated } = usePrivy();
  const { ready: walletsReady, wallets } = useSolanaWallets();
  const { signMessage } = useSignMessage();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { signTransaction } = useSignTransaction();
  const { logout } = useLogout();

  // Resolver for an outstanding `connectWallet()` call that's
  // waiting on the user to pick a wallet. Held in a ref so the
  // promise can be settled by the next render's `source` value
  // without re-creating it on every render.
  const pendingResolve = useRef<((src: WalletSource) => void) | null>(null);
  const pendingReject = useRef<((err: Error) => void) | null>(null);

  const { login } = useLogin({
    onError: (err) => {
      pendingReject.current?.(new Error(typeof err === 'string' ? err : 'Privy login failed'));
      pendingResolve.current = null;
      pendingReject.current = null;
    },
  });

  // Use the first connected Solana wallet. Privy's `useWallets()`
  // returns connected EOAs in order; we treat index 0 as the active
  // wallet. The user can switch via Privy's modal — when they do,
  // `wallets[0]` updates and `source` is re-derived.
  const wallet: ConnectedStandardSolanaWallet | null = useMemo(() => {
    if (!authenticated) return null;
    return wallets[0] ?? null;
  }, [authenticated, wallets]);

  const source: WalletSource | null = useMemo(() => {
    if (!wallet) return null;
    return {
      publicKey: wallet.address,
      signMessage: async (msg: string) => {
        const messageBytes = new TextEncoder().encode(msg);
        const out = await signMessage({ message: messageBytes, wallet });
        return bytesToBase64(out.signature);
      },
      signAndSendTransaction: async (tx: SignableTransaction) => {
        // The gateway built and serialized the tx; Privy's external
        // wallet path takes the raw bytes and submits to the wallet's
        // RPC for SOLANA_CHAIN. Returns a base58 signature.
        const out = await signAndSendTransaction({
          transaction: base64ToBytes(tx.transaction),
          wallet,
          chain: SOLANA_CHAIN,
        });
        return bs58.encode(out.signature);
      },
      signTransaction: async (tx: SignableTransaction) => {
        // Sign WITHOUT broadcasting (used by the atomic redeem swap). The
        // wallet signs the clean tx; the gateway co-signs the treasury leg
        // and submits. Returns the base64-serialized signed transaction.
        const out = await signTransaction({
          transaction: base64ToBytes(tx.transaction),
          wallet,
          chain: SOLANA_CHAIN,
        });
        return bytesToBase64(out.signedTransaction);
      },
    };
  }, [wallet, signMessage, signAndSendTransaction, signTransaction]);

  // Resolve any pending `connectWallet()` once a source is available.
  useEffect(() => {
    if (source && pendingResolve.current) {
      pendingResolve.current(source);
      pendingResolve.current = null;
      pendingReject.current = null;
    }
  }, [source]);

  const connectWallet = useCallback(async (): Promise<WalletSource> => {
    if (source) return source;

    // Stale-session recovery: Privy persists `authenticated` in
    // localStorage across reloads, but the actual external wallet
    // connection (Phantom etc.) is per-tab and per-session. After a
    // browser refresh, server restart, or extension disconnect the
    // user can land here as `authenticated: true` with `wallets: []`.
    // Calling `login()` in that state is rejected by Privy with
    // "Attempted to log in, but user is already logged in".
    //
    // The dumb-but-reliable fix is to clear the Privy session first.
    // The next `login()` then runs the full flow including the wallet
    // picker, which is what the user expected to see anyway.
    if (authenticated && !wallet) {
      try {
        await logout();
      } catch {
        // Logout failures are non-fatal here — proceed to login()
        // and let Privy surface any underlying issue through onError.
      }
    }

    return new Promise<WalletSource>((resolve, reject) => {
      pendingResolve.current = resolve;
      pendingReject.current = reject;
      login();
    });
  }, [source, authenticated, wallet, logout, login]);

  const disconnectWallet = useCallback(async () => {
    await logout();
  }, [logout]);

  const value = useMemo<WalletSourceContextValue>(
    () => ({
      source,
      ready: privyReady && walletsReady,
      mode: 'privy',
      connectWallet,
      disconnectWallet,
    }),
    [source, privyReady, walletsReady, connectWallet, disconnectWallet],
  );

  return <WalletSourceContext.Provider value={value}>{children}</WalletSourceContext.Provider>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
