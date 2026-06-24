# CHAIN_ENABLED Audit

This document is the operator's reference for the `CHAIN_ENABLED`
kill switch in `astroid.club`. It enumerates every potential
on-chain side effect, names the layers that gate it, and tells you
how to verify that flipping the flag actually disables the chain.

**Default posture:** `CHAIN_ENABLED=false`. Every code path that
would otherwise touch Solana RPC, broadcast a transaction, or move
tokens is a no-op. The game runs fully in memory.

**Production posture:** `CHAIN_ENABLED=true` requires every chain
op the operator's deployment uses to have a wired implementation.
Unwired ops throw at the call site by design. Loss of funds is
worse than a crash.

## Threat model

The audit assumes a hostile operator scenario: a future commit
adds a new module, imports `@solana/web3.js` directly, and calls
`sendTransaction(...)`. We want at least one of the layers below
to refuse the operation when the kill switch is off.

## The three gating layers

```
         ┌─────────────────────────────────────────────┐
         │ Layer 1: runtime.chainEnabled (env flag)    │
         │   - one bit; flips the platform             │
         └────────────────────┬────────────────────────┘
                              │
         ┌────────────────────▼────────────────────────┐
         │ Layer 2: orchestrator gates                 │
         │   - DistributionService.chainEnabled        │
         │   - YieldOrchestrator.chainEnabled          │
         │   - never invoke onYieldPayout when off     │
         │   - route to addPendingYield instead        │
         └────────────────────┬────────────────────────┘
                              │
         ┌────────────────────▼────────────────────────┐
         │ Layer 3: ChainOps facade                    │
         │   - server/chain/index.ts                   │
         │   - every chain op re-asserts chainEnabled  │
         │   - returns disabled sentinel when off      │
         │   - all SDK code lives in submodules of     │
         │     server/chain/* (deferred slices)        │
         └─────────────────────────────────────────────┘
```

## Surface inventory

The complete chain surface astroid.club exposes (or will expose)
is listed below. Each row names its current implementation status,
which slice will land the SDK code, and which gating layers
currently protect it.

| Op                       | Purpose                                  | Layer 1 | Layer 2 | Layer 3 | Impl status                         |
| ------------------------ | ---------------------------------------- | ------- | ------- | ------- | ----------------------------------- |
| `executeYieldPayout`     | Pay distributed yield to a wallet        | ✅      | ✅      | ✅      | landed (slice: `chain_yield_sink`)  |
| `buildBetEscrowDeposit`  | Build a bet-deposit tx (client signs)    | ✅      | n/a     | ✅      | stub (slice: `chain_bet_escrow`)    |
| `verifyBetEscrowDeposit` | Verify a signed bet-deposit tx           | ✅      | n/a     | ✅      | stub (slice: `chain_bet_escrow`)    |
| `executeBuyback`         | SOL → $ASTROID swap (deflationary)       | ✅      | n/a     | ✅      | stub (slice: `chain_buyback`)       |
| `getHolderBalance`       | Read $ASTROID balance from chain         | ✅      | n/a     | ✅      | **landed** (`holder_verification`)  |
| `verifyHolderQualified`  | Continuous-hold check (flash-loan guard) | ✅      | n/a     | ✅      | **landed** (`holder_verification`)  |
| `OnChainHoldEstimator`   | Pre-warm hold time from transfer history | ✅      | n/a     | ✅      | **landed** (`holder_prewarm`)       |
| `buildStakeTx`           | Build an unsigned $ASTROID stake tx      | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |
| `buildUnstakeTx`         | Build an unsigned unstake tx             | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |
| `buildClaimTx`           | Build an unsigned IOU-reward claim tx    | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |
| `buildRedeemTx`          | Build an unsigned IOU→$ASTROID redeem tx | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |
| `verifyStakeTx`          | Verify a submitted stake tx on-chain     | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |
| `getStakeInfo`           | Read on-chain stake position + rewards   | ✅      | n/a     | ✅      | **landed** (`chain_quarry_staking`) |

