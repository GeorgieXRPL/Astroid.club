'use client';

/**
 * ChatDock — the reusable belt-chat surface (header + message list + composer).
 *
 * It's transport-agnostic beyond the `Session`: given a connected session it
 * loads the recent backlog, subscribes to `chat_message` broadcasts, and sends
 * lines via `session.sendChat`. It renders nothing chrome-specific so it can be
 * dropped into a draggable arena panel or a floating popup alike.
 *
 * When `session` is null (not connected) it shows a gentle prompt instead of a
 * dead input — chat requires an authenticated session, which the arena / landing
 * flows establish.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatLine, Session } from '@/lib/session';

/** Keep the client list bounded even on a very chatty channel. */
const CLIENT_MAX_MESSAGES = 250;

export interface ChatDockProps {
  session: Session | null;
  /** The viewer's own wallet, used to right-align + tag their own lines. */
  selfWallet: string | null;
  /** The viewer's current chat handle (from the connect snapshot), if any. */
  selfHandle?: string | null;
  /** Optional close affordance (rendered in the header when provided). */
  onClose?: () => void;
  /** Extra classes for the outer flex column (callers set height/width). */
  className?: string;
  /** Optional prompt shown (with a link) when there is no session. */
  offlineHint?: React.ReactNode;
}

export function ChatDock({
  session,
  selfWallet,
  selfHandle,
  onClose,
  className,
  offlineHint,
}: ChatDockProps) {
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [myHandle, setMyHandle] = useState<string | null>(selfHandle ?? null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Adopt the handle from the connect snapshot when it (re)loads.
  useEffect(() => {
    if (selfHandle !== undefined && selfHandle !== null) setMyHandle(selfHandle);
  }, [selfHandle]);

  // Load backlog + subscribe whenever the session (re)connects.
  useEffect(() => {
    if (!session) {
      setMessages([]);
      return;
    }
    let alive = true;
    setMessages([]);
    session
      .getChatHistory()
      .then((history) => {
        if (alive) setMessages(history.slice(-CLIENT_MAX_MESSAGES));
      })
      .catch(() => {
        /* history is best-effort; live events still flow */
      });

    const off = session.on('chat_message', (data) => {
      const line = data as ChatLine;
      if (!line || typeof line.id !== 'string') return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === line.id)) return prev;
        const next = [...prev, line];
        return next.length > CLIENT_MAX_MESSAGES ? next.slice(-CLIENT_MAX_MESSAGES) : next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [session]);

  // Auto-scroll to the newest line unless the user has scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !session || sending) return;
    setSending(true);
    setError(null);
    try {
      await session.sendChat(text);
      setInput('');
      pinnedToBottom.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [input, session, sending]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const openNameEditor = useCallback(() => {
    setNameInput(myHandle ?? '');
    setNameError(null);
    setEditingName(true);
  }, [myHandle]);

  const saveName = useCallback(async () => {
    const next = nameInput.trim();
    if (!next || !session || savingName) return;
    setSavingName(true);
    setNameError(null);
    try {
      const saved = await session.setHandle(next);
      setMyHandle(saved);
      setEditingName(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Could not set name');
    } finally {
      setSavingName(false);
    }
  }, [nameInput, session, savingName]);

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ''}`}>
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${session ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-white/25'}`}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/60">
            Belt chat
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {session && !editingName && (
            <button
              className="rounded-md border border-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/55 transition hover:border-cosmos/40 hover:text-cosmos"
              onClick={openNameEditor}
              title="Set your chat name"
              type="button"
            >
              {myHandle ?? 'set name'}
            </button>
          )}
          {onClose && (
            <button
              aria-label="Close chat"
              className="rounded-md px-1.5 text-white/45 transition hover:text-white"
              onClick={onClose}
              type="button"
            >
              <span aria-hidden className="text-sm leading-none">
                ×
              </span>
            </button>
          )}
        </div>
      </header>

      {editingName && (
        <div className="border-b border-white/10 bg-space-950/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <input
              autoFocus
              className="field-input min-w-0 flex-1 text-[13px]"
              disabled={savingName}
              maxLength={20}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveName();
                } else if (e.key === 'Escape') {
                  setEditingName(false);
                }
              }}
              placeholder="Pick a name (3–20)"
              value={nameInput}
            />
            <button
              className="shrink-0 rounded-md border border-cosmos/40 bg-cosmos/15 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-cosmos transition hover:bg-cosmos/25 disabled:opacity-40"
              disabled={savingName || !nameInput.trim()}
              onClick={() => void saveName()}
              type="button"
            >
              Save
            </button>
            <button
              className="shrink-0 rounded-md px-1.5 text-white/45 transition hover:text-white"
              onClick={() => setEditingName(false)}
              type="button"
            >
              <span aria-hidden className="text-sm leading-none">
                ×
              </span>
            </button>
          </div>
          {nameError && <p className="mt-1 font-mono text-[10px] text-ember/90">{nameError}</p>}
          <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
            Letters, numbers, underscores · shown next to your messages
          </p>
        </div>
      )}

      <div
        className="flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-3 py-2.5"
        onScroll={onScroll}
        ref={listRef}
      >
        {messages.length === 0 ? (
          <p className="py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
            {session ? 'No messages yet — say hi.' : 'Belt chat is offline.'}
          </p>
        ) : (
          messages.map((m) => (
            <ChatRow
              key={m.id}
              line={m}
              mine={!!selfWallet && m.walletAddress === selfWallet}
              selfHandle={myHandle}
            />
          ))
        )}
      </div>

      {error && (
        <p className="px-3 pb-1 font-mono text-[10px] text-ember/90">{error}</p>
      )}

      {session ? (
        <div className="flex items-center gap-2 border-t border-white/10 p-2">
          <input
            className="field-input min-w-0 flex-1 text-[13px]"
            disabled={sending}
            maxLength={280}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message the belt…"
            value={input}
          />
          <button
            className="shrink-0 rounded-md border border-cosmos/40 bg-cosmos/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-cosmos transition hover:bg-cosmos/25 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={sending || !input.trim()}
            onClick={() => void send()}
            type="button"
          >
            Send
          </button>
        </div>
      ) : (
        <div className="border-t border-white/10 p-3 text-center text-[11px] text-white/50">
          {offlineHint ?? 'Enter the arena to join belt chat.'}
        </div>
      )}
    </div>
  );
}

function ChatRow({
  line,
  mine,
  selfHandle,
}: {
  line: ChatLine;
  mine: boolean;
  selfHandle: string | null;
}) {
  const name = mine
    ? (selfHandle ?? line.handle ?? 'you')
    : (line.handle ?? short(line.walletAddress));
  return (
    <div className="text-[12.5px] leading-snug">
      <span
        className="font-mono text-[11px]"
        style={{ color: mine ? '#00d4ff' : hueFor(line.walletAddress) }}
        title={line.walletAddress}
      >
        {name}
      </span>
      <span className="mx-1.5 text-white/25">·</span>
      <span className="whitespace-pre-wrap break-words text-white/85">{line.text}</span>
    </div>
  );
}

/** First 4 + last 4 of a base58 address. */
function short(addr: string): string {
  return addr.length <= 9 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** Stable, readable handle color derived from the wallet address. */
function hueFor(addr: string): string {
  let h = 0;
  for (let i = 0; i < addr.length; i += 1) h = (h * 31 + addr.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 68%)`;
}
