/**
 * Full gameplay smoke: auth, then drive the core game actions the arena
 * UI calls (join_asteroid, set_home_station, stake, miner_snapshot) and
 * print the evolving snapshot. Proves the backend game loop end-to-end,
 * independent of the browser. Run while the gateway is up:
 *   node scripts/smoke-gameplay.mjs
 */

import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { WebSocket } from 'ws';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';

function sign(message, secretKey) {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString(
    'base64',
  );
}

function rpc(ws, payload, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`no reply for ${payload.requestId ?? payload.type}`));
    }, ms);
    function onMessage(raw) {
      let env;
      try {
        env = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (payload.requestId && env.requestId && env.requestId !== payload.requestId) return;
      clearTimeout(t);
      ws.off('message', onMessage);
      resolve(env);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify(payload));
  });
}

function open(ws, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), ms);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', reject);
  });
}

let id = 0;
const next = () => `r${++id}`;

function expectOk(label, env) {
  if (env.type !== 'result') {
    console.error(`[smoke] FAIL ${label}:`, JSON.stringify(env));
    process.exit(1);
  }
  console.info(`[smoke] ${label} ok`);
  return env.data;
}

async function main() {
  const kp = nacl.sign.keyPair();
  const walletAddress = bs58.encode(kp.publicKey);
  console.info(`[smoke] wallet ${walletAddress}`);

  const ws = new WebSocket(WS_URL);
  await open(ws);

  const nonce = expectOk('request_nonce', await rpc(ws, { type: 'request_nonce', walletAddress, requestId: next() }));
  expectOk(
    'auth',
    await rpc(ws, {
      type: 'auth',
      walletAddress,
      nonce: nonce.nonce,
      signature: sign(nonce.message, kp.secretKey),
      requestId: next(),
    }),
  );

  const before = expectOk('miner_snapshot (initial)', await rpc(ws, { type: 'miner_snapshot', requestId: next() }));
  const target = before.asteroids[0];
  console.info(`[smoke] target asteroid: ${target.name} (${target.id})`);

  expectOk('set_home_station', await rpc(ws, { type: 'set_home_station', asteroidId: target.id, requestId: next() }));
  expectOk('join_asteroid', await rpc(ws, { type: 'join_asteroid', asteroidId: target.id, requestId: next() }));
  expectOk('report_drill_power', await rpc(ws, { type: 'report_drill_power', drillPower: 5000, requestId: next() }));
  expectOk('stake', await rpc(ws, { type: 'stake', asteroidId: target.id, amount: 500, requestId: next() }));

  const after = expectOk('miner_snapshot (after actions)', await rpc(ws, { type: 'miner_snapshot', requestId: next() }));
  const stats = expectOk('network_stats', await rpc(ws, { type: 'network_stats', requestId: next() }));

  console.info('[smoke] post-action state:');
  console.info(
    JSON.stringify(
      {
        home: after.homeStationAsteroidId,
        mining: after.activeAsteroidId,
        totalStake: after.totalStake,
        pendingYield: after.pendingYield,
        networkMiners: stats.totalMiners,
        networkStake: stats.totalStake,
      },
      null,
      2,
    ),
  );

  ws.close();
  if (after.homeStationAsteroidId !== target.id || after.activeAsteroidId !== target.id) {
    console.error('[smoke] FAIL: home/mining did not stick');
    process.exit(1);
  }
  if (!(after.totalStake >= 500)) {
    console.error('[smoke] FAIL: stake not reflected');
    process.exit(1);
  }
  console.info('[smoke] PASS — full game loop works end-to-end');
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
