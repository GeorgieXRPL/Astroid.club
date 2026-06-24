#!/usr/bin/env bash
#
# Localnet bootstrap for astroid.club on-chain staking (Quarry-first).
#
# Starts a local Solana validator with the deployed Quarry programs
# CLONED from mainnet, so we can stake / unstake / claim / redeem against
# real Quarry bytecode without building it from source. No proprietary
# astroid.club code lives here — this only stands up the chain.
#
# Program IDs are the canonical Saber Quarry addresses (verified against
# @quarryprotocol/quarry-sdk constants):
#   - Quarry Mine (staking)
#   - Quarry Mint Wrapper (IOU emissions)
#   - Quarry Redeemer (IOU -> token)
#
# Usage:
#   scripts/localnet/start-validator.sh            # public mainnet RPC
#   MAINNET_RPC=https://your-rpc scripts/localnet/start-validator.sh
#
# The validator RPC comes up on http://127.0.0.1:8899 and stores its
# ledger in ./test-ledger (gitignored). Stop with Ctrl-C.
set -euo pipefail

MAINNET_RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
LEDGER_DIR="${LEDGER_DIR:-test-ledger}"
# Default gossip port 8000 is occupied in this sandbox (a service holds
# TCP 8000), so move the validator's dynamic/gossip ports out of the way.
# RPC stays on 8899. Override with DYNAMIC_PORT_RANGE if needed.
DYNAMIC_PORT_RANGE="${DYNAMIC_PORT_RANGE:-8210-8240}"
GOSSIP_PORT="${GOSSIP_PORT:-8211}"
RPC_PORT="${RPC_PORT:-8899}"

QUARRY_MINE=QMNeHCGYnLVDn1icRAfQZpjPLBNkfGbSKRB83G5d8KB
QUARRY_MINT_WRAPPER=QMWoBmAyJLAsA1Lh9ugMTw2gciTihncciphzdNzdZYV
QUARRY_REDEEMER=QRDxhMw1P2NEfiw5mYXG79bwfgHTdasY2xNP76XSea9

echo "Starting local validator (cloning Quarry programs from: $MAINNET_RPC)"

exec solana-test-validator \
  --reset \
  --ledger "$LEDGER_DIR" \
  --rpc-port "$RPC_PORT" \
  --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range "$DYNAMIC_PORT_RANGE" \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$QUARRY_MINE" \
  --clone-upgradeable-program "$QUARRY_MINT_WRAPPER" \
  --clone-upgradeable-program "$QUARRY_REDEEMER"
