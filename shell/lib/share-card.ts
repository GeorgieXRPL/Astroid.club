/**
 * Shareable "PNL" cards (roadmap §3.4, Phase 1).
 *
 * Renders a branded 1200×630 card to an offscreen <canvas>, then offers it for
 * download / clipboard and opens an X (Twitter) share intent. Phase 1 is fully
 * client-side — no backend — so it ships without touching the gateway. The X
 * intent can't auto-attach an image, so the flow downloads (and best-effort
 * copies) the PNG and the user attaches it to the pre-filled post. Phase 2
 * (server-rendered OG images so links unfurl with the preview) can reuse the
 * same {@link ShareCardSpec} shape.
 */

import type { ConnectSnapshot, NetworkStatsSnapshot } from './session';

const W = 1200;
const H = 630;
// Card mascot art. The source has a solid black background; the card draws it
// with a 'lighten' composite so the black drops out cleanly against the dark
// card (no cropping / cutout artifacts needed).
const MASCOT_SRC = '/mascot-card.png';
const SHARE_URL = 'https://astroid.club';

type Tone = 'good' | 'bad' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  good: '#34e0a1',
  bad: '#ff6f61',
  neutral: '#00d4ff',
};

export interface ShareStat {
  label: string;
  value: string;
}

export interface ShareCardSpec {
  kind: 'miner' | 'raid' | 'meteor';
  /** Small uppercase label, e.g. "RAID REPORT". */
  eyebrow: string;
  /** Large headline (wraps to 2 lines). */
  headline: string;
  /** Hero stat shown big under the headline. */
  accent?: { value: string; label: string; tone?: Tone };
  /** Up to four key/value rows. */
  stats: ShareStat[];
  tagline?: string;
  /** Epoch ms when the card was generated; rendered as a date/time stamp. */
  generatedAt?: number;
}

