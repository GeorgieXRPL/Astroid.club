/**
 * Integration tests for `server/net/gateway.ts`.
 *
 * Spins up a real `AstroidGateway` on an ephemeral port and drives
 * it with the `ws` package as a client (the engine ships a
 * `NetClient` that targets a global `WebSocket`, but the `ws` lib
 * is what real clients use under the hood and is more reliable on
 * older Node versions).
 *
 * Covers: connect → request_nonce → auth → game-message dispatch.
 * Both signed-auth happy paths and rejection paths (bad signature,
 * unauthenticated game message, unknown asteroid) are exercised.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { AsteroidDefinition } from '../../config/asteroids.js';
import { ChainOps, type ChainOpsImplementations } from '../../server/chain/index.js';
import type { AstroidRuntime } from '../../server/config/runtime.js';
import type { GameLogger } from '../../server/game/interfaces.js';
import { GameWorld } from '../../server/game/world.js';
import { AstroidGateway } from '../../server/net/gateway.js';

const silentLogger: GameLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const HOME: AsteroidDefinition = {
  id: 'home',
  name: 'Ceres Outpost',
  resource: 'carbon',
  sector: 'Inner Belt',
  position: { x: 0, y: 0, z: 0 },
  baseDiscoveryTimeMs: 5 * 60 * 1000,
  baseRewardMultiplier: 1.0,
  description: 'Reliable outpost.',
};

const RICH: AsteroidDefinition = {
  id: 'rich',
  name: 'Eros Spike',
  resource: 'gold',
  sector: 'Inner Belt',
  position: { x: 1, y: 0, z: 0 },
  baseDiscoveryTimeMs: 20 * 60 * 1000,
  baseRewardMultiplier: 1.5,
  description: 'Prime raid target.',
};

interface Harness {
  gateway: AstroidGateway;
  world: GameWorld;
  httpServer: HttpServer;
  port: number;
}

interface HarnessOptions {
  /**
   * Plug a chain-op fake into the harness. When omitted the gateway
   * runs with no `chainOps`, which is the same posture as a
   * `CHAIN_ENABLED=false` build — `verify_holder` returns the
   * pass-through "chain disabled" envelope.
   */
  chainOps?: ChainOps;
  /** Optional wallet allowlist forwarded to the gateway. */
  walletAllowlist?: readonly string[];
}

/**
 * Build a `ChainOps` ready for the gateway to call into.
 *
 * `chainEnabled: true` activates the gating in `ChainOps`. The
 * `verifyHolderQualified` impl is the only one we plug; other ops
 * stay un-implemented and the tests don't exercise them. RPC URL +
 * mint are stub strings — `ChainOps` itself never reads them.
 */
function makeChainOps(verifyHolderImpl: (wallet: string) => Promise<boolean>): ChainOps {
  const runtime: AstroidRuntime = {
    chainEnabled: true,
    rpcUrl: 'https://api.devnet.solana.com',
    astroidMint: 'AstroIDMintStubXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    astroidDecimals: 9,
    holderMinBalance: 1,
    holderMinHoldSeconds: 600,
    holderPrewarmEnabled: true,
    holderPrewarmMaxLookback: 100,
    corsAllowedOrigins: ['http://localhost:3000'],
    walletAllowlist: [],
    adminSecret: undefined,
    redisUrl: undefined,
    databaseUrl: undefined,
    port: 0,
  };
  const impls: Partial<ChainOpsImplementations> = {
    verifyHolderQualified: verifyHolderImpl,
  };
  return new ChainOps({ runtime, impls, logger: silentLogger });
}

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const world = new GameWorld({
    asteroids: [HOME, RICH],
    logger: silentLogger,
    chainEnabled: false,
  });
  const gateway = new AstroidGateway({
    world,
    server: httpServer,
    logger: silentLogger,
    tickIntervalMs: 0, // disable maintenance interval in tests
    heartbeatMs: 0,
    ...(opts.chainOps && { chainOps: opts.chainOps }),
    ...(opts.walletAllowlist && { walletAllowlist: opts.walletAllowlist }),
  });
  gateway.start();
  return { gateway, world, httpServer, port };
}

async function stopHarness(h: Harness): Promise<void> {
  h.gateway.stop();
  await new Promise<void>((resolve, reject) => {
    h.httpServer.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Open a `ws` client to the given port and wait for the socket to open. */
async function openSocket(port: number): Promise<WebSocket> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    sock.once('open', () => resolve());
    sock.once('error', reject);
  });
  return sock;
}

