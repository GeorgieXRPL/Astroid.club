# Localnet Quarry staking

How to stand up the full on-chain staking stack on a local Solana
validator and prove the lifecycle end-to-end. This is the dev loop
behind the `chain_quarry_staking` slice (see `docs/CHAIN_AUDIT.md`).

The staking port is a non-custodial adaptation of Black-Gold's Quarry
integration: the gateway only ever **builds unsigned transactions**;
signing and submission happen client-side. No key material lives on
the server.

## Token model

| Token       | Decimals | Role                                               |
| ----------- | -------- | -------------------------------------------------- |
| $ASTROID    | 6        | the staked token                                   |
| IOU-ASTROID | 9        | reward token emitted by the Quarry, redeemable 1:1 |

The decimal mismatch (6 vs 9) is handled inside
`server/chain/staking.ts`; the localnet scripts mint $ASTROID at 6
decimals to match the intended mainnet token.

## Components

| Path                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `scripts/localnet/start-validator.sh` | Boots `solana-test-validator`, cloning the Quarry programs from mainnet |
| `scripts/localnet/bootstrap.sh`       | Funds wallets, mints a test $ASTROID, writes `.keys/localnet.env`       |
| `scripts/localnet/deploy-quarry.ts`   | Creates IOU mint, MintWrapper, Rewarder, and the $ASTROID Quarry pool   |
| `scripts/localnet/e2e-staking.ts`     | Drives stake → accrue → claim → unstake → redeem and asserts balances   |
| `server/chain/staking.ts`             | `QuarryStakingAdapter` — builds/verifies txs, reads stake info          |
| `shell/lib/staking-client.ts`         | Frontend orchestration: build → sign+submit → verify                    |

> The validator clones the canonical Saber Quarry program IDs
> (Mine / MintWrapper / Redeemer) from mainnet, so we run against real
> Quarry bytecode without building it from source.

## Run it

Each step assumes the Solana CLI tools are on `PATH`. The validator
uses non-default ports (gossip `8211`, dynamic `8210-8240`) to avoid
sandbox conflicts; RPC stays on `8899`.

```bash
# 1. Start the validator (foreground; leave it running).
scripts/localnet/start-validator.sh

# 2. In a second shell: fund wallets + mint test $ASTROID.
scripts/localnet/bootstrap.sh

# 3. Deploy the Quarry staking infrastructure.
npx tsx scripts/localnet/deploy-quarry.ts

# 4. Prove the full lifecycle.
npx tsx scripts/localnet/e2e-staking.ts
```

A passing run ends with:

```
✓ Quarry staking e2e PASSED — stake → accrue → claim → unstake → redeem all on-chain.
```

`deploy-quarry.ts` writes the deployed addresses back into
`.keys/localnet.env` (`QUARRY_REWARDER_ADDRESS`, `QUARRY_ADDRESS`,
`QUARRY_MINT_WRAPPER`, `IOU_TOKEN_MINT`). The `.keys/` directory is
gitignored — it holds keypairs and local env only.

## Wiring it into the gateway

`getQuarryConfigFromEnv()` (`server/chain/staking.ts`) reads:

| Env var                   | Notes                            |
| ------------------------- | -------------------------------- |
| `SOLANA_RPC_URL`          | localnet `http://127.0.0.1:8899` |
| `ASTROID_MINT_ADDRESS`    | the test $ASTROID mint           |
| `ASTROID_DECIMALS`        | `6`                              |
| `QUARRY_REWARDER_ADDRESS` | from `deploy-quarry.ts`          |
| `QUARRY_ADDRESS`          | from `deploy-quarry.ts`          |
| `QUARRY_MINT_WRAPPER`     | from `deploy-quarry.ts`          |
| `IOU_TOKEN_MINT`          | from `deploy-quarry.ts`          |
| `IOU_TOKEN_DECIMALS`      | `9`                              |
| `REDEEMER_WALLET_ADDRESS` | destination for redemptions      |

With `CHAIN_ENABLED=true` **and** these set, `server/index.ts` builds
a `QuarryStakingAdapter` and wires the six staking ops into `ChainOps`.
If the addresses are absent the ops stay unwired and the gateway
returns a `chain_disabled` reply — staking is off but the rest of the
game runs.

## Frontend flow

The browser half lives in `shell/lib/staking-client.ts` and the
console's "On-chain staking" panel (`shell/app/console/page.tsx`):

1. `Session.build*Tx` → gateway returns an unsigned base64 tx.
2. `WalletSource.signAndSendTransaction` signs + submits it:
   - **Privy** external wallets submit to their own RPC for
     `NEXT_PUBLIC_SOLANA_CHAIN`.
   - The **dev keypair** signs locally and submits via
     `NEXT_PUBLIC_SOLANA_RPC_URL` (set this to the localnet RPC to test
     staking without a browser extension; the dev wallet must hold SOL
     - $ASTROID on that RPC).
3. For a stake, `Session.verifyStakeTx` asks the gateway to confirm it
   on-chain.

Because the cloned Quarry programs and a funded $ASTROID balance only
exist on the localnet/devnet you deploy to, end-to-end browser staking
needs that environment — there's no way to fake it against a
`CHAIN_ENABLED=false` gateway.
