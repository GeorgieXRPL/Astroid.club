/**
 * In-memory ring buffer of recent server logs, for the admin console.
 *
 * Every game module logs through the global `console` (discoveries,
 * stakes, claims, raids, reconciliation, errors), so tapping `console`
 * captures the full live activity feed without threading a logger
 * through every constructor. The original console behaviour is
 * preserved (Fly still gets stdout), we just additionally append a
 * capped, queryable copy the admin API can serve.
 *
 * Capacity-bounded (oldest dropped) so memory can't grow unbounded.
 * Never persisted — it's a live tail, not an audit log (the auditable
 * record is the Postgres `yield_events` ledger).
 */

/* eslint-disable no-console -- this module deliberately wraps console.* */
import { format } from 'node:util';

export type LogLevel = 'info' | 'warn' | 'error' | 'log';

export interface LogEntry {
  /** Monotonic id so the client can request "everything after N". */
  id: number;
  ts: number;
  level: LogLevel;
  msg: string;
}

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private nextId = 1;
  private installed = false;
  private original: Partial<Record<LogLevel, (...args: unknown[]) => void>> = {};

  constructor(private readonly capacity = 1500) {}

  /** Record a formatted line. Used by the console tap and directly. */
  push(level: LogLevel, msg: string): void {
    this.entries.push({ id: this.nextId++, ts: Date.now(), level, msg });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /**
   * Recent entries, oldest→newest. `sinceId` returns only entries with a
   * higher id (incremental tailing); `limit` caps the count returned.
   */
  recent(limit = 300, sinceId = 0): LogEntry[] {
    const filtered = sinceId > 0 ? this.entries.filter((e) => e.id > sinceId) : this.entries;
    return filtered.slice(-limit);
  }

  /** Highest id currently buffered (0 when empty). */
  get lastId(): number {
    return this.nextId - 1;
  }

  /**
   * Tee `console.{info,warn,error,log}` into this buffer. Idempotent.
   * The original methods are still called so stdout/Fly logs are intact.
   */
  install(): this {
    if (this.installed) return this;
    this.installed = true;
    for (const level of ['info', 'warn', 'error', 'log'] as const) {
      const original = console[level].bind(console) as (...args: unknown[]) => void;
      this.original[level] = original;
      console[level] = (...args: unknown[]): void => {
        try {
          this.push(level, format(...args));
        } catch {
          /* never let logging crash the caller */
        }
        original(...args);
      };
    }
    return this;
  }

  /** Restore the original console methods (used in tests). */
  uninstall(): void {
    if (!this.installed) return;
    for (const level of ['info', 'warn', 'error', 'log'] as const) {
      const original = this.original[level];
      if (original) console[level] = original as typeof console.info;
    }
    this.original = {};
    this.installed = false;
  }
}