/** Send a JSON message and wait for the next reply (synchronously framed). */
async function send(sock: WebSocket, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      sock.off('message', onMessage);
      sock.off('error', onError);
      try {
        resolve(JSON.parse(data.toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => {
      sock.off('message', onMessage);
      sock.off('error', onError);
      reject(err);
    };
    sock.on('message', onMessage);
    sock.on('error', onError);
    sock.send(JSON.stringify(payload));
  });
}

/**
 * Build a Solana-style ed25519 keypair, return its base58 public key
 * (treat as wallet address) and a signer fn that takes a string and
 * returns its base64-encoded detached signature.
 */
function makeWallet(): { walletAddress: string; sign: (msg: string) => string } {
  const keypair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(keypair.publicKey);
  const sign = (msg: string): string => {
    const sig = nacl.sign.detached(new TextEncoder().encode(msg), keypair.secretKey);
    return Buffer.from(sig).toString('base64');
  };
  return { walletAddress, sign };
}

describe('AstroidGateway wallet allowlist', () => {
  let h: Harness;
  let allowed: { walletAddress: string; sign: (msg: string) => string };

  beforeEach(async () => {
    allowed = makeWallet();
    h = await startHarness({ walletAllowlist: [allowed.walletAddress] });
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  /** Run the nonce → auth handshake for a wallet, return the auth reply. */
  async function authWith(wallet: {
    walletAddress: string;
    sign: (msg: string) => string;
  }): Promise<{ type: string; code?: string; message?: string }> {
    const sock = await openSocket(h.port);
    const nonceReply = (await send(sock, {
      type: 'request_nonce',
      walletAddress: wallet.walletAddress,
    })) as { data: { nonce: string; message: string } };
    const reply = (await send(sock, {
      type: 'auth',
      walletAddress: wallet.walletAddress,
      nonce: nonceReply.data.nonce,
      signature: wallet.sign(nonceReply.data.message),
    })) as { type: string; code?: string; message?: string };
    sock.close();
    return reply;
  }

  it('admits a wallet that is on the allowlist', async () => {
    const reply = await authWith(allowed);
    expect(reply.type).toBe('result');
  });

  it('rejects a wallet that is NOT on the allowlist (valid signature)', async () => {
    const stranger = makeWallet();
    const reply = await authWith(stranger);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(reply.message).toMatch(/allowlist/i);
  });
});

describe('AstroidGateway connect + auth flow', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await stopHarness(h);
  });

  it('completes the full nonce → auth → snapshot handshake', async () => {
    const { walletAddress, sign } = makeWallet();
    const sock = await openSocket(h.port);

    const nonceReply = (await send(sock, {
      type: 'request_nonce',
      walletAddress,
      requestId: 'r1',
    })) as { type: string; requestId?: string; data: { nonce: string; message: string } };
    expect(nonceReply.type).toBe('result');
    expect(nonceReply.requestId).toBe('r1');
    expect(nonceReply.data.nonce).toBeTruthy();
    expect(nonceReply.data.message).toContain(nonceReply.data.nonce);

    const signature = sign(nonceReply.data.message);
    const authReply = (await send(sock, {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature,
      requestId: 'r2',
    })) as { type: string; requestId?: string; data: { walletAddress: string } };
    expect(authReply.type).toBe('result');
    expect(authReply.requestId).toBe('r2');
    expect(authReply.data.walletAddress).toBe(walletAddress);

    sock.close();
  });

  it('rejects auth with a bogus signature', async () => {
    const { walletAddress } = makeWallet();
    const sock = await openSocket(h.port);

    const nonceReply = (await send(sock, { type: 'request_nonce', walletAddress })) as {
      data: { nonce: string };
    };

    const authReply = (await send(sock, {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature: Buffer.from('not-a-real-signature').toString('base64'),
    })) as { type: string; code?: string };
    expect(authReply.type).toBe('error');
    expect(authReply.code).toBe('rejected');

    sock.close();
  });

  it('rejects post-auth messages before authentication', async () => {
    const sock = await openSocket(h.port);
    const reply = (await send(sock, { type: 'join_asteroid', asteroidId: 'home' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('not_authenticated');
    sock.close();
  });
});

describe('AstroidGateway dispatch (post-auth)', () => {
  let h: Harness;
  let sock: WebSocket;
  let walletAddress: string;

  async function authenticate(): Promise<{ walletAddress: string; sock: WebSocket }> {
    const { walletAddress: w, sign } = makeWallet();
    const s = await openSocket(h.port);
    const nonceReply = (await send(s, { type: 'request_nonce', walletAddress: w })) as {
      data: { nonce: string; message: string };
    };
    await send(s, {
      type: 'auth',
      walletAddress: w,
      nonce: nonceReply.data.nonce,
      signature: sign(nonceReply.data.message),
    });
    return { walletAddress: w, sock: s };
  }

  beforeEach(async () => {
    h = await startHarness();
    const auth = await authenticate();
    sock = auth.sock;
    walletAddress = auth.walletAddress;
  });

  afterEach(async () => {
    sock.close();
    await stopHarness(h);
  });

  it('joins a known asteroid', async () => {
    const reply = (await send(sock, {
      type: 'join_asteroid',
      asteroidId: 'home',
      requestId: 'q',
    })) as { type: string; requestId?: string };
    expect(reply.type).toBe('result');
    expect(reply.requestId).toBe('q');
    expect(h.world.registry.getMinerLocation(walletAddress)).toBe('home');
  });

  it('rejects an unknown asteroid', async () => {
    const reply = (await send(sock, { type: 'join_asteroid', asteroidId: 'nope' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('unknown_asteroid');
  });

  it('round-trips set_home_station + stake + claim_yield', async () => {
    let reply = (await send(sock, { type: 'set_home_station', asteroidId: 'home' })) as {
      type: string;
    };
    expect(reply.type).toBe('result');

    reply = (await send(sock, { type: 'stake', asteroidId: 'home', amount: 500 })) as {
      type: string;
    };
    expect(reply.type).toBe('result');
    expect(h.world.stakeManager.getStakeAtAsteroid(walletAddress, 'home')).toBe(500);

    h.world.stakeManager.addPendingYield(walletAddress, 'home', 250);
    const claimReply = (await send(sock, { type: 'claim_yield' })) as {
      type: string;
      data: { claimed: number };
    };
    expect(claimReply.type).toBe('result');
    expect(claimReply.data.claimed).toBe(250);
  });

  it('returns network_stats without auth state changes', async () => {
    const reply = (await send(sock, { type: 'network_stats', requestId: 'ns' })) as {
      type: string;
      requestId?: string;
      data: { totalMiners: number; asteroids: unknown[] };
    };
    expect(reply.type).toBe('result');
    expect(reply.requestId).toBe('ns');
    expect(reply.data.asteroids.length).toBe(2);
  });

  it('returns miner_snapshot for the authenticated wallet', async () => {
    const reply = (await send(sock, { type: 'miner_snapshot' })) as {
      type: string;
      data: { walletAddress: string };
    };
    expect(reply.type).toBe('result');
    expect(reply.data.walletAddress).toBe(walletAddress);
  });

  // A benign business-rule rejection (here: reporting drill power before
  // joining an asteroid) must NOT accrue anti-cheat backoff. Backoff gates
  // ALL non-readonly actions per wallet, so penalizing routine validation
  // failures would lock the player out of unrelated actions like claiming.
  it('does not backoff a wallet on benign action failures', async () => {
    // Several benign failures in a row.
    for (let i = 0; i < 5; i++) {
      const reply = (await send(sock, {
        type: 'report_drill_power',
        drillPower: 5000,
        requestId: `dp-${i}`,
      })) as { type: string; code?: string };
      expect(reply.type).toBe('error');
      expect(reply.code).toBe('rejected'); // "must join an asteroid first"
    }

    // A subsequent unrelated action must still be allowed (not rate_limited).
    const join = (await send(sock, {
      type: 'join_asteroid',
      asteroidId: 'home',
      requestId: 'join',
    })) as { type: string; code?: string };
    expect(join.type).toBe('result');

    // And the wallet should have accrued no backoff.
    const check = h.world.antiCheat.checkAction(walletAddress, '127.0.0.1');
    expect(check.allowed).toBe(true);
  });

  it('clamps an over-cap drill-power report instead of rejecting it', async () => {
    await send(sock, { type: 'join_asteroid', asteroidId: 'home' });
    const reply = (await send(sock, {
      type: 'report_drill_power',
      drillPower: 1e15,
      requestId: 'cap',
    })) as { type: string; code?: string; data?: { effective: number } };
    expect(reply.type).toBe('result');
    // Effective power is bounded (base clamped to 10M, before tier multiplier).
    expect(h.world.getReportedDrillPower(walletAddress)).toBeLessThanOrEqual(10_000_000);
  });

  it('rejects payloads that fail zod validation with invalid_message', async () => {
    const reply = (await send(sock, { type: 'stake', asteroidId: 'home', amount: -1 })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('invalid_message');
  });

  // Read-only message types (`miner_snapshot`, `network_stats`) are
  // exempt from the per-wallet anti-cheat action budget so HUD polls
  // never compete with state-changing actions. The default budget is
  // 10 actions / 60s; sending 30+ reads in succession would trip the
  // limiter without the exemption. If this test starts failing the
  // exemption regressed and the arena's HUD will lock up after a
  // handful of refreshes.
  it('does not rate-limit read-only messages', async () => {
    const READS = 30;
    for (let i = 0; i < READS; i++) {
      const reply = (await send(sock, {
        type: 'network_stats',
        requestId: `rl-${i}`,
      })) as { type: string; requestId?: string; code?: string };
      expect(reply.type, `network_stats #${i + 1} should not be rate-limited`).toBe('result');
      expect(reply.requestId).toBe(`rl-${i}`);
    }
    for (let i = 0; i < READS; i++) {
      const reply = (await send(sock, {
        type: 'miner_snapshot',
        requestId: `ms-${i}`,
      })) as { type: string; code?: string };
      expect(reply.type, `miner_snapshot #${i + 1} should not be rate-limited`).toBe('result');
    }
  });
});

describe('AstroidGateway verify_holder', () => {
  /** Open a socket, run nonce → auth, return the authenticated socket. */
  async function authedSocket(port: number): Promise<{ sock: WebSocket; wallet: string }> {
    const { walletAddress, sign } = makeWallet();
    const sock = await openSocket(port);
    const nonceReply = (await send(sock, { type: 'request_nonce', walletAddress })) as {
      data: { nonce: string; message: string };
    };
    await send(sock, {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature: sign(nonceReply.data.message),
    });
    return { sock, wallet: walletAddress };
  }

  it('rejects verify_holder before authentication', async () => {
    const h = await startHarness();
    const sock = await openSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder', requestId: 'v0' })) as {
      type: string;
      requestId?: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.requestId).toBe('v0');
    expect(reply.code).toBe('not_authenticated');
    sock.close();
    await stopHarness(h);
  });

  it('returns chain_disabled pass-through when no ChainOps is configured', async () => {
    // No `chainOps` plugged — the gateway should treat `verify_holder`
    // as if chain were off and reply with the pass-through eligible
    // envelope. This keeps local dev / test suites usable without
    // standing up a fake RPC.
    const h = await startHarness();
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder', requestId: 'v1' })) as {
      type: string;
      requestId?: string;
      data: {
        eligible: boolean;
        reason: string;
        walletAddress: string;
        message: string;
      };
    };
    expect(reply.type).toBe('result');
    expect(reply.requestId).toBe('v1');
    expect(reply.data.eligible).toBe(true);
    expect(reply.data.reason).toBe('chain_disabled');
    expect(reply.data.walletAddress).toBe(wallet);
    expect(typeof reply.data.message).toBe('string');
    sock.close();
    await stopHarness(h);
  });

  it('returns chain_disabled even when ChainOps is plugged but disabled', async () => {
    // ChainOps's own `chainEnabled` flag dominates: even with an
    // impl in place, `runtime.chainEnabled === false` short-circuits
    // to the disabled sentinel. The gateway must collapse that into
    // the same pass-through envelope.
    const runtime: AstroidRuntime = {
      chainEnabled: false,
      rpcUrl: undefined,
      astroidMint: undefined,
      astroidDecimals: 9,
      holderMinBalance: 1,
      holderMinHoldSeconds: 600,
      holderPrewarmEnabled: true,
      holderPrewarmMaxLookback: 100,
      corsAllowedOrigins: ['http://localhost:3000'],
      walletAllowlist: [],
      adminSecret: undefined,
      redisUrl: undefined,
      databaseUrl: undefined,
      port: 0,
    };
    const chainOps = new ChainOps({
      runtime,
      impls: { verifyHolderQualified: async () => true },
      logger: silentLogger,
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder' })) as {
      type: string;
      data: { eligible: boolean; reason: string };
    };
    expect(reply.type).toBe('result');
    expect(reply.data.eligible).toBe(true);
    expect(reply.data.reason).toBe('chain_disabled');
    sock.close();
    await stopHarness(h);
  });

  it('returns qualified when ChainOps says yes', async () => {
    const seen: string[] = [];
    const chainOps = makeChainOps(async (wallet) => {
      seen.push(wallet);
      return true;
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder' })) as {
      type: string;
      data: { eligible: boolean; reason: string; walletAddress: string };
    };
    expect(reply.type).toBe('result');
    expect(reply.data.eligible).toBe(true);
    expect(reply.data.reason).toBe('qualified');
    expect(reply.data.walletAddress).toBe(wallet);
    // Most importantly: the gateway used the connection's wallet,
    // NOT one supplied in the message body.
    expect(seen).toEqual([wallet]);
    sock.close();
    await stopHarness(h);
  });

  it('returns not_qualified when ChainOps says no, without leaking balance details', async () => {
    const chainOps = makeChainOps(async () => false);
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder' })) as {
      type: string;
      data: {
        eligible: boolean;
        reason: string;
        walletAddress: string;
        message: string;
      };
    };
    expect(reply.type).toBe('result');
    expect(reply.data.eligible).toBe(false);
    expect(reply.data.reason).toBe('not_qualified');
    expect(reply.data.walletAddress).toBe(wallet);
    // Sanity: the message must not echo a numeric balance, threshold,
    // or hold-seconds value — the Club gate is a binary surface.
    expect(reply.data.message).not.toMatch(/\d/);
    sock.close();
    await stopHarness(h);
  });

  it('always uses the authenticated wallet, ignoring any client-supplied address', async () => {
    // The wallet identity comes from the connection meta, NOT from
    // the message body. Even if a client sneaks an extra
    // `walletAddress` onto the verify_holder request (zod permits
    // unknown keys by default), the gateway must look up the
    // authenticated wallet — otherwise a post-auth client could
    // probe arbitrary addresses' eligibility.
    const seen: string[] = [];
    const chainOps = makeChainOps(async (wallet) => {
      seen.push(wallet);
      return true;
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, {
      type: 'verify_holder',
      walletAddress: 'thisShouldBeIgnored1111111111111111111111111',
    })) as { type: string; data: { walletAddress: string } };
    expect(reply.type).toBe('result');
    expect(reply.data.walletAddress).toBe(wallet);
    expect(seen).toEqual([wallet]);
    sock.close();
    await stopHarness(h);
  });

  it('surfaces RPC failures as a rejected error envelope', async () => {
    const chainOps = makeChainOps(async () => {
      throw new Error('helius rpc 503');
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'verify_holder', requestId: 'vErr' })) as {
      type: string;
      requestId?: string;
      code?: string;
      message?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.requestId).toBe('vErr');
    expect(reply.code).toBe('rejected');
    expect(reply.message).toContain('helius rpc 503');
    sock.close();
    await stopHarness(h);
  });
});

describe('AstroidGateway on-chain staking messages', () => {
  async function authedSocket(port: number): Promise<{ sock: WebSocket; wallet: string }> {
    const { walletAddress, sign } = makeWallet();
    const sock = await openSocket(port);
    const nonceReply = (await send(sock, { type: 'request_nonce', walletAddress })) as {
      data: { nonce: string; message: string };
    };
    await send(sock, {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature: sign(nonceReply.data.message),
    });
    return { sock, wallet: walletAddress };
  }

  /** ChainOps (enabled) with the staking build/verify impls plugged. */
  function makeStakingChainOps(impls: Partial<ChainOpsImplementations>): ChainOps {
    const runtime: AstroidRuntime = {
      chainEnabled: true,
      rpcUrl: 'https://api.devnet.solana.com',
      astroidMint: 'AstroIDMintStubXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      astroidDecimals: 6,
      holderMinBalance: 1,
      holderMinHoldSeconds: 600,
      holderPrewarmEnabled: true,
      holderPrewarmMaxLookback: 100,
      corsAllowedOrigins: ['http://localhost:3000'],
      walletAllowlist: [],
      adminSecret: undefined,
      redisUrl: undefined,
      databaseUrl: undefined,
      port: 0,
    };
    return new ChainOps({ runtime, impls, logger: silentLogger });
  }

  it('rejects build_stake_tx before authentication', async () => {
    const h = await startHarness();
    const sock = await openSocket(h.port);
    const reply = (await send(sock, { type: 'build_stake_tx', amount: 100, requestId: 's0' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('not_authenticated');
    sock.close();
    await stopHarness(h);
  });

  it('returns chain_disabled when no ChainOps is configured', async () => {
    const h = await startHarness();
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'build_stake_tx', amount: 100, requestId: 's1' })) as {
      type: string;
      requestId?: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.requestId).toBe('s1');
    expect(reply.code).toBe('chain_disabled');
    sock.close();
    await stopHarness(h);
  });

  it('forwards the unsigned tx from a build op, using the authed wallet', async () => {
    const seen: Array<{ wallet: string; amount: number }> = [];
    const chainOps = makeStakingChainOps({
      buildStakeTx: async (wallet, amount) => {
        seen.push({ wallet, amount });
        return {
          transaction: 'unsigned-stake-b64',
          message: `Stake ${amount} $ASTROID`,
          lastValidBlockHeight: 42,
          blockhash: 'bh',
        };
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'build_stake_tx', amount: 250, requestId: 's2' })) as {
      type: string;
      requestId?: string;
      data: { transaction: string; message: string; blockhash: string };
    };
    expect(reply.type).toBe('result');
    expect(reply.requestId).toBe('s2');
    expect(reply.data.transaction).toBe('unsigned-stake-b64');
    expect(seen).toEqual([{ wallet, amount: 250 }]);
    sock.close();
    await stopHarness(h);
  });

  it('maps a builder { error } into a rejected envelope', async () => {
    const chainOps = makeStakingChainOps({
      buildRedeemTx: async () => ({ error: 'Insufficient balance for this action.' }),
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'build_redeem_tx', amount: 5, requestId: 's3' })) as {
      type: string;
      code?: string;
      message?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(reply.message).toContain('Insufficient balance');
    sock.close();
    await stopHarness(h);
  });

  it('caches a requiresCoSign redeem and submits it via the treasury co-signer', async () => {
    let captured: { wallet: string; args: Record<string, unknown> } | null = null;
    const chainOps = makeStakingChainOps({
      buildRedeemTx: async () => ({
        transaction: 'built-redeem-b64',
        message: 'Redeem 5 IOU-ASTROID',
        lastValidBlockHeight: 50,
        blockhash: 'bh-redeem',
        requiresCoSign: true,
      }),
      coSignAndSubmitRedeem: async (wallet, args) => {
        captured = { wallet, args };
        return 'redeem-submit-sig';
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);

    const build = (await send(sock, {
      type: 'build_redeem_tx',
      amount: 5,
      requestId: 'r1',
    })) as { type: string; data: { transaction: string; requiresCoSign?: boolean } };
    expect(build.type).toBe('result');
    expect(build.data.requiresCoSign).toBe(true);

    const submit = (await send(sock, {
      type: 'submit_redeem_swap',
      signedTransaction: 'wallet-signed-b64',
      requestId: 'r2',
    })) as { type: string; data: { signature: string } };
    expect(submit.type).toBe('result');
    expect(submit.data.signature).toBe('redeem-submit-sig');

    // The gateway must hand the co-signer the tx IT issued plus the wallet's
    // signed version (the impl proves they share a message before signing).
    expect(captured).not.toBeNull();
    expect(captured!.wallet).toBe(wallet);
    expect(captured!.args.builtTransaction).toBe('built-redeem-b64');
    expect(captured!.args.signedTransaction).toBe('wallet-signed-b64');
    expect(captured!.args.blockhash).toBe('bh-redeem');
    sock.close();
    await stopHarness(h);
  });

  it('rejects submit_redeem_swap when no redeem was built first', async () => {
    let called = false;
    const chainOps = makeStakingChainOps({
      coSignAndSubmitRedeem: async () => {
        called = true;
        return 'should-not-happen';
      },
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, {
      type: 'submit_redeem_swap',
      signedTransaction: 'orphan-b64',
      requestId: 'r3',
    })) as { type: string; code?: string; message?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(reply.message).toMatch(/no redeem to submit/i);
    expect(called).toBe(false);
    sock.close();
    await stopHarness(h);
  });

  it('returns stake_info data verbatim from the read op', async () => {
    const chainOps = makeStakingChainOps({
      getStakeInfo: async (wallet) => ({
        walletAddress: wallet,
        stakedAmount: 1000,
        pendingRewards: 7,
        lastStakeTime: null,
        minerPDA: 'pda',
      }),
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'stake_info', requestId: 's4' })) as {
      type: string;
      data: { walletAddress: string; stakedAmount: number; pendingRewards: number };
    };
    expect(reply.type).toBe('result');
    expect(reply.data.walletAddress).toBe(wallet);
    expect(reply.data.stakedAmount).toBe(1000);
    expect(reply.data.pendingRewards).toBe(7);
    sock.close();
    await stopHarness(h);
  });

  it('verifies a stake tx through verify_stake_tx', async () => {
    const seen: Array<{ sig: string; wallet: string; amount: number }> = [];
    const chainOps = makeStakingChainOps({
      verifyStakeTx: async (sig, wallet, amount) => {
        seen.push({ sig, wallet, amount });
        return { verified: true, actualAmount: amount };
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    const sig = 'a'.repeat(88);
    const reply = (await send(sock, {
      type: 'verify_stake_tx',
      signature: sig,
      amount: 100,
      requestId: 's5',
    })) as { type: string; data: { verified: boolean; actualAmount?: number } };
    expect(reply.type).toBe('result');
    expect(reply.data.verified).toBe(true);
    expect(seen).toEqual([{ sig, wallet, amount: 100 }]);
    sock.close();
    await stopHarness(h);
  });

  it('returns a graceful chain_disabled (not a thrown error) when staking is unwired', async () => {
    // Chain is enabled but no staking impls are plugged (e.g. Quarry
    // addresses unset pre-launch). `getStakeInfo` throws
    // `ChainOpNotImplementedError` internally; the gateway must catch it
    // and reply chain_disabled rather than letting it bubble and spam the
    // server logs / drop the request.
    const chainOps = makeStakingChainOps({});
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'stake_info', requestId: 's6' })) as {
      type: string;
      requestId?: string;
      code?: string;
      message?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.requestId).toBe('s6');
    expect(reply.code).toBe('chain_disabled');
    expect(reply.message).toMatch(/not available yet/i);
    sock.close();
    await stopHarness(h);
  });

  it('also catches the unwired case for build ops (build_stake_tx)', async () => {
    const chainOps = makeStakingChainOps({});
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, {
      type: 'build_stake_tx',
      amount: 100,
      requestId: 's7',
    })) as { type: string; code?: string; message?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('chain_disabled');
    expect(reply.message).toMatch(/not available yet/i);
    sock.close();
    await stopHarness(h);
  });

  it('rejects bridge_iou with chain_disabled when no ChainOps is configured', async () => {
    const h = await startHarness();
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, { type: 'bridge_iou', amount: 10, requestId: 'b0' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('chain_disabled');
    sock.close();
    await stopHarness(h);
  });

  it('bridge_iou debits in-game credits then returns the chain signature', async () => {
    const seen: Array<{ wallet: string; amount: number }> = [];
    const chainOps = makeStakingChainOps({
      bridgeIou: async (wallet, amount) => {
        seen.push({ wallet, amount });
        return 'sig-bridge-abc';
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    h.world.stakeManager.addPendingYield(wallet, 'home', 100);

    const reply = (await send(sock, { type: 'bridge_iou', amount: 40, requestId: 'b1' })) as {
      type: string;
      requestId?: string;
      data: { signature: string; bridged: number };
    };
    expect(reply.type).toBe('result');
    expect(reply.requestId).toBe('b1');
    expect(reply.data.signature).toBe('sig-bridge-abc');
    expect(reply.data.bridged).toBe(40);
    expect(seen).toEqual([{ wallet, amount: 40 }]);
    expect(h.world.stakeManager.getPendingYield(wallet)).toBe(60);
    sock.close();
    await stopHarness(h);
  });

  it('bridge_iou rejects (no chain call, no debit) when credits are insufficient', async () => {
    const seen: number[] = [];
    const chainOps = makeStakingChainOps({
      bridgeIou: async (_wallet, amount) => {
        seen.push(amount);
        return 'should-not-happen';
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    h.world.stakeManager.addPendingYield(wallet, 'home', 30);

    const reply = (await send(sock, { type: 'bridge_iou', amount: 40, requestId: 'b2' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(seen).toEqual([]); // chain op never invoked
    expect(h.world.stakeManager.getPendingYield(wallet)).toBe(30); // credits untouched
    sock.close();
    await stopHarness(h);
  });

  it('bridge_iou refunds the debited credits when the chain transfer is unwired', async () => {
    const chainOps = makeStakingChainOps({}); // no bridgeIou impl
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    h.world.stakeManager.addPendingYield(wallet, 'home', 100);

    const reply = (await send(sock, { type: 'bridge_iou', amount: 40, requestId: 'b3' })) as {
      type: string;
      code?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('chain_disabled');
    // The up-front debit must be rolled back so the player keeps their credits.
    expect(h.world.stakeManager.getPendingYield(wallet)).toBe(100);
    sock.close();
    await stopHarness(h);
  });

  it('bridge_iou refunds the debited credits when the chain transfer throws', async () => {
    const chainOps = makeStakingChainOps({
      bridgeIou: async () => {
        throw new Error('bridge failed: treasury too low');
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    h.world.stakeManager.addPendingYield(wallet, 'home', 100);

    const reply = (await send(sock, { type: 'bridge_iou', amount: 40, requestId: 'b4' })) as {
      type: string;
      code?: string;
      message?: string;
    };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(reply.message).toMatch(/treasury too low/i);
    expect(h.world.stakeManager.getPendingYield(wallet)).toBe(100);
    sock.close();
    await stopHarness(h);
  });
});

describe('AstroidGateway wager-deposit messages', () => {
  /**
   * Like `send`, but skips server-pushed `event` envelopes (raid_started /
   * raid_resolved broadcasts) and resolves on the `result`/`error` matching
   * `requestId`. Raid messages broadcast, so the plain `send` can race the
   * event ahead of the reply.
   */
  async function sendResult(
    sock: WebSocket,
    payload: { requestId: string; [k: string]: unknown },
  ): Promise<{ type: string; requestId?: string; code?: string; message?: string; data?: unknown }> {
    return new Promise((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'event' || msg.requestId !== payload.requestId) return;
        sock.off('message', onMessage);
        sock.off('error', onError);
        resolve(msg);
      };
      const onError = (err: Error) => {
        sock.off('message', onMessage);
        sock.off('error', onError);
        reject(err);
      };
      sock.on('message', onMessage);
      sock.on('error', onError);
      sock.send(JSON.stringify(payload));
    });
  }

  async function authedSocket(port: number): Promise<{ sock: WebSocket; wallet: string }> {
    const { walletAddress, sign } = makeWallet();
    const sock = await openSocket(port);
    const nonceReply = (await send(sock, { type: 'request_nonce', walletAddress })) as {
      data: { nonce: string; message: string };
    };
    await send(sock, {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature: sign(nonceReply.data.message),
    });
    return { sock, wallet: walletAddress };
  }

  function makeWagerChainOps(impls: Partial<ChainOpsImplementations>): ChainOps {
    const runtime: AstroidRuntime = {
      chainEnabled: true,
      rpcUrl: 'https://api.devnet.solana.com',
      astroidMint: 'AstroIDMintStubXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      astroidDecimals: 6,
      holderMinBalance: 1,
      holderMinHoldSeconds: 600,
      holderPrewarmEnabled: true,
      holderPrewarmMaxLookback: 100,
      corsAllowedOrigins: ['http://localhost:3000'],
      walletAllowlist: [],
      adminSecret: undefined,
      redisUrl: undefined,
      databaseUrl: undefined,
      port: 0,
    };
    return new ChainOps({ runtime, impls, logger: silentLogger });
  }

  /** Stake at home + join + report drill so the wallet can raid `rich`. */
  async function readyRaider(sock: WebSocket): Promise<void> {
    await send(sock, { type: 'stake', asteroidId: 'home', amount: 500, requestId: 'st' });
    await send(sock, { type: 'join_asteroid', asteroidId: 'home', requestId: 'jn' });
    await send(sock, { type: 'report_drill_power', drillPower: 10_000, requestId: 'dp' });
  }

  it('returns chain_disabled for build_wager_deposit with no ChainOps', async () => {
    const h = await startHarness();
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, {
      type: 'build_wager_deposit',
      targetAsteroidId: 'rich',
      amount: 100,
      requestId: 'w0',
    })) as { type: string; code?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('chain_disabled');
    sock.close();
    await stopHarness(h);
  });

  it('pre-validates the raid and never builds a deposit for a doomed one', async () => {
    let built = 0;
    const chainOps = makeWagerChainOps({
      buildBetEscrowDeposit: async () => {
        built += 1;
        return { transaction: 'deposit-tx-b64', blockhash: 'bh', lastValidBlockHeight: 5 };
      },
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    // No stake → no home station → raid is refused before any deposit.
    const reply = (await send(sock, {
      type: 'build_wager_deposit',
      targetAsteroidId: 'rich',
      amount: 100,
      requestId: 'w1',
    })) as { type: string; code?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('home_station_required');
    expect(built).toBe(0);
    sock.close();
    await stopHarness(h);
  });

  it('build → submit verifies the deposit and launches the escrowed raid', async () => {
    const seen: Array<{ op: string; args: unknown[] }> = [];
    const chainOps = makeWagerChainOps({
      buildBetEscrowDeposit: async (wallet, amount, raidId) => {
        seen.push({ op: 'build', args: [wallet, amount, raidId] });
        return { transaction: 'deposit-tx-b64', blockhash: 'bh', lastValidBlockHeight: 5 };
      },
      verifyBetEscrowDeposit: async (sig, wallet, amount, raidId) => {
        seen.push({ op: 'verify', args: [sig, wallet, amount, raidId] });
        return true;
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    await readyRaider(sock);

    const build = (await send(sock, {
      type: 'build_wager_deposit',
      targetAsteroidId: 'rich',
      amount: 100,
      requestId: 'w2',
    })) as { type: string; data: { transaction: string; amount: number; wagerId: string } };
    expect(build.type).toBe('result');
    expect(build.data.transaction).toBe('deposit-tx-b64');
    expect(build.data.amount).toBe(100);
    const wagerId = build.data.wagerId;
    expect(wagerId).toMatch(/[0-9a-f-]{36}/);

    const submit = await sendResult(sock, {
      type: 'submit_wager_raid',
      signature: 'A'.repeat(88),
      requestId: 'w3',
    });
    expect(submit.type).toBe('result');
    expect((submit.data as { expeditionId: string }).expeditionId).toBeTruthy();

    // The verify ran with the SERVER-trusted wager (wagerId + amount), not the
    // client body, and against the wallet from the connection.
    const verify = seen.find((s) => s.op === 'verify');
    expect(verify!.args).toEqual(['A'.repeat(88), wallet, 100, wagerId]);
    // The raid is live and the escrow ledger booked the wager under the wagerId.
    expect(h.world.expeditions.getAttackerExpedition(wallet)).toBeDefined();
    expect(h.world.betEscrow.getRaidPool(wagerId)!.totalAttackerBets).toBe(100);
    sock.close();
    await stopHarness(h);
  });

  it('rejects submit_wager_raid when no wager was built first', async () => {
    let verified = 0;
    const chainOps = makeWagerChainOps({
      verifyBetEscrowDeposit: async () => {
        verified += 1;
        return true;
      },
    });
    const h = await startHarness({ chainOps });
    const { sock } = await authedSocket(h.port);
    const reply = (await send(sock, {
      type: 'submit_wager_raid',
      signature: 'B'.repeat(88),
      requestId: 'w4',
    })) as { type: string; code?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('rejected');
    expect(verified).toBe(0);
    sock.close();
    await stopHarness(h);
  });

  it('returns the escrow when the raid cannot start after a verified deposit', async () => {
    const returns: Array<[string, number, string]> = [];
    const chainOps = makeWagerChainOps({
      buildBetEscrowDeposit: async () => ({
        transaction: 'deposit-tx-b64',
        blockhash: 'bh',
        lastValidBlockHeight: 5,
      }),
      verifyBetEscrowDeposit: async () => true,
      returnBetEscrow: async (wallet, amount, raidId) => {
        returns.push([wallet, amount, raidId]);
        return 'return-sig';
      },
    });
    const h = await startHarness({ chainOps });
    const { sock, wallet } = await authedSocket(h.port);
    await readyRaider(sock);

    // Build the wager (raid is valid at this point).
    const build = (await send(sock, {
      type: 'build_wager_deposit',
      targetAsteroidId: 'rich',
      amount: 100,
      requestId: 'w5',
    })) as { data: { wagerId: string } };
    const wagerId = build.data.wagerId;

    // Now occupy the wallet with a plain (no-wager) raid so the escrowed raid
    // can't start when we submit.
    const occupy = await sendResult(sock, {
      type: 'start_expedition',
      targetAsteroidId: 'rich',
      betAmount: 0,
      requestId: 'w5b',
    });
    expect(occupy.type).toBe('result');

    const submit = await sendResult(sock, {
      type: 'submit_wager_raid',
      signature: 'C'.repeat(88),
      requestId: 'w6',
    });
    expect(submit.type).toBe('error');
    expect(submit.code).toBe('rejected');
    expect(submit.message).toMatch(/being returned/i);
    // The verified deposit was auto-returned to the wallet.
    expect(returns).toEqual([[wallet, 100, wagerId]]);
    sock.close();
    await stopHarness(h);
  });
});

describe('AstroidGateway lifecycle', () => {
  it('start() and stop() are idempotent', async () => {
    const h = await startHarness();
    expect(() => h.gateway.start()).not.toThrow();
    expect(() => h.gateway.stop()).not.toThrow();
    expect(() => h.gateway.stop()).not.toThrow();
    await new Promise<void>((resolve) => h.httpServer.close(() => resolve()));
  });

  it('broadcastEvent reaches every connected client', async () => {
    const h = await startHarness();
    const sock = await openSocket(h.port);
    const received = new Promise<unknown>((resolve) => {
      sock.once('message', (data) => resolve(JSON.parse(data.toString('utf-8'))));
    });
    h.gateway.broadcastEvent('hello', { msg: 'world' });
    const reply = (await received) as { type: string; event: string; data: { msg: string } };
    expect(reply.type).toBe('event');
    expect(reply.event).toBe('hello');
    expect(reply.data.msg).toBe('world');
    sock.close();
    await stopHarness(h);
  });
});
