/**
 * Open Graph social-share image (1200x630 PNG, generated at build time).
 *
 * Used when the site is linked on Twitter/X, Discord, Slack, Telegram,
 * Farcaster, etc. The first impression for anyone who hasn't been to
 * the site yet, so it has to read clearly at thumbnail size.
 *
 * The same image is used for `twitter-image` because Next.js falls
 * back to `opengraph-image` when no twitter-specific image is found.
 *
 * Layout:
 *   - Deep-space gradient background (matches the site's chrome).
 *   - Brand mark on the left, big.
 *   - Wordmark + tagline on the right.
 *   - "Holders only" pill in the corner so the gating posture is
 *     visible even at preview-card resolution.
 */
import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        // Satori (the next/og renderer) does not parse the
        // `background` shorthand with a trailing solid color, so
        // we split: `backgroundColor` carries the deep-space base,
        // `backgroundImage` carries the layered radial glows.
        backgroundColor: '#05060a',
        backgroundImage:
          'radial-gradient(ellipse 90% 70% at 30% 20%, rgba(0,212,255,0.18) 0%, rgba(0,212,255,0) 60%), radial-gradient(ellipse 70% 60% at 80% 80%, rgba(243,154,109,0.10) 0%, rgba(243,154,109,0) 60%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        padding: '80px',
        width: '100%',
      }}
    >
      {/* Brand mark on the left: large radial glow with bright */}
      {/* core. Same proportions as the favicon. */}
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          flexShrink: 0,
          height: 360,
          justifyContent: 'center',
          marginRight: 64,
          position: 'relative',
          width: 360,
        }}
      >
        <div
          style={{
            background:
              'radial-gradient(circle at 50% 50%, rgba(0,212,255,0.95) 0%, rgba(0,212,255,0.35) 55%, rgba(0,212,255,0) 100%)',
            borderRadius: '50%',
            display: 'flex',
            height: 360,
            position: 'absolute',
            width: 360,
          }}
        />
        <div
          style={{
            background: '#e9faff',
            borderRadius: '50%',
            display: 'flex',
            height: 96,
            width: 96,
          }}
        />
      </div>

      {/* Right column: wordmark, tagline, gate pill. */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        {/* Render the pill inside a flex row so its container can */}
        {/* shrink-wrap the text. Satori (the next/og renderer) does */}
        {/* not implement `width: fit-content`, so the pill itself */}
        {/* has no explicit width and naturally fits its label. */}
        <div style={{ display: 'flex', marginBottom: 28 }}>
          <div
            style={{
              alignItems: 'center',
              border: '1px solid rgba(0,212,255,0.4)',
              borderRadius: 999,
              color: '#7eeaff',
              display: 'flex',
              fontFamily: 'sans-serif',
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: 4,
              padding: '8px 18px',
              textTransform: 'uppercase',
            }}
          >
            Holders only
          </div>
        </div>
        <div
          style={{
            color: '#fff',
            display: 'flex',
            fontFamily: 'sans-serif',
            fontSize: 96,
            fontWeight: 800,
            letterSpacing: -2,
            lineHeight: 1,
          }}
        >
          astroid<span style={{ color: '#00d4ff' }}>.</span>club
        </div>
        <div
          style={{
            color: 'rgba(255,255,255,0.65)',
            display: 'flex',
            fontFamily: 'sans-serif',
            fontSize: 36,
            fontWeight: 400,
            lineHeight: 1.25,
            marginTop: 24,
            maxWidth: 620,
          }}
        >
          A members-only space for $ASTROID holders. Mining arena, in-world events, cosmetic drops.
        </div>
      </div>
    </div>,
    size,
  );
}
