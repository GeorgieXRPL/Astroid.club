# astroid.club

The utility hub for `$ASTROID` holders. PvP / PvE asteroid-mining arena, poker freerolls, and free collectibles. Built on the [`game-engine-enhanced`](../game-engine-enhanced) engine and a battle-tested raid economy ported from `Black-Gold-main`.

> **Status: Private. Not licensed for redistribution.** Part of the Saltaire Protocol stack.

---

## What this is

This repository implements `astroid.club` — the product surface that sits beside `astroid.space` (the token). Per the architecture decision in [`../astroid-proposal/VC_PROPOSAL.md`](../astroid-proposal/VC_PROPOSAL.md):

- `astroid.space` hosts only the token. No promised utility, yield, or services.
- `astroid.club` (this repo) hosts every product surface: free NFT mints, the PvP/PvE arena, poker freerolls, and hold-time benefits.

The split is the load-bearing decision. See [`../astroid-proposal/LEGAL_SUMMARY.md`](../astroid-proposal/LEGAL_SUMMARY.md) for the regulatory rationale.

---

## What's built

| Slice                     | Status     | Coverage                                                                   |
| ------------------------- | ---------- | -------------------------------------------------------------------------- |
| Game economy port         | ✅ Landed  | 12 modules ported from BG (asteroid registry, raids, expeditions, etc.)    |
| Anti-cheat                | ✅ Landed  | Rate limits, sybil detection, per-IP connection caps                       |
| Server entrypoint         | ✅ Landed  | `WSGateway` + `WalletVerifier` + zod protocol + HTTP health probe          |
| `CHAIN_ENABLED` switch    | ✅ Landed  | Three-layer kill switch (env flag → orchestrator gate → `ChainOps` facade) |
| Holder verification       | ✅ Landed  | Read-only Helius/RPC reads + flash-loan mitigation tracker                 |
| `verify_holder` wire path | ✅ Landed  | Binary eligibility envelope post-auth; landing gate consumes it            |
| Test parity               | ✅ Landed  | 597 tests (game formulas, simulations, gateway, chain ops, holder)         |
| Next.js shell             | ✅ Landed  | Landing / sign-in / arena / console with holder-gated club view            |
| 3D arena                  | ✅ Landed  | 20 asteroids · 4 sectors · ~1500 instanced background belt · ACES + bloom  |
| Privy wallet sign-in      | ✅ Landed  | External Solana wallets only; dev-keypair fallback when app id is unset    |
| Yield SPL transfer        | ⏳ Pending | `executeYieldPayout` impl behind `ChainOps` (`chain_yield_sink` slice)     |
| Bet escrow on-chain       | ⏳ Pending | `buildBetEscrowDeposit` / `verifyBetEscrowDeposit` (`chain_bet_escrow`)    |
| Buyback                   | ⏳ Pending | `executeBuyback` (`chain_buyback` slice)                                   |

See [`docs/PORTING_NOTES.md`](docs/PORTING_NOTES.md) for the running log of every file ported, with rationale and divergences. See [`docs/CHAIN_AUDIT.md`](docs/CHAIN_AUDIT.md) for the operator-facing audit of every chain side effect and which gating layer protects it.

---

## Heritage

The economy is a port of the `Black-Gold` raid system, rethemed for an asteroid-mining setting. The math, anti-cheat, holder verification, and escrow patterns are battle-tested in production at `../Black-Gold-main`. We ported the **logic**, renamed the **domain entities** to a galaxy theme, and gated the **on-chain side effects** behind a feature flag so the platform can run as a free pre-launch utility while counsel reviews the structure.

The theme transformation is documented in [`docs/GLOSSARY.md`](docs/GLOSSARY.md). Read that before touching code so the renames make sense.

---

## Layout

