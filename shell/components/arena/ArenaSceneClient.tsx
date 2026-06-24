'use client';

import dynamic from 'next/dynamic';

/**
 * Three.js + react-three-fiber must NOT execute on the server (no
 * window, no canvas, no WebGL). `dynamic` with `ssr: false` matches
 * the same pattern Astroid.club uses for `HeroSceneClient`. The
 * fallback is a transparent placeholder — the page already paints a
 * deep-space background via the global CSS starfield, so there's no
 * visible flash before the canvas mounts.
 */
export const ArenaSceneClient = dynamic(
  () => import('./Arena').then((m) => ({ default: m.Arena })),
  {
    ssr: false,
    loading: () => null,
  },
);
