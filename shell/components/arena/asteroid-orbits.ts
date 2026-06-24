/**
 * Per-asteroid orbit / visual layout for the arena.
 *
 * Drives off the server's canonical `position` + `sector` so the design
 * pass owns layout intent on the server and the arena just renders it.
 * Sectors map to orbit-radius bands; within a band, the canonical
 * `position.x/y/z` decides phase and inclination (so each asteroid in a
 * sector still has a unique slot).
 *
 * Distances and body radii are in scene units (the default camera sits
 * at z ≈ 28).
 */

import type { AsteroidListing } from '../../lib/session';
import { hashSeed, makeRng } from './noise';

export type ResourceKind = 'carbon' | 'silver' | 'gold' | 'oil';

export interface AsteroidOrbit {
  /** Orbit radius around the world origin. */
  orbitRadius: number;
  /** Orbit speed in radians per second. */
  orbitSpeed: number;
  /** Phase offset on the orbit ellipse, radians. */
  orbitPhase: number;
  /** Tilt of the orbital plane in radians. */
  inclination: number;
  /** Visual radius of the rocky body in scene units. */
  bodyRadius: number;
  /** Per-asteroid axial scale applied before noise displacement. */
  axialScale: [number, number, number];
}

/** Sector → median orbit radius. */
const SECTOR_RADII: Record<string, number> = {
  'Near-Earth': 7.5,
  'Inner Belt': 12,
  'Outer Belt': 18,
  'Trojan / Kuiper': 26,
};

const DEFAULT_SECTOR_RADIUS = 13;

/** Orbit speed decreases with radius (Kepler-ish): farther = slower. */
function speedForRadius(r: number): number {
  // Tuned so r=7.5 → ~0.085 rad/s and r=26 → ~0.025 rad/s.
  return 0.7 / Math.pow(r, 0.95);
}

/**
 * Body size scales mildly with `baseRewardMultiplier`. Richer rocks
 * read as bigger; the steepness is gentle so the belt doesn't have a
 * giant outlier dwarfing everything else.
 */
function bodyRadiusForReward(reward: number): number {
  const r = 0.55 + (reward - 1) * 0.55;
  return Math.max(0.4, Math.min(1.55, r));
}

/**
 * Derive deterministic orbit params from a server-supplied asteroid
 * listing. Same input → same output across reloads, so the layout is
 * stable for screenshots and demos.
 */
export function orbitFromListing(asteroid: {
  id: string;
  sector: string;
  position: { x: number; y: number; z: number };
  baseRewardMultiplier?: number;
}): AsteroidOrbit {
  const baseR = SECTOR_RADII[asteroid.sector] ?? DEFAULT_SECTOR_RADIUS;
  const rng = makeRng(hashSeed(asteroid.id));

  // Phase from the canonical xz-azimuth (so two asteroids with very
  // different x/z don't pile on top of each other).
  const phase = Math.atan2(asteroid.position.z, asteroid.position.x);

  // Per-rock radial jitter inside its sector band so the ring doesn't
  // look like a perfect annulus.
  const radialJitter = (rng() - 0.5) * (baseR * 0.16);
  const orbitRadius = baseR + radialJitter;

  // Inclination from y / horizontal-radius, clamped so the orbital
  // plane stays gentle (max ~12°). Plus a small per-rock tweak so each
  // sibling tilts a touch differently.
  const horiz = Math.hypot(asteroid.position.x, asteroid.position.z) || 1;
  const rawIncl = Math.atan2(asteroid.position.y, horiz);
  const inclination = Math.max(-0.22, Math.min(0.22, rawIncl)) + (rng() - 0.5) * 0.04;

  const orbitSpeed = speedForRadius(orbitRadius) * (0.85 + rng() * 0.3);

  // Slight axial scale per rock to break up the obvious-sphere look.
  const axialScale: [number, number, number] = [
    0.9 + rng() * 0.25,
    0.85 + rng() * 0.3,
    0.9 + rng() * 0.25,
  ];

  const reward = asteroid.baseRewardMultiplier ?? 1;
  const bodyRadius = bodyRadiusForReward(reward);

  return {
    orbitRadius,
    orbitSpeed,
    orbitPhase: phase + rng() * 0.4,
    inclination,
    bodyRadius,
    axialScale,
  };
}

/**
 * Adapter for the connect snapshot, which doesn't carry
 * `baseRewardMultiplier`. Rocks read at their default size; the design
 * pass that exposes reward in the snapshot can pass it through.
 */
export function orbitFromSnapshot(asteroid: AsteroidListing): AsteroidOrbit {
  return orbitFromListing(asteroid);
}

/** Resource → display label used in HUD copy. */
export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  carbon: 'Carbonaceous · Steady Drill',
  silver: 'Speculation · Solar Flare',
  gold: 'Metallic · Stellar Strike',
  oil: 'Volatile-rich · Syndicate',
};

/** Coerce a server-supplied resource string to our internal taxonomy. */
export function asResourceKind(s: string): ResourceKind {
  return (['carbon', 'silver', 'gold', 'oil'] as const).includes(s as ResourceKind)
    ? (s as ResourceKind)
    : 'carbon';
}
