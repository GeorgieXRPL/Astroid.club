'use client';

import dynamic from 'next/dynamic';

/**
 * Dynamic, client-only loader for the Three.js starfield scene.
 *
 * Three.js + react-three-fiber must NOT execute on the server (no
 * window, no canvas, no WebGL). Wrapping the import in `dynamic` with
 * `ssr: false` is the same pattern astroid.space uses for its HeroScene.
 *
 * The fallback is intentionally invisible - the page background is
 * already a deep navy with the CSS-gradient starfield from globals.css,
 * so until WebGL boots there is no jarring blank panel.
 */
export const HeroSceneClient = dynamic(
  () => import('./StarFieldHero').then((m) => m.StarFieldHero),
  {
    ssr: false,
    loading: () => null,
  }
);
