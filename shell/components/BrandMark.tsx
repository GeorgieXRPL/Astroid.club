/**
 * Reusable Astroid brand lockup: a "blue dwarf" disc glyph (the same
 * visual language as the site header / favicon) paired with the
 * `ASTROID` wordmark. Used as the in-arena watermark and available for
 * any other surface that wants consistent branding.
 */

interface BrandMarkProps {
  /** Glyph diameter in px. Wordmark scales relative to it. */
  size?: number;
  /** Render the `ASTROID` wordmark next to the glyph. */
  withWordmark?: boolean;
  className?: string;
}

export function BrandMark({ size = 28, withWordmark = true, className }: BrandMarkProps) {
  return (
    <span className={['inline-flex items-center gap-2', className].filter(Boolean).join(' ')}>
      <BrandGlyph size={size} />
      {withWordmark && (
        <span
          className="font-display font-semibold tracking-[0.18em] text-white"
          style={{ fontSize: Math.round(size * 0.5) }}
        >
          ASTRO<span className="text-cosmos">ID</span>
        </span>
      )}
    </span>
  );
}

/** The disc-only mark (no wordmark). */
export function BrandGlyph({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: 'radial-gradient(circle at 30% 30%, #00d4ff 0%, #0353a4 55%, #001233 100%)',
        boxShadow: '0 0 18px rgba(0, 212, 255, 0.45), inset 0 0 6px rgba(255, 255, 255, 0.2)',
      }}
    >
      <span
        className="absolute rounded-full bg-white"
        style={{
          width: Math.max(2, size * 0.18),
          height: Math.max(2, size * 0.18),
          top: size * 0.22,
          left: size * 0.28,
          boxShadow: '0 0 6px white',
        }}
      />
    </span>
  );
}
