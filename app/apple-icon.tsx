/**
 * @fileoverview iOS / iPadOS home-screen icon. Next.js App Router
 * auto-discovers this at `app/apple-icon.tsx` and emits a
 * `<link rel="apple-touch-icon">` tag.
 *
 * Apple expects a 180x180 PNG with no transparency (iOS clips to the
 * rounded square itself and adds its own shadow). Same brand mark as
 * the in-page Logo and the favicon, scaled up.
 */
import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          // Deep-space backdrop so the orb reads well after iOS's
          // rounded-square clip; no transparency anywhere on this layer.
          background: '#000814',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 132,
            height: 132,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 30% 25%, #00d4ff 0%, #0353a4 50%, #001233 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 32px rgba(0, 212, 255, 0.55)',
            position: 'relative',
          }}
        >
          {/* Pinpoint star, scaled to match the favicon proportionally. */}
          <div
            style={{
              position: 'absolute',
              top: 28,
              left: 38,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#ffffff',
              boxShadow: '0 0 12px #ffffff',
            }}
          />
        </div>
      </div>
    ),
    { ...size }
  );
}