**`holder_verification`** landed `server/chain/holder.ts`
(`SolanaBalanceReader` + `HolderChainAdapter`) and
`server/verification/holder-tracker.ts` (pure in-memory eligibility
state with flash-loan mitigation). The boot fn constructs both
when `chainEnabled === true` and supplies them as
`ChainOps.impls.getHolderBalance` / `verifyHolderQualified`. With
chain off, the adapter is not constructed at all and `ChainOps`
returns the `disabled` sentinel.

**`chain_quarry_staking`** landed `server/chain/staking.ts`
(`QuarryStakingAdapter`), a non-custodial port of Black-Gold's Quarry
staking. It holds **no key material**: every `build*Tx` op returns an
_unsigned_ base64 transaction for the wallet to sign and submit; the
client then calls `verify_stake_tx` so the gateway confirms the stake
on-chain. The adapter handles the decimal split between $ASTROID
(6 dec) and IOU-ASTROID (9 dec). The boot fn constructs it only when
`chainEnabled === true` **and** the Quarry addresses are present
(`getQuarryConfigFromEnv()` in `server/index.ts`); otherwise the ops
stay unwired and throw at the call site. The frontend flow lives in
`shell/lib/staking-client.ts` (build → `WalletSource.signAndSendTransaction`
→ verify), surfaced in the console's "On-chain staking" panel. The full
lifecycle (stake → accrue IOU → claim → unstake → redeem) is proven
against localnet by `scripts/localnet/e2e-staking.ts` — see
`docs/LOCALNET_STAKING.md`.

**`chain_yield_sink`** landed `server/chain/rewards.ts`
(`RewardPayoutAdapter`), a port of Black-Gold's reward-pool design and
the implementation behind `executeYieldPayout`. This is the **only
custodial** chain op: discovery rewards are signed server-side by a hot
**reward-pool wallet** loaded from `REWARD_WALLET_PRIVATE_KEY` (read once,
held in-memory, never logged; parse errors are generic). When the
`DistributionService` resolves a per-asteroid discovery reward and chain
is on, the adapter transfers that amount of **$ASTROID** (base token, 6
dec) from the pool to the player, creating the recipient ATA if needed
and attaching a priority fee. The boot fn wires it only when
`chainEnabled === true` **and** `getRewardConfigFromEnv()` finds the
reward wallet; otherwise yield is credited in-game (`addPendingYield`)
only. Operate the reward wallet as a hot wallet: fund it with only what
you'll expose and top it up from treasury/buyback out of band. Proven
against localnet by `scripts/localnet/e2e-yield-payout.ts`.

**Layer 1 (env flag).** All ops above gate on `runtime.chainEnabled`.
Layer 1 is verified by the runtime's `requireEnv` (in
`server/config/runtime.ts`) which throws at boot if `CHAIN_ENABLED=true`
but `SOLANA_RPC_URL` or `ASTROID_MINT_ADDRESS` is unset.

**Layer 2 (orchestrator).** Only `executeYieldPayout` flows through
an orchestrator (the `DistributionService` and `YieldOrchestrator`
both check `chainEnabled` before invoking the registered callback).
Other ops are call-sited from gateway message handlers; their layer-2
gate is the gateway's own conditional dispatch (which lands with each
op's implementation slice).

**Layer 3 (facade).** Every op listed has an entry point on
`ChainOps` (`server/chain/index.ts`). Each entry point opens with
`if (!this.chainEnabled) return disabled('opName')`. There is no
code path through `ChainOps` that reaches an SDK call when the
flag is off.

## Current chain footprint

`@solana/web3.js` imports in `astroid.club/server` are restricted to:

- The engine's `WalletVerifier` (signature verification — `tweetnacl`,
  `bs58`, and `PublicKey` for base58 decoding only; no RPC).
- `server/chain/holder.ts` (`SolanaBalanceReader` —
  `getParsedTokenAccountsByOwner` for read-only SPL balance lookup;
  no `sendTransaction`, no signing).

Neither file moves funds. There are zero direct imports of
`@solana/spl-token`, zero `sendTransaction` calls, and zero
keypair-holding code paths. Every chain-touching operation reachable
from a request handler must go through `ChainOps`, which gates on
`runtime.chainEnabled`.