/** Rendering options independent of the card data. */
export interface ShareCardRenderOptions {
  /**
   * Custom background art (a path or data URL, e.g. from a file the player
   * picked). Drawn cover-fit with a legibility scrim; replaces the default
   * starfield + mascot.
   */
  backgroundSrc?: string | null;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

let mascotPromise: Promise<HTMLImageElement | null> | null = null;

function loadMascot(): Promise<HTMLImageElement | null> {
  mascotPromise ??= loadImage(MASCOT_SRC);
  return mascotPromise;
}

/** "07/07/2026 · 09:21 UTC" — stable regardless of viewer locale. */
export function formatGeneratedAt(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}` +
    ` · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The "blue dwarf" disc brand glyph, matching `BrandMark`. */
function drawGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#00d4ff');
  g.addColorStop(0.55, '#0353a4');
  g.addColorStop(1, '#001233');
  ctx.save();
  ctx.shadowColor = 'rgba(0,212,255,0.55)';
  ctx.shadowBlur = r * 0.9;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx - r * 0.22, cy - r * 0.28, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/** Render the card to a PNG blob. */
export async function renderShareCard(
  spec: ShareCardSpec,
  options: ShareCardRenderOptions = {},
): Promise<Blob> {
  // Make sure web fonts are ready so text measures/renders consistently.
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* non-fatal */
    }
  }
  const background = options.backgroundSrc ? await loadImage(options.backgroundSrc) : null;
  const mascot = background ? null : await loadMascot();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const sans = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, "Roboto Mono", monospace';

  if (background && background.width > 0) {
    // Custom art: cover-fit the image, then lay a left-to-right scrim so the
    // stats column stays legible over any artwork.
    const scale = Math.max(W / background.width, H / background.height);
    const dw = background.width * scale;
    const dh = background.height * scale;
    ctx.drawImage(background, (W - dw) / 2, (H - dh) / 2, dw, dh);

    const scrim = ctx.createLinearGradient(0, 0, W * 0.72, 0);
    scrim.addColorStop(0, 'rgba(4,5,10,0.88)');
    scrim.addColorStop(0.62, 'rgba(4,5,10,0.62)');
    scrim.addColorStop(1, 'rgba(4,5,10,0)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
    // Bottom fade keeps the footer readable.
    const bottom = ctx.createLinearGradient(0, H - 160, 0, H);
    bottom.addColorStop(0, 'rgba(4,5,10,0)');
    bottom.addColorStop(1, 'rgba(4,5,10,0.72)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, H - 160, W, 160);
  } else {
    // Background: deep space gradient + cyan glow + vignette + stars.
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#070912');
    bg.addColorStop(1, '#04050a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W * 0.78, H * 0.32, 40, W * 0.78, H * 0.32, 620);
    glow.addColorStop(0, 'rgba(0,212,255,0.16)');
    glow.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Deterministic starfield so the card is stable.
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 140; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = rand() * 1.3 + 0.2;
      ctx.globalAlpha = 0.12 + rand() * 0.4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Inner border frame.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  roundRect(ctx, 24, 24, W - 48, H - 48, 28);
  ctx.stroke();

  // Mascot, bottom-right (default background only). The source art (dog on a
  // rocket) sits inside a 500×500 black canvas with heavy padding, so drawing
  // the whole image makes the mascot look tiny. Draw just the art's bounding
  // box, scaled large; the 'lighten' composite keys out the remaining black
  // against the dark card.
  if (mascot && mascot.width > 0) {
    const src = { x: 84, y: 164, w: 286, h: 178 };
    const targetW = 600;
    const scale = targetW / src.w;
    const mw = src.w * scale;
    const mh = src.h * scale;
    ctx.save();
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(mascot, src.x, src.y, src.w, src.h, W - mw - 24, H - mh - 32, mw, mh);
    ctx.restore();
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const padX = 70;
  // Text column is kept clear of the (now much larger) mascot, which starts at
  // x ≈ 576 (W - targetW - 24).
  const headlineWidth = 470;

  // Brand lockup, top-left.
  drawGlyph(ctx, padX + 14, 64, 15);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 24px ${sans}`;
  ctx.fillText('ASTRO', padX + 36, 72);
  const astroW = ctx.measureText('ASTRO').width;
  ctx.fillStyle = TONE_COLOR.neutral;
  ctx.fillText('ID', padX + 36 + astroW, 72);

  // Generated timestamp, top-right (inside the frame).
  if (spec.generatedAt) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `600 15px ${mono}`;
    ctx.fillText(formatGeneratedAt(spec.generatedAt), W - padX, 72);
    ctx.restore();
  }

  // Eyebrow.
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `600 16px ${mono}`;
  ctx.fillText(spec.eyebrow.toUpperCase(), padX, 150);

  // Headline (up to 2 lines), fixed line rhythm.
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 52px ${sans}`;
  const headLines = wrapLines(ctx, spec.headline, headlineWidth, 2);
  const headLineHeight = 60;
  headLines.forEach((line, i) => {
    ctx.fillText(line, padX, 206 + i * headLineHeight);
  });
  const headBottom = 206 + (headLines.length - 1) * headLineHeight;

  // Accent hero stat, anchored under the headline.
  if (spec.accent) {
    const accentY = headBottom + 78;
    const tone = TONE_COLOR[spec.accent.tone ?? 'neutral'];
    ctx.fillStyle = tone;
    ctx.font = `800 64px ${mono}`;
    ctx.fillText(spec.accent.value, padX, accentY);
    const vW = ctx.measureText(spec.accent.value).width;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `600 19px ${mono}`;
    ctx.fillText(spec.accent.label, padX + vW + 16, accentY);
  }

  // Stat rows (2-up grid) on a fixed band so they never collide with the
  // headline above or the footer below.
  const stats = spec.stats.slice(0, 4);
  const colW = 245;
  const statsTop = 404;
  const rowH = 76;
  stats.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = padX + col * colW;
    const sy = statsTop + row * rowH;
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = `600 13px ${mono}`;
    ctx.fillText(s.label.toUpperCase(), sx, sy);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 25px ${mono}`;
    ctx.fillText(s.value, sx, sy + 32);
  });

  // Footer (kept inside the border frame).
  ctx.fillStyle = TONE_COLOR.neutral;
  ctx.font = `700 19px ${sans}`;
  ctx.fillText('astroid.club', padX, 566);
  if (spec.tagline) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `500 15px ${sans}`;
    const tW = ctx.measureText('astroid.club').width;
    ctx.fillText(`· ${spec.tagline}`, padX + tW + 12, 566);
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode card PNG'));
    }, 'image/png');
  });
}

/** Trigger a browser download of the card PNG. */
export function downloadCard(blob: Blob, kind: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `astroid-${kind}-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Best-effort copy of the card PNG to the clipboard. Returns success. */
export async function copyCard(blob: Blob): Promise<boolean> {
  try {
    const ClipboardItemCtor = (
      globalThis as { ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem }
    ).ClipboardItem;
    if (ClipboardItemCtor && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': blob })]);
      return true;
    }
  } catch {
    /* clipboard is best-effort */
  }
  return false;
}

/**
 * Open a pre-filled X (Twitter) post in a new tab. `shareUrl` is the link X
 * unfurls — pass a Phase-2 `/share?…` URL so the post shows the card preview;
 * defaults to the site root.
 */
export function openShareIntent(tweetText: string, shareUrl: string = SHARE_URL): void {
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    tweetText,
  )}&url=${encodeURIComponent(shareUrl)}`;
  window.open(intent, '_blank', 'noopener,noreferrer');
}

/**
 * Encode a card spec into URL query params (Phase 2). The `/share` page and its
 * `/share/og` image route decode these to re-render the card server-side so
 * shared links unfurl with the preview. Kept compact and lossless for the
 * fields the OG renderer needs.
 */
export function encodeShareParams(spec: ShareCardSpec): string {
  const p = new URLSearchParams();
  p.set('k', spec.kind);
  p.set('e', spec.eyebrow);
  p.set('h', spec.headline);
  if (spec.accent) {
    p.set('av', spec.accent.value);
    p.set('al', spec.accent.label);
    if (spec.accent.tone) p.set('at', spec.accent.tone);
  }
  if (spec.stats.length) {
    p.set('s', spec.stats.map((s) => `${s.label}~${s.value}`).join('||'));
  }
  if (spec.tagline) p.set('tg', spec.tagline);
  if (spec.generatedAt) p.set('ga', String(spec.generatedAt));
  return p.toString();
}

/** Decode `/share` query params back into a card spec (Phase 2, server-side). */
export function decodeShareParams(params: URLSearchParams): ShareCardSpec {
  const kind = (params.get('k') as ShareCardSpec['kind']) || 'miner';
  const av = params.get('av');
  const al = params.get('al');
  const stats: ShareStat[] = (params.get('s') ?? '')
    .split('||')
    .filter(Boolean)
    .map((pair) => {
      const [label, value] = pair.split('~');
      return { label: label ?? '', value: value ?? '' };
    })
    .slice(0, 4);
  return {
    kind,
    eyebrow: params.get('e') ?? 'Astroid',
    headline: params.get('h') ?? 'astroid.club',
    accent:
      av && al
        ? { value: av, label: al, tone: (params.get('at') as Tone) || 'neutral' }
        : undefined,
    stats,
    tagline: params.get('tg') ?? undefined,
    generatedAt: Number(params.get('ga')) > 0 ? Number(params.get('ga')) : undefined,
  };
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Build a miner "PNL" / run-summary card from the connect snapshot. */
export function minerCardSpec(
  snapshot: ConnectSnapshot,
  stats: NetworkStatsSnapshot | null,
): ShareCardSpec {
  const net = snapshot.lifetimeEarned;
  const days = snapshot.loyaltyDays;
  return {
    kind: 'miner',
    // "Mining day N" counts the current day (day 1 while loyaltyDays is 0).
    eyebrow: `Mining report · Day ${fmtNum(days + 1)}`,
    headline: 'My $ASTROID mining run',
    accent: { value: fmtNum(net), label: '$ASTROID earned', tone: 'good' },
    stats: [
      { label: 'Claimable now', value: fmtNum(snapshot.pendingYield) },
      { label: 'Staked', value: fmtNum(snapshot.totalStake) },
      { label: 'Claimed', value: fmtNum(snapshot.lifetimeRedeemed) },
      { label: 'Mining for', value: `${fmtNum(days)} day${days === 1 ? '' : 's'}` },
    ],
    tagline: stats ? `${fmtNum(stats.totalMiners)} miners in the belt` : 'Mine. Raid. Defend.',
    generatedAt: Date.now(),
  };
}

/** Build a raid-outcome card. */
export function raidCardSpec(params: {
  won: boolean;
  stolenYield: number;
  targetName: string;
  betAmount?: number;
}): ShareCardSpec {
  const { won, stolenYield, targetName, betAmount } = params;
  const stats: ShareStat[] = [
    { label: 'Target', value: targetName },
    { label: 'Outcome', value: won ? 'Victory' : 'Repelled' },
  ];
  if (betAmount && betAmount > 0) stats.push({ label: 'Stake risked', value: fmtNum(betAmount) });
  return {
    kind: 'raid',
    eyebrow: 'Raid report',
    headline: won ? `Raided ${targetName}` : `Repelled at ${targetName}`,
    accent: won
      ? { value: `+${fmtNum(stolenYield)}`, label: '$ASTROID looted', tone: 'good' }
      : { value: 'No loot', label: 'defense held', tone: 'bad' },
    stats,
    tagline: won ? 'The belt is mine.' : "I'll be back.",
    generatedAt: Date.now(),
  };
}
