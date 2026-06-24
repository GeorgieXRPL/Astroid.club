/**
 * Apple touch icon (180x180 PNG, generated at build time).
 *
 * Renders when an iOS / iPadOS user adds astroid.club to the home
 * screen. Mirrors the SVG favicon design (radial cyan glow on a deep
 * space ground) but baked to a square PNG because iOS does not
 * accept SVG for touch icons.
 *
 * Generated dynamically through `next/og`'s `ImageResponse` so we do
 * not commit a binary blob; the build pipeline emits the PNG once
 * and Next.js caches it. Edit the JSX below to retune the icon.
 */
import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: 'center',
        background: '#05060a',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        width: '100%',
      }}
    >
      {/* Outer halo: cyan radial glow that gives the brand its */}
      {/* "blue dwarf" feel. */}
      <div
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(0,212,255,0.95) 0%, rgba(0,212,255,0.35) 55%, rgba(0,212,255,0) 100%)',
          borderRadius: '50%',
          display: 'flex',
          height: 130,
          position: 'absolute',
          width: 130,
        }}
      />
      {/* Bright limb: the small white core that makes the icon */}
      {/* legible at very small sizes. */}
      <div
        style={{
          background: '#e9faff',
          borderRadius: '50%',
          display: 'flex',
          height: 36,
          width: 36,
        }}
      />
    </div>,
    size,
  );
}
