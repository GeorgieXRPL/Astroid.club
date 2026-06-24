# shell — astroid.club Next.js shell

The meta-UI surface for [astroid.club](https://astroid.club). Wallet onboarding, profile, leaderboards, admin console, SEO landing pages. The live game arena (Vite, three.js) mounts here in a follow-up slice.

This package is a workspace member of `@saltaire/astroid-club`. From the repo root, `npm install` installs everything.

---

## Run it

```bash
# from astroid-club/ root, in one terminal:
npm run dev:server      # starts the WS + HTTP server on :3002

# in another terminal:
npm run dev:shell       # starts the Next.js shell on :4001
```

Then open [http://localhost:4001](http://localhost:4001).

The shell talks to the server via `NEXT_PUBLIC_ASTROID_WS_URL` (default `ws://localhost:3002`).

---

## What's in this slice

This is **Phase 2 sub-slice 1**. The intent is the smallest demoable shell that exercises the server's auth handshake end-to-end. Specifically:

- **Landing page** (`/`) — branding, status table, links.
- **Sign-in page** (`/sign-in`) — generates a dev keypair in `localStorage` (or reuses an existing one), runs the `request_nonce → sign → auth` handshake against the server WS, displays the returned `ConnectSnapshot`.
- **No Privy yet.** Phase 2 sub-slice 2 swaps the dev keypair for Privy + a real Solana wallet adapter. Until then, the dev keypair is local-only and **must not** be used for real funds.
- **No arena yet.** Phase 2 sub-slice 3 lands `arena/` (Vite, three.js) and Phase 2 sub-slice 4 wires it to the same WS the shell uses for auth.

---

## Layout

```
shell/
├── app/                      # Next.js App Router
│   ├── globals.css           # Tailwind base + space gradient
│   ├── layout.tsx            # site-wide chrome (header, footer)
│   ├── page.tsx              # landing
│   └── sign-in/page.tsx      # client component; auth handshake demo
├── lib/
│   ├── dev-keypair.ts        # tweetnacl ed25519 generated client-side, persisted in localStorage
│   └── auth-client.ts        # WS auth handshake (request_nonce → sign → auth)
├── eslint.config.mjs         # next/core-web-vitals + next/typescript
├── next.config.mjs           # injects NEXT_PUBLIC_ASTROID_{WS,HTTP}_URL with sane defaults
├── package.json
├── postcss.config.mjs        # tailwind + autoprefixer
├── tailwind.config.ts        # custom space + flare + ore palette
└── tsconfig.json             # standard Next.js TS config
```

---

## Why dev-keypair-first

Privy needs an app ID, a configured Solana cluster, and an account on privy.io. Wiring it as the _first_ thing the shell does would block on out-of-repo configuration. Instead this slice ships a working auth handshake **today** with a local-only ed25519 keypair, then sub-slice 2 layers Privy on top of the same auth flow without touching the server.

The auth client (`lib/auth-client.ts`) is already deliberately structured so the keypair is injected — replacing the dev-keypair source with Privy's `signMessage` is a one-file change.

---

## Server contract

The shell's auth client matches the wire schemas in `server/net/protocol.ts` exactly:

- `request_nonce { walletAddress }` → `result { nonce, walletAddress, message, app, ttlMs }`
- `auth { walletAddress, nonce, signature }` → `result <ConnectSnapshot>` | `error { code, message }`

The `signature` is base64-encoded; the server's `WalletVerifier` decodes it. The signed `message` is canonical JSON `{ app, action: 'auth', nonce, timestamp: 0 }` — the `timestamp: 0` is intentional, working around the engine's mismatched `createSignatureMessage` / `verifySignedAction` timestamps. See `server/net/gateway.ts` and `docs/ARCHITECTURE.md`.
