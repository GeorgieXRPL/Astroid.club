'use client';

/**
 * Public status page.
 *
 * Polls the gateway's `/health` endpoint and renders a green / amber / red
 * pill plus a small detail panel (latency, last-checked timestamp, chain
 * posture). Auto-refreshes every 30 s and exposes a manual refresh button
 * so visitors can verify state without waiting.
 *
 * The page is intentionally simple. If the gateway is unreachable the
 * card reads "Down" with the failure reason; if `/health` returns 200 OK
 * but reports something unusual we still render an "Operational" pill so
 * the user gets a clear signal in the common case.
 *
 * No analytics, no third-party calls — just the gateway's own probe.
 */

import { useCallback, useEffect, useState } from 'react';

interface HealthOk {
  status: string;
  chainEnabled?: boolean;
  server?: string;
}

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: HealthOk; latencyMs: number; checkedAt: number }
  | { kind: 'down'; reason: string; checkedAt: number };

const HTTP_URL =
  process.env.NEXT_PUBLIC_ASTROID_HTTP_URL ?? 'http://localhost:3002';
const REFRESH_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

export default function StatusPage() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });
  const [refreshTick, setRefreshTick] = useState(0);

  const probe = useCallback(async () => {
    setState({ kind: 'loading' });
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${HTTP_URL}/health`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });

      const latencyMs = Math.round(performance.now() - startedAt);

      if (!response.ok) {
        setState({
          kind: 'down',
          reason: `HTTP ${response.status} ${response.statusText}`,
          checkedAt: Date.now(),
        });
        return;
      }

      const data = (await response.json()) as HealthOk;
      setState({ kind: 'ok', data, latencyMs, checkedAt: Date.now() });
    } catch (error) {
      const reason =
        error instanceof DOMException && error.name === 'AbortError'
          ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      setState({ kind: 'down', reason, checkedAt: Date.now() });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void probe();
    const id = setInterval(() => {
      setRefreshTick((n) => n + 1);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [probe]);

  useEffect(() => {
    if (refreshTick === 0) return;
    void probe();
  }, [refreshTick, probe]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12 sm:px-8 sm:py-16">
      <header className="mb-8">
        <p className="telemetry-label mb-2">System status</p>
        <h1 className="font-display text-3xl tracking-tight text-white sm:text-4xl">
          astroid<span className="text-cosmos">.</span>club status
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/60">
          Live ping of the gateway behind the holder console. Refreshes every
          {' '}
          {REFRESH_INTERVAL_MS / 1000} s automatically.
        </p>
      </header>

      <GatewayCard state={state} onRefresh={probe} />

      <footer className="mt-10 text-xs leading-relaxed text-white/40">
        This page only checks the public gateway probe. It does not reflect
        Solana RPC, Helius, or Vercel availability. If the page itself
        loaded, the shell layer is up.
      </footer>
    </div>
  );
}

function GatewayCard({
  state,
  onRefresh,
}: {
  state: HealthState;
  onRefresh: () => void;
}) {
  const tone = toneFor(state);

  return (
    <section
      aria-label="Gateway status"
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 backdrop-blur-sm sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Pill tone={tone.tone}>{tone.label}</Pill>
          <span className="font-mono text-sm text-white/65">Gateway</span>
        </div>
        <button
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={onRefresh}
          type="button"
        >
          {state.kind === 'loading' ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <DetailRow label="Endpoint" value={`${HTTP_URL}/health`} mono />
        <DetailRow label="Last check" value={lastCheckLabel(state)} mono />
        <DetailRow label="Latency" value={latencyLabel(state)} mono />
        <DetailRow label="Chain posture" value={chainLabel(state)} mono />
      </dl>

      {state.kind === 'down' && (
        <p className="mt-6 rounded-xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-100/90">
          <span className="font-mono text-red-200">reason:</span> {state.reason}
        </p>
      )}
    </section>
  );
}

function toneFor(state: HealthState): { tone: 'green' | 'amber' | 'red'; label: string } {
  if (state.kind === 'loading') return { tone: 'amber', label: 'Checking' };
  if (state.kind === 'down') return { tone: 'red', label: 'Down' };
  return { tone: 'green', label: 'Operational' };
}

function lastCheckLabel(state: HealthState): string {
  if (state.kind === 'loading') return '…';
  return new Date(state.checkedAt).toLocaleTimeString();
}

function latencyLabel(state: HealthState): string {
  if (state.kind !== 'ok') return 'n/a';
  return `${state.latencyMs} ms`;
}

function chainLabel(state: HealthState): string {
  if (state.kind !== 'ok') return 'n/a';
  if (state.data.chainEnabled === undefined) return 'unknown';
  return state.data.chainEnabled ? 'on (read-only)' : 'off';
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="telemetry-label mb-1">{label}</dt>
      <dd className={`text-white/85 ${mono ? 'font-mono text-sm' : ''}`}>{value}</dd>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red'; children: string }) {
  const palette = {
    green: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-400/40 bg-amber-500/10 text-amber-200',
    red: 'border-red-500/40 bg-red-500/10 text-red-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.18em] ${palette[tone]}`}
    >
      <Dot tone={tone} />
      {children}
    </span>
  );
}

function Dot({ tone }: { tone: 'green' | 'amber' | 'red' }) {
  const fill = {
    green: '#34d399',
    amber: '#fbbf24',
    red: '#f87171',
  }[tone];
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-full"
      style={{
        backgroundColor: fill,
        boxShadow: `0 0 8px ${fill}`,
      }}
    />
  );
}
