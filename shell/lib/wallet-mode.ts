/**
 * Build-time wallet-mode toggle.
 *
 * Reads `NEXT_PUBLIC_PRIVY_APP_ID`. If present, the shell runs in
 * **privy mode** (PrivyProvider mounted, real external Solana
 * wallets). If absent, it runs in **dev mode** (localStorage dev
 * keypair stands in for a wallet — no Privy provider, no third-party
 * dependency at runtime).
 *
 * The constant is captured ONCE at module load. That's deliberate:
 *
 *   - Hook order in `useWalletSource()` is stable for any given
 *     build (privy or dev), so the rules-of-hooks invariant holds.
 *   - Production builds with `NEXT_PUBLIC_PRIVY_APP_ID` set never
 *     pull the dev keypair branch into the bundle — Next.js inlines
 *     the env var at build time and dead-code-eliminates the unused
 *     branch.
 *   - Local dev without a Privy app id keeps working unchanged. No
 *     refactor required to keep iterating on the gameplay surface
 *     while the Privy app is being provisioned.
 *
 * Safety: NEVER read `NEXT_PUBLIC_PRIVY_APP_ID` directly outside this
 * module. Always import `PRIVY_APP_ID` and `WALLET_MODE` from here.
 * That keeps the gating logic in one auditable place.
 */

const RAW = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export const PRIVY_APP_ID: string | null = typeof RAW === 'string' && RAW.length > 0 ? RAW : null;

export type WalletMode = 'privy' | 'dev';

export const WALLET_MODE: WalletMode = PRIVY_APP_ID ? 'privy' : 'dev';
