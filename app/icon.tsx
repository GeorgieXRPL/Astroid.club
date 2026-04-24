/**
 * @fileoverview Browser tab favicon. Next.js App Router auto-discovers
 * this file at `app/icon.tsx` and emits the correct
 * `<link rel="icon" type="image/png">` tag.
 *
 * Design mirrors the `Logo` component in `app/page.tsx`: cyan-to-deep-
 * blue radial gradient sphere with a small white pinpoint at top-left.
 * Same brand mark in the tab as in the header.
 */
import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          background:
            'radial-gradient(circle at 30% 30%, #00d4ff 0%, #0353a4 55%, #001233 100%)',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Subtle outer glow so the icon reads on light AND dark
          // browser-chrome backgrounds.
          boxShadow: '0 0 6px rgba(0, 212, 255, 0.6)',
        }}
      >
        {/* White pinpoint, positioned top-left like a star on the orb. */}
        <div
          style={{
            position: 'absolute',
            top: 6,
            left: 8,
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 0 4px #ffffff',
          }}
        />
      </div>
    ),
    { ...size }
  );
}
