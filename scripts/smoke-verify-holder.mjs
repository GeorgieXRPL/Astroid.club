/**
 * Smoke test for the verify_holder slice.
 *
 * Auths a fresh wallet against the running gateway and runs the
 * `verify_holder` round-trip. With the default `CHAIN_ENABLED=false`
 * boot, this should always come back as `eligible: true` /
 * `reason: chain_disabled` — the dev-mode pass-through. With
 * CHAIN_ENABLED=true and a real wallet, it should reflect the
 * actual on-chain check.
 *
 * Run while the server is up:
 *   node scripts/smoke-verify-holder.mjs
 */

import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { WebSocket } from 'ws';

const WS_URL = process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002';

function signMessage(message, secretKey) {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
  return Buffer.from(sig).toString('base64');
}

function awaitOpen(ws, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), ms);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function sendAndAwait(ws, payload, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
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
      cleanup();
      resolve(env);
    }
    function cleanup() {
      clearTimeout(t);
      ws.off('message', onMessage);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify(payload));
  });
}

async function main() {
  const kp = nacl.sign.keyPair();
  const walletAddress = bs58.encode(kp.publicKey);
  console.info(`[smoke] wallet: ${walletAddress}`);
  console.info(`[smoke] connecting to ${WS_URL}`);

  const ws = new WebSocket(WS_URL);
  await awaitOpen(ws, 5_000);
  console.info('[smoke] connected');

  const nonceReply = await sendAndAwait(
    ws,
    { type: 'request_nonce', walletAddress, requestId: 'n1' },
    5_000,
  );
  if (nonceReply.type !== 'result') {
    console.error('[smoke] FAIL nonce step:', nonceReply);
    process.exit(1);
  }
  console.info(`[smoke] nonce ok: ${nonceReply.data.nonce.slice(0, 16)}\u2026`);

  const authReply = await sendAndAwait(
    ws,
    {
      type: 'auth',
      walletAddress,
      nonce: nonceReply.data.nonce,
      signature: signMessage(nonceReply.data.message, kp.secretKey),
      requestId: 'a1',
    },
    5_000,
  );
  if (authReply.type !== 'result') {
    console.error('[smoke] FAIL auth step:', authReply);
    process.exit(1);
  }
  console.info('[smoke] auth ok');

  const verifyReply = await sendAndAwait(ws, { type: 'verify_holder', requestId: 'v1' }, 5_000);
  if (verifyReply.type !== 'result') {
    console.error('[smoke] FAIL verify_holder:', verifyReply);
    process.exit(1);
  }
  console.info('[smoke] verify_holder ok:');
  console.info(JSON.stringify(verifyReply.data, null, 2));

  ws.close();
  if (verifyReply.data.walletAddress !== walletAddress) {
    console.error('[smoke] FAIL wallet mismatch (expected', walletAddress, ')');
    process.exit(1);
  }
  if (typeof verifyReply.data.eligible !== 'boolean') {
    console.error('[smoke] FAIL eligible is not boolean');
    process.exit(1);
  }
  console.info('[smoke] PASS');
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
