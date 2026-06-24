'use client';

/**
 * DraggablePanel — desktop-only draggable wrapper for arena HUD panels.
 *
 * Renders its children absolutely positioned and lets the user drag the panel
 * around the screen by a small grab handle in the top-left corner. The position
 * is clamped to the viewport and persisted to localStorage so a player's layout
 * survives reloads. `bumpKey` lets a parent force every panel back to its
 * default position (a "reset HUD" button).
 *
 * This component is meant to live inside a `hidden sm:block` layer — on mobile
 * the arena uses a fixed, scroll-friendly flow layout instead (dragging tiny
 * panels around a phone screen is a worse experience than a tuned layout).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type HudPos = { x: number; y: number };

export interface DraggablePanelProps {
  /** Stable id used as the localStorage key. */
  storageId: string;
  /** Default position, computed from the current viewport size. */
  defaultPos: (vw: number, vh: number) => HudPos;
  /** Bump to force a reset back to {@link defaultPos} (clears nothing itself). */
  bumpKey?: number;
  /** Extra classes for the absolutely-positioned wrapper (e.g. a width). */
  className?: string;
  children: React.ReactNode;
}

const KEY_PREFIX = 'arena.hud.';

/** Remove all persisted HUD positions (used by the reset control). */
export function clearHudLayout(ids: string[]): void {
  try {
    for (const id of ids) localStorage.removeItem(`${KEY_PREFIX}${id}`);
  } catch {
    /* ignore storage errors */
  }
}

export function DraggablePanel({
  storageId,
  defaultPos,
  bumpKey,
  className,
  children,
}: DraggablePanelProps) {
  const [pos, setPos] = useState<HudPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const clamp = useCallback((p: HudPos): HudPos => {
    if (typeof window === 'undefined') return p;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const el = ref.current;
    const w = el?.offsetWidth || 220;
    const margin = 8;
    // Keep the panel on-screen horizontally and keep the grab handle reachable
    // vertically even if the panel itself is very tall.
    const maxX = Math.max(margin, vw - Math.min(w, vw - margin) - margin);
    const maxY = Math.max(margin, vh - 56);
    return {
      x: Math.min(Math.max(margin, p.x), maxX),
      y: Math.min(Math.max(margin, p.y), maxY),
    };
  }, []);

  // Initialise from storage (or the default) on mount and whenever the reset
  // key changes. Reading storage here means a manual reset only needs to clear
  // the key and bump `bumpKey`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let initial: HudPos | null = null;
    try {
      const saved = localStorage.getItem(`${KEY_PREFIX}${storageId}`);
      if (saved) {
        const parsed = JSON.parse(saved) as HudPos;
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) initial = parsed;
      }
    } catch {
      /* ignore */
    }
    if (!initial) initial = defaultPos(window.innerWidth, window.innerHeight);
    setPos(clamp(initial));
    // defaultPos is recreated each render; intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageId, bumpKey, clamp]);

  // Re-clamp on viewport resize so a panel can't end up stranded off-screen.
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !pos) return;
      e.preventDefault();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    },
    [pos],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }));
    },
    [clamp],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      drag.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setPos((p) => {
        if (p) {
          try {
            localStorage.setItem(`${KEY_PREFIX}${storageId}`, JSON.stringify(p));
          } catch {
            /* ignore */
          }
        }
        return p;
      });
    },
    [storageId],
  );

  // Avoid a flash at (0,0) before the position is computed on the client.
  if (!pos) return null;

  return (
    <div
      className={`pointer-events-auto absolute ${className ?? ''}`}
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
    >
      <button
        aria-label="Drag to move panel"
        className="absolute -left-2.5 -top-2.5 z-30 flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded-full border border-white/15 bg-space-950/85 text-white/55 shadow-lg backdrop-blur transition hover:border-cosmos/50 hover:text-white active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        title="Drag to move"
        type="button"
      >
        <span aria-hidden className="text-[13px] leading-none">
          ⠿
        </span>
      </button>
      {children}
    </div>
  );
}