```
astroid-club/
  package.json         # private workspace root
  tsconfig.json        # strict TS, ESM
  eslint.config.mjs    # mirrors engine's flat config
  .env.example         # CHAIN_ENABLED=false by default

  server/
    config/
      runtime.ts          # one-shot env parse; chainEnabled, RPC, mint, ports
    game/
      types.ts            # STAKE_TIERS, formulas (calculateAttackPower, …)
      world.ts            # GameWorld composition root (12 modules)
      asteroid-registry.ts
      stake-manager.ts
      cooldowns.ts
      expedition-tracker.ts
      raid-engine.ts
      bet-escrow.ts
      refinery-manager.ts
      distribution-service.ts
      yield-orchestrator.ts
      syndicate-manager.ts
      syndicate-raids.ts
      interfaces.ts       # narrow DI interfaces (no module-level singletons)
    verification/
      anti-cheat.ts       # per-wallet rate limits, sybil detection
      holder-tracker.ts   # in-memory flash-loan-mitigation eligibility brain
    chain/
      index.ts            # ChainOps facade (single chokepoint for all chain ops)
      holder.ts           # SolanaBalanceReader + HolderChainAdapter (read-only)
    net/
      protocol.ts         # zod-validated wire protocol (extends engine's)
      gateway.ts          # mounts GameWorld behind engine's WSGateway
    index.ts              # entrypoint; HTTP health, gateway start, graceful shutdown

  config/
    asteroids.ts          # AsteroidDefinition shape; resource taxonomy

  tests/                  # 590 tests across 19 files
    game/                 # per-module unit tests + scenarios.test.ts (BG-parity)
    verification/         # anti-cheat + holder-tracker
    chain/                # ChainOps facade + holder adapter
    net/                  # protocol + gateway integration

  docs/
    GLOSSARY.md           # canonical theme transformation table
    ARCHITECTURE.md       # as-built architecture
    GAME_DESIGN.md        # player-facing mechanics reference
    PORTING_NOTES.md      # running log of files ported from BG
    CHAIN_AUDIT.md        # operator-facing chain-effect audit

  shell/                  # Next.js 15 shell — landing (holder gate), sign-in,
                          #   arena (3D), and the test console. Privy + dev
                          #   keypair wallet sources both supported.
  arena/                  # Vite scaffold reserved for the standalone arena
                          #   build; the shell currently embeds the 3D arena
                          #   directly via dynamic import.
```

---

## Quick start

> **Prereq:** the engine must be built once. From the workspace root:
>
> ```bash
> cd ../game-engine-enhanced && npm install && npm run build:lib
> cd ../astroid-club
> ```

```bash
# install (root + workspaces)
npm install

# typecheck + lint + tests (server)
npm run typecheck
npm run lint
npm test               # 597 server tests across 20 files

# run the gateway (HTTP + WS on PORT, default 3002)
npm run dev:server

# run the Next.js shell (landing, sign-in, arena, console) on :3000
npm run dev:shell

# health probe
curl http://localhost:3002/health
```

The shell respects `NEXT_PUBLIC_PRIVY_APP_ID` (Privy mode) vs unset (dev-keypair mode). Both modes drive the same auth handshake against the gateway. See `.env.example` for the full set of vars.

---

## Chain posture

`CHAIN_ENABLED=false` by default. With the flag off:

- Game logic executes normally — raids resolve, asteroids accumulate yield, leaderboards update.
- All on-chain side effects (escrow deposits, reward transfers, buybacks, holder reads) become no-ops returning a `disabled` sentinel via the `ChainOps` facade. See [`docs/CHAIN_AUDIT.md`](docs/CHAIN_AUDIT.md).
- Holder verification short-circuits at the facade layer — no RPC traffic, no balance reads.

When counsel signs off on the structure, flip `CHAIN_ENABLED=true` per environment to wire the transfers live. The flag is enforced in three independent layers (env flag → orchestrator gate → `ChainOps` facade); flipping it is the only code-free change required.

---

## Source repos this depends on

| Repo                                                 | Role                                                            | License                                      |
| ---------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| [`../game-engine-enhanced`](../game-engine-enhanced) | Engine, ECS, renderer, ws gateway, zod protocol, Solana adapter | MIT                                          |
| [`../Black-Gold-main`](../Black-Gold-main)           | Reference for ported game-economy logic                         | Read-only — we port from it, never modify it |

---

## Branding

Built and maintained by [@HeartOfMidgar](https://x.com/HeartOfMidgar) as part of the **Saltaire Protocol** stack.

This is not the engine. This is the product. The engine is open-source MIT; this product is private. Keep them separate when committing, deploying, or sharing artifacts.
