'use client';

/**
 * Preview modal for a generated share card (roadmap §3.4). Shows the rendered
 * PNG and lets the player explicitly choose what to do with it — copy, download,
 * or open a pre-filled X post — instead of a surprise auto-download. When the
 * card `spec` is provided, the player can also restyle the card with their own
 * background image (re-rendered client-side; nothing is uploaded anywhere).
 */

import { useEffect, useRef, useState } from 'react';

import type { ShareCardSpec } from '@/lib/share-card';
import { copyCard, downloadCard, openShareIntent, renderShareCard } from '@/lib/share-card';

export interface ShareCardModalProps {
  blob: Blob;
  tweet: string;
  kind: string;
  title: string;
  /** Phase-2 /share?… link X unfurls with the server-rendered card preview. */
  shareUrl?: string;
  /** Card data; enables the custom-background restyle controls when present. */
  spec?: ShareCardSpec;
  onClose: () => void;
}

export function ShareCardModal({
  blob,
  tweet,
  kind,
  title,
  shareUrl,
  spec,
  onClose,
}: ShareCardModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  // The blob currently previewed/exported: the classic render by default,
  // swapped for a custom-background re-render when the player picks an image.
  const [activeBlob, setActiveBlob] = useState(blob);
  const [isCustom, setIsCustom] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [restyleError, setRestyleError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setActiveBlob(blob);
    setIsCustom(false);
  }, [blob]);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(activeBlob);
    setUrl(objectUrl);
    setCopied(false);
    setDownloaded(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [activeBlob]);

  const onPickBackground = async (file: File | undefined) => {
    if (!file || !spec) return;
    setRestyling(true);
    setRestyleError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      setActiveBlob(await renderShareCard(spec, { backgroundSrc: dataUrl }));
      setIsCustom(true);
    } catch {
      setRestyleError('Could not use that image. Try a JPG or PNG.');
    } finally {
      setRestyling(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onCopy = async () => {
    const ok = await copyCard(activeBlob);
    setCopied(ok);
    if (!ok) {
      // Clipboard image write unsupported (e.g. Firefox/Safari) — fall back.
      downloadCard(activeBlob, kind);
      setDownloaded(true);
    }
  };

  const onDownload = () => {
    downloadCard(activeBlob, kind);
    setDownloaded(true);
  };

  return (
    <div
      aria-label={title}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="glass-panel-bright w-full max-w-xl overflow-hidden rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cosmos">{title}</p>
          <button
            aria-label="Close"
            className="rounded p-1 font-mono text-white/50 transition hover:text-white"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt="Shareable card preview"
              className="w-full rounded-lg border border-white/10 shadow-[0_8px_40px_-12px_rgba(0,212,255,0.4)]"
              src={url}
            />
          ) : (
            <div className="flex h-48 items-center justify-center font-mono text-[11px] text-white/40">
              Rendering…
            </div>
          )}

          {spec ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                Card style
              </span>
              <button
                className={`rounded-md border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition ${
                  !isCustom
                    ? 'border-cosmos/50 bg-cosmos/15 text-cosmos'
                    : 'border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]'
                }`}
                onClick={() => {
                  setActiveBlob(blob);
                  setIsCustom(false);
                  setRestyleError(null);
                }}
                type="button"
              >
                Classic
              </button>
              <button
                className={`rounded-md border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition ${
                  isCustom
                    ? 'border-cosmos/50 bg-cosmos/15 text-cosmos'
                    : 'border-white/15 bg-white/[0.04] text-white/70 hover:bg-white/[0.08]'
                }`}
                disabled={restyling}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                {restyling ? 'Rendering…' : isCustom ? 'Change image…' : 'Custom image…'}
              </button>
              <input
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void onPickBackground(e.target.files?.[0]);
                  e.target.value = '';
                }}
                ref={fileInputRef}
                type="file"
              />
              {restyleError ? (
                <span className="font-mono text-[10px] text-red-400">{restyleError}</span>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-3 gap-2">
            <button
              className="rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-white/80 transition hover:bg-white/[0.08]"
              onClick={onCopy}
              type="button"
            >
              {copied ? 'Copied ✓' : 'Copy image'}
            </button>
            <button
              className="rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-white/80 transition hover:bg-white/[0.08]"
              onClick={onDownload}
              type="button"
            >
              {downloaded ? 'Saved ✓' : 'Download'}
            </button>
            <button
              className="rounded-md border border-cosmos/40 bg-cosmos/10 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-cosmos transition hover:bg-cosmos/20"
              onClick={() => openShareIntent(tweet, shareUrl)}
              type="button"
            >
              Share to X
            </button>
          </div>

          <p className="mt-3 font-mono text-[10px] leading-relaxed text-white/40">
            Share to X opens a post linking your card. It unfurls with this preview. Want it inline
            instead? Copy or download and attach it.
          </p>
        </div>
      </div>
    </div>
  );
}
