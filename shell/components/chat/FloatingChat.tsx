'use client';

/**
 * FloatingChat — a site-wide pop-up belt chat anchored to the bottom-right.
 *
 * Collapsed, it's a small round bubble; expanded, it's a right-anchored panel
 * containing the shared {@link ChatDock}. It piggybacks on the module-level
 * session singleton (`useSession`), so once a holder has connected (landing or
 * arena flow) chat follows them across every marketing/docs page.
 *
 * Hidden on `/arena`, where chat is a dedicated draggable HUD panel instead —
 * avoids doubling up (and colliding with the arena's own bottom-right controls).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useSession } from '@/lib/use-session';

import { ChatDock } from './ChatDock';

export function FloatingChat() {
  const pathname = usePathname();
  const { session, snapshot } = useSession();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  // Track unread lines while the popup is closed (skip our own messages).
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!session) return;
    const off = session.on('chat_message', (data) => {
      const line = data as { walletAddress?: string };
      if (openRef.current) return;
      if (line?.walletAddress && line.walletAddress === session.walletAddress) return;
      setUnread((n) => Math.min(n + 1, 99));
    });
    return off;
  }, [session]);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  // On the arena, desktop hosts chat in a dedicated draggable HUD panel, so the
  // floating copy is suppressed there (`sm:hidden`) to avoid doubling up and
  // colliding with the arena's own bottom-right controls. Mobile arena has no
  // room for the panel, so the floating bubble stays available there.
  const onArena = pathname?.startsWith('/arena');

  return (
    <div
      className={`pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 sm:bottom-6 sm:right-6 ${onArena ? 'sm:hidden' : ''}`}
    >
      {open && (
        <div className="glass-panel-bright pointer-events-auto flex h-[min(60vh,460px)] w-[min(92vw,360px)] flex-col overflow-hidden shadow-2xl">
          <ChatDock
            className="h-full"
            offlineHint={
              <>
                <Link className="text-cosmos hover:underline" href="/">
                  Verify &amp; connect
                </Link>{' '}
                to join belt chat.
              </>
            }
            onClose={() => setOpen(false)}
            selfHandle={snapshot?.handle ?? null}
            selfWallet={session?.walletAddress ?? null}
            session={session}
          />
        </div>
      )}

      <button
        aria-label={open ? 'Close belt chat' : 'Open belt chat'}
        className="pointer-events-auto relative flex h-12 w-12 items-center justify-center rounded-full border border-cosmos/40 bg-space-950/85 text-cosmos shadow-lg backdrop-blur transition hover:border-cosmos hover:bg-space-900/90"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        {open ? <CloseGlyph /> : <ChatGlyph />}
        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-ember px-1 font-mono text-[10px] font-semibold text-space-950">
            {unread}
          </span>
        )}
      </button>
    </div>
  );
}

function ChatGlyph() {
  return (
    <svg aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path
        d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}
