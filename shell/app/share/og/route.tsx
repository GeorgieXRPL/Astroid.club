/**
 * Server-rendered share-card image (roadmap §3.4, Phase 2).
 *
 * Renders the same card design as the client canvas (`shell/lib/share-card.ts`)
 * but with `next/og` (Satori) so a shared `/share?…` link unfurls with the card
 * preview on X / Discord / etc. Card data is decoded from query params.
 *
 * Uses the transparent mascot (`/mascot-rocket.png`) because Satori can't do the
 * 'lighten' composite the client canvas uses to key out the card art's black.
 */

import { ImageResponse } from 'next/og';

import { decodeShareParams } from '@/lib/share-card';

export const runtime = 'edge';

const TONE: Record<string, string> = {
  good: '#34e0a1',
  bad: '#ff6f61',
  neutral: '#00d4ff',
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const spec = decodeShareParams(url.searchParams);
  const mascot = `${url.origin}/mascot-rocket.png`;
  const accentColor = TONE[spec.accent?.tone ?? 'neutral'] ?? TONE.neutral;

  return new ImageResponse(
    (
      <div
        style={{
          backgroundColor: '#05060a',
          backgroundImage:
            'radial-gradient(ellipse 80% 70% at 78% 32%, rgba(0,212,255,0.16) 0%, rgba(0,212,255,0) 60%)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'row',
          height: '100%',
          padding: 64,
          width: '100%',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Left column */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            height: '100%',
            justifyContent: 'space-between',
          }}
        >
          {/* Brand lockup */}
          <div style={{ alignItems: 'center', display: 'flex' }}>
            <div
              style={{
                background:
                  'radial-gradient(circle at 35% 35%, #00d4ff 0%, #0353a4 55%, #001233 100%)',
                borderRadius: '50%',
                display: 'flex',
                height: 30,
                marginRight: 12,
                width: 30,
              }}
            />
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 800, letterSpacing: 4 }}>
              <span>ASTRO</span>
              <span style={{ color: '#00d4ff' }}>ID</span>
            </div>
          </div>

          {/* Headline + hero stat */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                color: 'rgba(255,255,255,0.5)',
                display: 'flex',
                fontSize: 22,
                letterSpacing: 3,
                marginBottom: 16,
                textTransform: 'uppercase',
              }}
            >
              {spec.eyebrow}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 62,
                fontWeight: 800,
                lineHeight: 1.05,
                marginBottom: spec.accent ? 22 : 0,
                maxWidth: 600,
              }}
            >
              {spec.headline}
            </div>
            {spec.accent ? (
              <div style={{ alignItems: 'baseline', display: 'flex' }}>
                <div style={{ color: accentColor, display: 'flex', fontSize: 70, fontWeight: 800 }}>
                  {spec.accent.value}
                </div>
                <div
                  style={{
                    color: 'rgba(255,255,255,0.55)',
                    display: 'flex',
                    fontSize: 22,
                    marginLeft: 16,
                  }}
                >
                  {spec.accent.label}
                </div>
              </div>
            ) : null}
          </div>

          {/* Stats + footer */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 20 }}>
              {spec.stats.map((s, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', flexDirection: 'column', marginBottom: 12, width: 290 }}
                >
                  <div
                    style={{
                      color: 'rgba(255,255,255,0.42)',
                      display: 'flex',
                      fontSize: 15,
                      letterSpacing: 2,
                      textTransform: 'uppercase',
                    }}
                  >
                    {s.label}
                  </div>
                  <div style={{ display: 'flex', fontSize: 30, fontWeight: 700 }}>{s.value}</div>
                </div>
              ))}
            </div>
            <div style={{ alignItems: 'center', display: 'flex' }}>
              <div style={{ color: '#00d4ff', display: 'flex', fontSize: 24, fontWeight: 700 }}>
                astroid.club
              </div>
              {spec.tagline ? (
                <div
                  style={{
                    color: 'rgba(255,255,255,0.4)',
                    display: 'flex',
                    fontSize: 20,
                    marginLeft: 12,
                  }}
                >
                  · {spec.tagline}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Mascot */}
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            justifyContent: 'center',
            marginLeft: 8,
            width: 540,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" height={326} src={mascot} width={540} />
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
