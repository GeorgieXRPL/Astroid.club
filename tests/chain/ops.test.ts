/**
 * Tests for the `ChainOps` chain-side-effect facade.
 *
 * Hard invariants:
 * 1. Every method is a no-op returning `{ ok: false, disabled: true }`
 *    when `chainEnabled === false`. The flag must win even when an
 *    impl is supplied (defense in depth: someone wires something up
 *    in dev, then ships with chain off — the flag still wins).
 * 2. With `chainEnabled === true` and no impl supplied, every method
 *    throws `ChainOpNotImplementedError` so the boot fn can refuse
 *    to start (loss of funds is worse than a crash).
 * 3. With `chainEnabled === true` and an impl supplied, every method
 *    delegates to the impl and wraps the result.
 *
 * The `runtime` config is constructed by hand (we don't import the
 * real `runtime` because it reads `process.env`). This keeps tests
 * deterministic and lets us flip `chainEnabled` per test.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ChainMisconfiguredError,
  ChainOpNotImplementedError,
  ChainOps,
  type ChainOpsImplementations,
} from '../../server/chain/index.js';
import type { AstroidRuntime } from '../../server/config/runtime.js';
import type { GameLogger } from '../../server/game/interfaces.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALICE = '11111111111111111111111111111111';

function offRuntime(): AstroidRuntime {
  return {
    chainEnabled: false,
    rpcUrl: undefined,
    astroidMint: undefined,
    astroidDecimals: 9,
    holderMinBalance: 1,
    holderMinSol: 0,
    holderMinHoldSeconds: 600,
    holderPrewarmEnabled: true,
    holderPrewarmMaxLookback: 100,
    corsAllowedOrigins: ['*'],
    walletAllowlist: [],
    adminSecret: undefined,
    redisUrl: undefined,
    databaseUrl: undefined,
    port: 3002,
  };
}

function onRuntime(overrides: Partial<AstroidRuntime> = {}): AstroidRuntime {
  return {
    ...offRuntime(),
    chainEnabled: true,
    rpcUrl: 'https://api.devnet.solana.com',
    astroidMint: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ...overrides,
  };
}

// =============================================================================
// chainEnabled=false: every op is a no-op
// =============================================================================

describe('ChainOps with chainEnabled=false', () => {
  it('reports isEnabled() === false', () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    expect(ops.isEnabled()).toBe(false);
  });

  it('executeYieldPayout returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.executeYieldPayout(ALICE, 100, 'home');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.disabled).toBe(true);
      expect(r.message).toContain('executeYieldPayout');
      expect(r.message).toContain('chain disabled');
    }
  });

  it('buildBetEscrowDeposit returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.buildBetEscrowDeposit(ALICE, 100, 'raid-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('verifyBetEscrowDeposit returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.verifyBetEscrowDeposit('sig', ALICE, 100, 'raid-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('executeBuyback returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.executeBuyback(0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('getHolderBalance returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.getHolderBalance(ALICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('verifyHolderQualified returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.verifyHolderQualified(ALICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('getOnChainStake returns disabled', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    const r = await ops.getOnChainStake(ALICE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.disabled).toBe(true);
  });

  it('the flag wins over a supplied impl (impls are ignored when off)', async () => {
    const yieldImpl = vi.fn(async () => 'sig-from-impl');
    const ops = new ChainOps({
      runtime: offRuntime(),
      logger: silentLogger,
      impls: { executeYieldPayout: yieldImpl },
    });
    const r = await ops.executeYieldPayout(ALICE, 100, 'home');
    expect(r.ok).toBe(false);
    expect(yieldImpl).not.toHaveBeenCalled();
  });

  it('the YieldPayoutListener adapter is a no-op when off (and warns)', () => {
    const yieldImpl = vi.fn(async () => 'sig');
    const warn = vi.fn();
    const logger: GameLogger = { info: () => {}, warn, error: () => {} };
    const ops = new ChainOps({
      runtime: offRuntime(),
      logger,
      impls: { executeYieldPayout: yieldImpl },
    });
    const listener = ops.toYieldPayoutListener();
    listener(ALICE, 100, 'home');
    expect(yieldImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

// =============================================================================
// chainEnabled=true with no impls: every op throws ChainOpNotImplementedError
// =============================================================================

describe('ChainOps with chainEnabled=true and no impls', () => {
  it('reports isEnabled() === true', () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    expect(ops.isEnabled()).toBe(true);
  });

  it('executeYieldPayout throws ChainOpNotImplementedError', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.executeYieldPayout(ALICE, 100, 'home')).rejects.toBeInstanceOf(
      ChainOpNotImplementedError,
    );
  });

  it('buildBetEscrowDeposit throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.buildBetEscrowDeposit(ALICE, 100, 'r1')).rejects.toBeInstanceOf(
      ChainOpNotImplementedError,
    );
  });

  it('verifyBetEscrowDeposit throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.verifyBetEscrowDeposit('sig', ALICE, 100, 'r1')).rejects.toBeInstanceOf(
      ChainOpNotImplementedError,
    );
  });

  it('executeBuyback throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.executeBuyback(0.5)).rejects.toBeInstanceOf(ChainOpNotImplementedError);
  });

  it('getHolderBalance throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.getHolderBalance(ALICE)).rejects.toBeInstanceOf(ChainOpNotImplementedError);
  });

  it('verifyHolderQualified throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.verifyHolderQualified(ALICE)).rejects.toBeInstanceOf(
      ChainOpNotImplementedError,
    );
  });

  it('getOnChainStake throws', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.getOnChainStake(ALICE)).rejects.toBeInstanceOf(ChainOpNotImplementedError);
  });

  it('the error names the slice that lands the impl', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    try {
      await ops.executeYieldPayout(ALICE, 1, 'home');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChainOpNotImplementedError);
      if (err instanceof ChainOpNotImplementedError) {
        expect(err.slice).toBe('chain_yield_sink');
        expect(err.op).toBe('executeYieldPayout');
      }
    }
  });
});

// =============================================================================
// chainEnabled=true with full impls: every op delegates and wraps
// =============================================================================

describe('ChainOps with chainEnabled=true and full impls', () => {
  function fullImpls(): ChainOpsImplementations {
    return {
      executeYieldPayout: vi.fn(async () => 'sig-yield'),
      buildBetEscrowDeposit: vi.fn(async () => ({
        transaction: 'serialized-tx-base64',
        blockhash: 'bh-escrow',
        lastValidBlockHeight: 123,
      })),
      verifyBetEscrowDeposit: vi.fn(async () => true),
      returnBetEscrow: vi.fn(async () => 'sig-return'),
      payBetDefender: vi.fn(async () => 'sig-spoils'),
      burnBetEscrow: vi.fn(async () => 'sig-burn'),
      executeBuyback: vi.fn(async () => ({ tokensReceived: 1234, signature: 'sig-buy' })),
      bridgeIou: vi.fn(async () => 'sig-bridge'),
      getHolderBalance: vi.fn(async () => 5_000),
      verifyHolderQualified: vi.fn(async () => true),
      getOnChainStake: vi.fn(async () => ({ amount: 9_000, lastUpdate: 12345 })),
      buildStakeTx: vi.fn(async () => ({
        transaction: 'stake-tx-b64',
        message: 'Stake 100 $ASTROID',
        lastValidBlockHeight: 100,
        blockhash: 'bh-stake',
      })),
      buildUnstakeTx: vi.fn(async () => ({
        transaction: 'unstake-tx-b64',
        message: 'Unstake 100 $ASTROID',
        lastValidBlockHeight: 101,
        blockhash: 'bh-unstake',
      })),
      buildClaimTx: vi.fn(async () => ({
        transaction: 'claim-tx-b64',
        message: 'Claim IOU-ASTROID',
        lastValidBlockHeight: 102,
        blockhash: 'bh-claim',
        estimatedReward: 7,
      })),
      buildRedeemTx: vi.fn(async () => ({
        transaction: 'redeem-tx-b64',
        message: 'Redeem IOU-ASTROID',
        lastValidBlockHeight: 103,
        blockhash: 'bh-redeem',
        requiresCoSign: true,
      })),
      coSignAndSubmitRedeem: vi.fn(async () => 'sig-redeem-submit'),
      verifyStakeTx: vi.fn(async () => ({ verified: true, actualAmount: 100 })),
      getStakeInfo: vi.fn(async () => ({
        walletAddress: ALICE,
        stakedAmount: 100,
        pendingRewards: 7,
        lastStakeTime: null,
        minerPDA: 'miner-pda',
      })),
    };
  }

  it('executeYieldPayout returns the signature from the impl', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.executeYieldPayout(ALICE, 100, 'home');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.signature).toBe('sig-yield');
    expect(impls.executeYieldPayout).toHaveBeenCalledWith(ALICE, 100, 'home');
  });

  it('buildBetEscrowDeposit wraps the serialized tx with amount + context', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.buildBetEscrowDeposit(ALICE, 250, 'raid-7');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.serializedTx).toBe('serialized-tx-base64');
      expect(r.amount).toBe(250);
      expect(r.context).toBe('raid-7');
      expect(r.blockhash).toBe('bh-escrow');
      expect(r.lastValidBlockHeight).toBe(123);
    }
  });

  it('verifyBetEscrowDeposit returns the impl boolean', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.verifyBetEscrowDeposit('sig', ALICE, 100, 'raid-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(true);
  });

  it('executeBuyback returns tokensReceived and signature', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.executeBuyback(0.5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.tokensReceived).toBe(1234);
  });

  it('getHolderBalance returns the impl number', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.getHolderBalance(ALICE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(5_000);
  });

  it('verifyHolderQualified returns the impl boolean', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.verifyHolderQualified(ALICE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(true);
  });

  it('getOnChainStake returns the impl object', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const r = await ops.getOnChainStake(ALICE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ amount: 9_000, lastUpdate: 12345 });
  });

  it('toYieldPayoutListener invokes the impl when on', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });
    const listener = ops.toYieldPayoutListener();
    listener(ALICE, 100, 'home');
    // Listener is fire-and-forget; flush microtasks twice for the chained .then.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(impls.executeYieldPayout).toHaveBeenCalledWith(ALICE, 100, 'home');
  });

  it('toYieldPayoutListener swallows impl rejections (logs but does not throw)', async () => {
    const error = vi.fn();
    const logger: GameLogger = { info: () => {}, warn: () => {}, error };
    const impls: ChainOpsImplementations = {
      ...fullImpls(),
      executeYieldPayout: vi.fn(async () => {
        throw new Error('rpc 500');
      }),
    };
    const ops = new ChainOps({ runtime: onRuntime(), logger, impls });
    const listener = ops.toYieldPayoutListener();
    expect(() => listener(ALICE, 100, 'home')).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
  });
});

// =============================================================================
// Quarry staking ops: disabled / not-implemented / delegation
// =============================================================================

describe('ChainOps Quarry staking ops', () => {
  it('all staking ops return disabled when chain is off', async () => {
    const ops = new ChainOps({ runtime: offRuntime(), logger: silentLogger });
    for (const r of [
      await ops.buildStakeTx(ALICE, 100),
      await ops.buildUnstakeTx(ALICE, 100),
      await ops.buildClaimTx(ALICE),
      await ops.buildRedeemTx(ALICE, 50),
      await ops.verifyStakeTx('sig', ALICE, 100),
      await ops.getStakeInfo(ALICE),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.disabled).toBe(true);
    }
  });

  it('staking ops throw ChainOpNotImplementedError (slice chain_quarry_staking) when on without impls', async () => {
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger });
    await expect(ops.buildStakeTx(ALICE, 1)).rejects.toBeInstanceOf(ChainOpNotImplementedError);
    try {
      await ops.buildRedeemTx(ALICE, 1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChainOpNotImplementedError);
      if (err instanceof ChainOpNotImplementedError) {
        expect(err.slice).toBe('chain_quarry_staking');
      }
    }
  });

  it('build ops delegate and wrap the unsigned tx', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });

    const stake = await ops.buildStakeTx(ALICE, 100);
    expect(stake.ok).toBe(true);
    if (stake.ok && !('error' in stake.data)) {
      expect(stake.data.transaction).toBe('stake-tx-b64');
    }
    expect(impls.buildStakeTx).toHaveBeenCalledWith(ALICE, 100);

    const claim = await ops.buildClaimTx(ALICE);
    expect(claim.ok).toBe(true);
    if (claim.ok && !('error' in claim.data)) {
      expect(claim.data.estimatedReward).toBe(7);
    }
  });

  it('verifyStakeTx and getStakeInfo delegate', async () => {
    const impls = fullImpls();
    const ops = new ChainOps({ runtime: onRuntime(), logger: silentLogger, impls });

    const verify = await ops.verifyStakeTx('sig-123', ALICE, 100);
    expect(verify.ok).toBe(true);
    if (verify.ok) expect(verify.data.verified).toBe(true);
    expect(impls.verifyStakeTx).toHaveBeenCalledWith('sig-123', ALICE, 100);

    const info = await ops.getStakeInfo(ALICE);
    expect(info.ok).toBe(true);
    if (info.ok) expect(info.data.stakedAmount).toBe(100);
  });

  /** Module-scoped impls factory (the other block's `fullImpls` is local). */
  function fullImpls(): ChainOpsImplementations {
    return {
      executeYieldPayout: vi.fn(async () => 'sig-yield'),
      buildBetEscrowDeposit: vi.fn(async () => ({
        transaction: 'serialized-tx-base64',
        blockhash: 'bh-escrow',
        lastValidBlockHeight: 123,
      })),
      verifyBetEscrowDeposit: vi.fn(async () => true),
      returnBetEscrow: vi.fn(async () => 'sig-return'),
      payBetDefender: vi.fn(async () => 'sig-spoils'),
      burnBetEscrow: vi.fn(async () => 'sig-burn'),
      executeBuyback: vi.fn(async () => ({ tokensReceived: 1234, signature: 'sig-buy' })),
      bridgeIou: vi.fn(async () => 'sig-bridge'),
      getHolderBalance: vi.fn(async () => 5_000),
      verifyHolderQualified: vi.fn(async () => true),
      getOnChainStake: vi.fn(async () => ({ amount: 9_000, lastUpdate: 12345 })),
      buildStakeTx: vi.fn(async () => ({
        transaction: 'stake-tx-b64',
        message: 'Stake 100 $ASTROID',
        lastValidBlockHeight: 100,
        blockhash: 'bh-stake',
      })),
      buildUnstakeTx: vi.fn(async () => ({
        transaction: 'unstake-tx-b64',
        message: 'Unstake 100 $ASTROID',
        lastValidBlockHeight: 101,
        blockhash: 'bh-unstake',
      })),
      buildClaimTx: vi.fn(async () => ({
        transaction: 'claim-tx-b64',
        message: 'Claim IOU-ASTROID',
        lastValidBlockHeight: 102,
        blockhash: 'bh-claim',
        estimatedReward: 7,
      })),
      buildRedeemTx: vi.fn(async () => ({
        transaction: 'redeem-tx-b64',
        message: 'Redeem IOU-ASTROID',
        lastValidBlockHeight: 103,
        blockhash: 'bh-redeem',
        requiresCoSign: true,
      })),
      coSignAndSubmitRedeem: vi.fn(async () => 'sig-redeem-submit'),
      verifyStakeTx: vi.fn(async () => ({ verified: true, actualAmount: 100 })),
      getStakeInfo: vi.fn(async () => ({
        walletAddress: ALICE,
        stakedAmount: 100,
        pendingRewards: 7,
        lastStakeTime: null,
        minerPDA: 'miner-pda',
      })),
    };
  }
});

// =============================================================================
// Misconfiguration guard
// =============================================================================

describe('ChainOps misconfiguration guards', () => {
  it('throws ChainMisconfiguredError when on but rpcUrl is missing', () => {
    expect(
      () =>
        new ChainOps({
          runtime: onRuntime({ rpcUrl: undefined }),
          logger: silentLogger,
        }),
    ).toThrow(ChainMisconfiguredError);
  });

  it('throws ChainMisconfiguredError when on but astroidMint is missing', () => {
    expect(
      () =>
        new ChainOps({
          runtime: onRuntime({ astroidMint: undefined }),
          logger: silentLogger,
        }),
    ).toThrow(ChainMisconfiguredError);
  });

  it('error message names the missing field', () => {
    try {
      new ChainOps({
        runtime: onRuntime({ rpcUrl: undefined }),
        logger: silentLogger,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ChainMisconfiguredError);
      if (err instanceof ChainMisconfiguredError) {
        expect(err.message).toContain('SOLANA_RPC_URL');
      }
    }
  });

  it('does NOT throw when off, even with all chain config missing', () => {
    expect(() => new ChainOps({ runtime: offRuntime(), logger: silentLogger })).not.toThrow();
  });
});