**Verification:**

```bash
rg --type ts "from '@solana" server/ --files-with-matches
# Expected output: only files under server/chain/. The engine's
# WalletVerifier sits in node_modules, not server/, so it doesn't
# show up here.
```

## Verification

### 1. Static check (CI)

```bash
# All chain SDK imports must live under server/chain/.
rg --type ts "from '@solana" server/ --files-with-matches | \
  rg -v '^server/chain/'   # must return nothing
```

This is currently passing because the SDK isn't imported anywhere
yet. As implementation slices land they MUST place their imports
under `server/chain/<op>.ts`. A future ESLint rule will enforce
this automatically.

### 2. Test suite

`tests/chain/ops.test.ts` (32 tests) verifies:

- Every `ChainOps` method returns `{ ok: false, disabled: true }`
  when `chainEnabled === false`.
- A supplied impl is **ignored** when the flag is off (the flag
  wins).
- The `toYieldPayoutListener` adapter is a no-op when off and
  emits a warning if invoked.
- Every method throws `ChainOpNotImplementedError` when on but no
  impl is wired (the boot fn is responsible for refusing to start
  when this happens for ops it needs).
- Construction throws `ChainMisconfiguredError` when on but
  `rpcUrl` or `astroidMint` is missing (defense in depth on top of
  `runtime.ts`'s `requireEnv`).

### 3. Runtime smoke

With `CHAIN_ENABLED` unset (or `=false`):

```bash
PORT=3002 npm run dev:server
# health check should report `chainEnabled: false`
curl -s http://localhost:3002/health | jq
```

A wallet that connects, stakes, and triggers a discovery payout
will see yield routed to `addPendingYield` and bankable via the
`claim_yield` message — no RPC traffic, no signed transactions.

## Adding new chain code

If you need to add a new on-chain side effect:

1. Add a method to `ChainOpsImplementations` in
   `server/chain/index.ts`. Default it to throwing
   `ChainOpNotImplementedError(<op>, <slice>)`.
2. Land the SDK implementation in `server/chain/<op>.ts`. Import
   `@solana/*` only there.
3. Wire it in `server/index.ts` by passing the impl into
   `new ChainOps({ runtime, impls: { <op>: ... } })`.
4. Add a test row in `tests/chain/ops.test.ts` for the
   `chainEnabled=true` happy path.
5. Update this doc's surface inventory.

Operators who want to roll back chain side effects must only flip
`CHAIN_ENABLED=false`; no code changes, no redeploy of game logic.

## Going live with the holder gate

The `verify_holder` slice is the only ChainOps consumer that ships with a
working impl today (`HolderChainAdapter`). Flipping the switch on for
holder reads is therefore a self-contained promotion — yield-payout, bet
escrow, and buyback impls are still pending and will refuse to start
under `CHAIN_ENABLED=true` only if the boot fn tries to invoke them.
The gateway boot fn currently only wires `getHolderBalance` /
`verifyHolderQualified`, so chain-on is safe.

### 1. Set the env

In your deployment target's `.env` (or platform secret store):

```bash
CHAIN_ENABLED=true

# Helius RPC URLs are recommended; the reader auto-detects devnet by
# whether the URL contains "devnet".
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<KEY>

# Optional but preferred — when set the reader uses Helius DAS REST
# (faster, indexed) before falling back to plain JSON-RPC.
HELIUS_API_KEY=<KEY>

# Required when CHAIN_ENABLED=true. Boot will refuse to start without it.
ASTROID_MINT_ADDRESS=<mint pubkey>
ASTROID_DECIMALS=9

# Tune the gate. Defaults match the BG production posture.
HOLDER_MIN_BALANCE=1
HOLDER_MIN_HOLD_SECONDS=600

# Pre-warm the hold-time tracker from on-chain transfer history (recommended).
# Defaults true; silently disables itself if HELIUS_API_KEY is unset because
# the JSON-RPC path lacks ergonomic per-mint transfer history.
HOLDER_PREWARM_ENABLED=true
HOLDER_PREWARM_MAX_LOOKBACK=100
```

#### Production-safe values (rule of thumb)

The defaults above match Black-Gold's production posture. For a pump.fun-style
launch with a public token, a defensible starting point is:

| Knob                          | Suggestion      | Why                                                            |
| ----------------------------- | --------------- | -------------------------------------------------------------- |
| `HOLDER_MIN_BALANCE`          | small holding   | pick a number with meaningful USD value at your launch price   |
| `HOLDER_MIN_HOLD_SECONDS`     | `86400` (1 day) | flash-loan attack windows are typically <1 hour                |
| `HOLDER_PREWARM_ENABLED`      | `true`          | otherwise legitimate holders pay the full wait on first verify |
| `HOLDER_PREWARM_MAX_LOOKBACK` | `100`           | covers ~1 month of typical holder activity in one Helius page  |

The flash-loan guard's underlying defense is the in-memory tracker — pre-warm
only seeds the _first_ observation. Threshold dips still wipe tracking, so an
attacker who borrows tokens and immediately verifies pays the full
`HOLDER_MIN_HOLD_SECONDS` cooldown anyway.

The boot fn fail-loud refuses to start if `CHAIN_ENABLED=true` but
`SOLANA_RPC_URL` or `ASTROID_MINT_ADDRESS` is missing. That's intentional:
silently falling back to off-chain holder checks would be a privacy leak
(the gate would always pass) — better to crash on boot than ship a
permissive holder gate.

### 2. Boot and confirm posture

```bash
npm run dev:server
curl -s http://localhost:3002/health | jq
# expect: { "ok": true, "chainEnabled": true, ... }
```

If `chainEnabled: true` doesn't appear, the env wasn't picked up — check
that you exported it (or that your `.env.local` is being loaded).

### 3. Smoke the holder gate end-to-end

`scripts/smoke-verify-holder.mjs` runs the full `request_nonce → auth →
verify_holder` handshake against a live server with a freshly generated
keypair (which by definition holds zero $ASTROID):

```bash
node scripts/smoke-verify-holder.mjs
# expect (chain on, fresh kp): { eligible: false, reason: 'not_qualified', ... }
# expect (chain off):          { eligible: true,  reason: 'chain_disabled', ... }
```

A `not_qualified` result on a fresh keypair when chain is on is the
green light: the gate is reaching Solana, reading a real balance (`0`),
and refusing access. Test with a wallet that holds ≥ `HOLDER_MIN_BALANCE`
$ASTROID through a `HOLDER_MIN_HOLD_SECONDS` window to see the
`qualified` path. The flash-loan tracker requires either a hold-time
crossing or two consecutive observations — both are documented in
`docs/GAME_DESIGN.md#9-holder-verification`.

#### What you'll see in the gateway log

The holder layer emits structured info-level log lines on every verify so
operators can triage "why did this wallet get the answer it got?":

```
[HolderTracker] new wallet tracked: <wallet>... balance=X threshold=T (first observation; flash-loan guard active)
[HolderTracker] pre-warmed <wallet>... holdStartMs=<ISO> (Ns of inferred on-chain hold time)
[HolderTracker] flash-loan guard: <wallet>... held Ns (k/N obs); Ms remaining
[HolderChain] <wallet>... not eligible: <reason> (balance=X required=T)
```

If you see `pre-warmed ... 30000s of inferred on-chain hold time` followed by
no flash-loan-guard line, the wallet qualified on first verify thanks to its
on-chain history. If you see `held 0s (1/5 obs)` instead, the pre-warm did
not produce a signal — usually because Helius didn't return enough recent
transfers, or the wallet acquired the tokens via a swap that didn't surface
as a `tokenTransfer` on its enriched-tx feed. Bumping
`HOLDER_PREWARM_MAX_LOOKBACK` to 100 is the first knob to try; falling back
to the regular consecutive-observations gate (5 clicks) is the user-visible
fallback.

### 4. Roll back if needed

```bash
CHAIN_ENABLED=false   # set, then restart the gateway
```

The shell auto-recovers — the landing page's holder state machine
treats `chain_disabled` as `eligible: true, reason: chain_disabled` and
shows the `chain_disabled` badge in the welcome banner.
