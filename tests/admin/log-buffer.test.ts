/**
 * Unit tests for the admin log ring buffer.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { LogBuffer } from '../../server/admin/log-buffer.js';

describe('LogBuffer', () => {
  let installed: LogBuffer | undefined;

  afterEach(() => {
    installed?.uninstall();
    installed = undefined;
  });

  it('records entries with monotonic ids and timestamps', () => {
    const buf = new LogBuffer();
    buf.push('info', 'a');
    buf.push('warn', 'b');
    const recent = buf.recent();
    expect(recent.map((e) => e.msg)).toEqual(['a', 'b']);
    expect(recent[0]!.id).toBe(1);
    expect(recent[1]!.id).toBe(2);
    expect(recent[1]!.level).toBe('warn');
    expect(buf.lastId).toBe(2);
  });

  it('caps at capacity, dropping the oldest', () => {
    const buf = new LogBuffer(3);
    for (let i = 0; i < 6; i++) buf.push('info', String(i));
    const recent = buf.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.msg)).toEqual(['3', '4', '5']);
    // ids keep climbing even though older entries were dropped.
    expect(buf.lastId).toBe(6);
  });

  it('returns only entries after sinceId', () => {
    const buf = new LogBuffer();
    buf.push('info', 'one');
    buf.push('info', 'two');
    buf.push('info', 'three');
    expect(buf.recent(100, 1).map((e) => e.msg)).toEqual(['two', 'three']);
    expect(buf.recent(100, 3)).toEqual([]);
  });

  it('honours the limit argument', () => {
    const buf = new LogBuffer();
    for (let i = 0; i < 10; i++) buf.push('info', String(i));
    expect(buf.recent(2).map((e) => e.msg)).toEqual(['8', '9']);
  });

  it('tees console output into the buffer while preserving stdout', () => {
    const buf = new LogBuffer();
    const original = console.info;
    let passthrough: unknown[] = [];
    console.info = ((...args: unknown[]) => {
      passthrough = args;
    }) as typeof console.info;
    // Re-install over our spy so the buffer wraps it.
    installed = buf.install();

    console.info('hello %s', 'world');

    // The original (our spy) still receives the raw, unformatted args…
    expect(passthrough).toEqual(['hello %s', 'world']);
    // …while the buffer stores the util.format-rendered line.
    expect(buf.recent().some((e) => e.msg === 'hello world' && e.level === 'info')).toBe(true);

    buf.uninstall();
    console.info = original;
    installed = undefined;
  });
});
