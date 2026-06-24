'use client';

/**
 * React glue for the `Session` from `./session`.
 *
 * The session lives in a module-level singleton so it survives Next.js
 * route changes (the App Router unmounts pages but keeps modules
 * loaded). `useSession` subscribes to it and re-renders the consumer
 * when the connection state flips.
 *
 * Usage:
 *
 *   const { session, snapshot, connect, disconnect } = useSession();
 *   await session?.send({ type: 'network_stats' });
 *
 * Stays out of any global React Context to avoid surprising the
 * arena bundle (which lives in a separate Vite app and re-mounts
 * the Session through its own glue).
 */

import { useEffect, useState } from 'react';

import {
  connectSession,
  Session,
  SessionError,
  SESSION_CLOSED_EVENT,
  type ConnectSnapshot,
} from './session';
import type { WalletSource } from './wallet-source';

interface SessionStore {
  session: Session | null;
  snapshot: ConnectSnapshot | null;
  state: 'idle' | 'connecting' | 'connected' | 'error';
  error: { code: string; message: string } | null;
}

let store: SessionStore = {
  session: null,
  snapshot: null,
  state: 'idle',
  error: null,
};

const subscribers = new Set<(s: SessionStore) => void>();

// --- Reconnect backoff state ---------------------------------------------
//
// When an *established* session drops unexpectedly we reconnect on an
// exponential backoff (1s, 2s, 4s … capped at 30s) so a flapping socket or a
// brief server restart can't turn into a tight reconnect loop that hammers
// the gateway (and trips its per-IP connection cap). Initial connect failures
// are NOT auto-retried — they surface as `error` for the user to retry — and
// an intentional `disconnect()` cancels any pending reconnect.

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let lastConnect: { wsUrl: string; source: WalletSource } | null = null;
let intentionalClose = false;

function publish(next: SessionStore): void {
  store = next;
  for (const sub of subscribers) sub(store);
}

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Wire the close handler so a dropped session triggers backoff reconnect. */
function wireSession(session: Session): void {
  session.on(SESSION_CLOSED_EVENT, handleSessionClosed);
}

function handleSessionClosed(): void {
  if (intentionalClose) {
    publish({ session: null, snapshot: null, state: 'idle', error: null });
    return;
  }
  // Unexpected drop of an established session: flip to 'connecting' (so the
  // page-level "connect when idle" effects don't also fire) and schedule a
  // backoff reconnect.
  publish({ session: null, snapshot: null, state: 'connecting', error: null });
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (intentionalClose || !lastConnect) return;
  clearReconnect();
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    void attemptReconnect();
  }, delay);
}

async function attemptReconnect(): Promise<void> {
  reconnectTimer = null;
  if (intentionalClose || !lastConnect) return;
  const { wsUrl, source } = lastConnect;
  publish({ ...store, state: 'connecting', error: null });
  try {
    const { session, snapshot } = await connectSession({ wsUrl, source });
    reconnectAttempts = 0;
    wireSession(session);
    publish({ session, snapshot, state: 'connected', error: null });
  } catch (err) {
    const se = err instanceof SessionError ? err : null;
    publish({
      session: null,
      snapshot: null,
      state: 'error',
      error: {
        code: se?.code ?? 'unknown',
        message: se?.message ?? (err instanceof Error ? err.message : String(err)),
      },
    });
    // Keep trying with a growing (capped) backoff so an active miner stays
    // alive across server restarts without spamming the gateway.
    scheduleReconnect();
  }
}

function subscribe(handler: (s: SessionStore) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

export function getSession(): Session | null {
  return store.session;
}

/**
 * Connect (or reuse) the global session for `source`. Idempotent
 * while a session is already open against the same wallet.
 */
export async function connect(wsUrl: string, source: WalletSource): Promise<ConnectSnapshot> {
  // Remember the args so an unexpected drop can reconnect, and treat any
  // explicit connect as cancelling a pending intentional-close / backoff.
  lastConnect = { wsUrl, source };
  intentionalClose = false;
  clearReconnect();

  if (
    store.state === 'connected' &&
    store.session &&
    store.session.walletAddress === source.publicKey
  ) {
    if (store.snapshot) return store.snapshot;
  }
  if (store.session && store.session.getState() === 'connected') {
    store.session.close();
  }

  publish({ ...store, state: 'connecting', error: null });
  try {
    const { session, snapshot } = await connectSession({ wsUrl, source });
    reconnectAttempts = 0;
    wireSession(session);
    publish({ session, snapshot, state: 'connected', error: null });
    return snapshot;
  } catch (err) {
    const se = err instanceof SessionError ? err : null;
    publish({
      session: null,
      snapshot: null,
      state: 'error',
      error: {
        code: se?.code ?? 'unknown',
        message: se?.message ?? (err instanceof Error ? err.message : String(err)),
      },
    });
    // Initial-connect failures are surfaced for a manual retry rather than
    // auto-retried, so a bad wallet / allowlist rejection can't spin forever.
    throw err;
  }
}

export function disconnect(): void {
  intentionalClose = true;
  clearReconnect();
  store.session?.close();
}

/**
 * Subscribe a React component to the session state. Re-renders
 * whenever `connect`, `disconnect`, or a socket close fires.
 */
export function useSession(): SessionStore {
  const [snap, setSnap] = useState<SessionStore>(store);
  useEffect(() => {
    const unsub = subscribe(setSnap);
    setSnap(store);
    return unsub;
  }, []);
  return snap;
}
