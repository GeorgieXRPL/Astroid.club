/**
 * Smoke test for the shell's auth handshake.
 *
 * Replicates the handshake from `shell/lib/session.ts` — opens a
 * WebSocket to the server, runs request_nonce → sign → auth, prints
 * the snapshot. Uses the same primitives (tweetnacl, bs58, base64
 * detached signature) so any wire-protocol drift between shell and
 * server is caught here.
 *
 * Run while the server is up on :3002:
 *   node scripts/smoke-shell-auth.mjs
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
      reject(new Error(`no reply for ${payload.requestId}`));
    }, ms);
    function onMessage(raw) {
      let env;
      try {
        env = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (env.requestId !== payload.requestId) return;
      cleanup();
      if (env.type === 'error') reject(new Error(`${env.code}: ${env.message}`));
      else resolve(env.data);
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
  const wallet = bs58.encode(kp.publicKey);
  console.info(`[smoke] wallet: ${wallet}`);
  console.info(`[smoke] connecting to ${WS_URL}`);

  const ws = new WebSocket(WS_URL);
  await awaitOpen(ws, 5_000);
  console.info('[smoke] connected');

  const nonceData = await sendAndAwait(
    ws,
    { type: 'request_nonce', requestId: 'auth-1', walletAddress: wallet },
    5_000,
  );
  console.info(`[smoke] received nonce: ${nonceData.nonce.slice(0, 16)}…`);
  console.info(`[smoke] message to sign: ${nonceData.message}`);

  const signature = signMessage(nonceData.message, kp.secretKey);
  console.info(`[smoke] signature (b64, len=${signature.length}): ${signature.slice(0, 16)}…`);

  const snapshot = await sendAndAwait(
    ws,
    {
      type: 'auth',
      requestId: 'auth-2',
      walletAddress: wallet,
      nonce: nonceData.nonce,
      signature,
    },
    5_000,
  );

  console.info('[smoke] AUTH OK. Connect snapshot:');
  console.info(JSON.stringify(snapshot, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message);
  process.exit(1);
});
