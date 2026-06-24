/**
 * Build-time feature flags. `NEXT_PUBLIC_*` values are inlined by Next at
 * build time, so these are constants for a given deployment.
 *
 * ARENA_OPEN gates public entry into the game. It defaults OFF so the
 * apex (astroid.club) shows only the coming-soon landing until Privy
 * production sign-in and on-chain holder reads are wired up.
 *
 * When OFF:
 *   - the landing renders the coming-soon teaser with no "enter" CTA, and
 *   - the header nav hides the in-game links.
 * The `/arena` route itself stays reachable by direct URL and remains
 * gated by Privy + the server-side wallet allowlist, so allowlisted
 * wallets can still test before the public doors open.
 *
 * Flip on by setting `NEXT_PUBLIC_ARENA_OPEN=true` in the deployment env.
 */
export const ARENA_OPEN = process.env.NEXT_PUBLIC_ARENA_OPEN === 'true';
