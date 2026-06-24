'use client';

/**
 * One drifting, rocky asteroid in the arena.
 *
 * Visual recipe per resource class:
 *   - carbon: dark-gray rough rock, no glow.
 *   - silver: bright metallic, faint white halo.
 *   - gold:   warm golden body, ember halo (Stellar-Strike vibe).
 *   - oil:    dusky blue-gray with ice flecks, cyan halo.
 *
 * Geometry is a high-detail icosahedron whose vertices are displaced
 * along their normals by multi-octave 3D Perlin noise (`./noise`).
 * Combined with a per-asteroid axial scale (set by orbit-derivation)
 * this produces fluid, organic-looking rocks instead of the obvious
 * triangular silhouette of a low-detail flat-shaded icosahedron.
 *
 * Per-flavor tinting layers cosmetic variation on top: a "Platinum"
 * gold rock pulls toward bright steel; an "Iridium" gold rock keeps
 * the warm orange. The mechanic class still owns most of the look so
 * resource identity is readable at a glance.
 *
 * Motion: the asteroid orbits the world origin on its `orbitRadius`
 * with `orbitSpeed` rad/s, on a plane tilted by `inclination` rad. It
 * also spins on its own axis. Both are pure functions of `clock` so
 * the scene is deterministic.
 */

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { ResourceKind } from './asteroid-orbits';
import { fbm3, hashSeed, makeNoise3, makeRng } from './noise';

export interface AsteroidBodyProps {
  asteroidId: string;
  name: string;
  resource: ResourceKind;
  /** Cosmetic mineral flavor (e.g. "Iridium", "Helium-3"). */
  flavor: string;
  /** Orbit radius around the world origin in scene units. */
  orbitRadius: number;
  /** Orbit speed in radians per second (positive = counter-clockwise). */
  orbitSpeed: number;
  /** Phase offset on the orbit ellipse, radians. */
  orbitPhase: number;
  /** Tilt of the orbital plane in radians (0 = flat, π/2 = vertical). */
  inclination: number;
  /** Visual radius of the rocky body in scene units. */
  bodyRadius: number;
  /** Per-asteroid axial scale before noise displacement (long/round). */
  axialScale: [number, number, number];
  /** True when this asteroid is the player's current selection. */
  selected: boolean;
  /** True when this is the player's home station. */
  isHome: boolean;
  /** True when this is the player's actively-mined asteroid. */
  isActive: boolean;
  /** Emit when the player clicks the asteroid. */
  onSelect: () => void;
}

/** Resource → visual style map. Tuned to match the design-system palette. */
const RESOURCE_STYLE: Record<
  ResourceKind,
  {
    bodyColor: string;
    emissive: string;
    emissiveIntensity: number;
    metalness: number;
    roughness: number;
    haloColor: string;
    haloIntensity: number;
    /** Vertex displacement amplitude as a fraction of body radius. */
    bumpiness: number;
    /** Number of fbm octaves; more = chunkier. */
    octaves: number;
    /** Base spatial frequency (cycles per unit radius). */
    baseFrequency: number;
  }
> = {
  carbon: {
    bodyColor: '#3a3f48',
    emissive: '#000000',
    emissiveIntensity: 0,
    metalness: 0.1,
    roughness: 1.0,
    haloColor: '#94a3b8',
    haloIntensity: 0.1,
    bumpiness: 0.34,
    octaves: 5,
    baseFrequency: 2.0,
  },
  silver: {
    bodyColor: '#b9c0cb',
    emissive: '#1a2030',
    emissiveIntensity: 0.12,
    metalness: 0.65,
    roughness: 0.55,
    haloColor: '#e2e8f0',
    haloIntensity: 0.3,
    bumpiness: 0.26,
    octaves: 5,
    baseFrequency: 1.8,
  },
  gold: {
    bodyColor: '#caa24a',
    emissive: '#ff7a45',
    emissiveIntensity: 0.5,
    metalness: 0.6,
    roughness: 0.5,
    haloColor: '#ff9a1f',
    haloIntensity: 0.55,
    bumpiness: 0.28,
    octaves: 5,
    baseFrequency: 1.7,
  },
  oil: {
    bodyColor: '#3f4d6b',
    emissive: '#0c1e36',
    emissiveIntensity: 0.18,
    metalness: 0.4,
    roughness: 0.65,
    haloColor: '#00d4ff',
    haloIntensity: 0.4,
    bumpiness: 0.3,
    octaves: 5,
    baseFrequency: 1.9,
  },
};

/**
 * Per-flavor cosmetic overrides on top of the base resource style.
 * Hue/intensity/halo tweaks only — never touches geometry parameters
 * (so flavor changes don't alter silhouette and break test
 * assertions). Anything not in the map falls back to the resource
 * style unchanged.
 */
const FLAVOR_TINT: Record<
  string,
  Partial<{
    bodyColor: string;
    emissive: string;
    emissiveIntensity: number;
    haloColor: string;
    haloIntensity: number;
    metalness: number;
    roughness: number;
  }>
> = {
  // gold class
  Iridium: { bodyColor: '#caa24a', haloColor: '#ff9a1f' },
  Platinum: {
    bodyColor: '#cdd2db',
    emissive: '#5a6378',
    emissiveIntensity: 0.18,
    haloColor: '#dfe7f5',
    metalness: 0.85,
    roughness: 0.25,
  },
  Palladium: {
    bodyColor: '#a8a39c',
    emissive: '#33271a',
    emissiveIntensity: 0.15,
    haloColor: '#f6e3b8',
    metalness: 0.78,
    roughness: 0.3,
  },
  Osmium: {
    bodyColor: '#5e6d83',
    emissive: '#1c2a3f',
    emissiveIntensity: 0.2,
    haloColor: '#a3c0e0',
    metalness: 0.7,
    roughness: 0.35,
  },
  Rhodium: {
    bodyColor: '#d6dde2',
    emissive: '#a85a2b',
    emissiveIntensity: 0.25,
    haloColor: '#ffb066',
    metalness: 0.82,
    roughness: 0.2,
  },
  'Iron-Nickel': {
    bodyColor: '#6b5e4f',
    emissive: '#3a1a05',
    emissiveIntensity: 0.18,
    haloColor: '#ffa258',
    metalness: 0.55,
    roughness: 0.5,
  },
  // silver class
  'Rare Earths': {
    bodyColor: '#9aa6c4',
    emissive: '#3b2a55',
    emissiveIntensity: 0.22,
    haloColor: '#bfa6ff',
    metalness: 0.55,
    roughness: 0.45,
  },
  Cobalt: {
    bodyColor: '#5d6f99',
    emissive: '#1a2950',
    emissiveIntensity: 0.2,
    haloColor: '#7aa5ff',
  },
  Manganese: {
    bodyColor: '#7b818b',
    emissive: '#1a1a22',
    haloColor: '#cfd6e0',
  },
  Lithium: {
    bodyColor: '#cdd6e0',
    emissive: '#3a4d70',
    emissiveIntensity: 0.22,
    haloColor: '#a8e1ff',
  },
  Titanium: {
    bodyColor: '#a3acba',
    emissive: '#22324a',
    emissiveIntensity: 0.18,
    haloColor: '#b0c2d8',
    metalness: 0.7,
    roughness: 0.35,
  },
  // carbon class
  Carbonaceous: { bodyColor: '#34373d' },
  'Hydrated Clay': { bodyColor: '#4a4a3f', roughness: 1.0 },
  'Sooty Carbon': { bodyColor: '#26282d' },
  Phosphorus: {
    bodyColor: '#564a3a',
    emissive: '#3a2700',
    emissiveIntensity: 0.18,
    haloColor: '#ffcc66',
  },
  Methane: {
    bodyColor: '#5b3a30',
    emissive: '#2a0d05',
    emissiveIntensity: 0.18,
    haloColor: '#ff8a5a',
  },
  // oil class
  'Water Ice': {
    bodyColor: '#5a7894',
    emissive: '#0c2540',
    emissiveIntensity: 0.22,
    haloColor: '#9ce0ff',
    metalness: 0.35,
    roughness: 0.5,
  },
  'Helium-3': {
    bodyColor: '#4f6e8e',
    emissive: '#0a2a45',
    emissiveIntensity: 0.28,
    haloColor: '#7eeaff',
  },
  Hydrogen: {
    bodyColor: '#506583',
    emissive: '#152a45',
    haloColor: '#a0c8ff',
  },
  'Methane Clathrate': {
    bodyColor: '#3d5570',
    haloColor: '#7fc6ff',
  },
};

interface ResolvedStyle {
  bodyColor: string;
  emissive: string;
  emissiveIntensity: number;
  metalness: number;
  roughness: number;
  haloColor: string;
  haloIntensity: number;
  bumpiness: number;
  octaves: number;
  baseFrequency: number;
}

function resolveStyle(resource: ResourceKind, flavor: string): ResolvedStyle {
  const base = RESOURCE_STYLE[resource];
  const tint = FLAVOR_TINT[flavor] ?? {};
  return { ...base, ...tint };
}

/** A single impact crater: a unit-direction centre, angular radius, depth. */
interface Crater {
  /** Unit vector pointing at the crater centre on the unit sphere. */
  cx: number;
  cy: number;
  cz: number;
  /** Angular radius (radians) of the crater footprint. */
  angularRadius: number;
  /** Depth as a fraction of body radius. */
  depth: number;
}

/**
 * Seed a handful of impact craters at random directions on the sphere.
 * Deterministic per asteroid (driven by the same hashed-id seed) so a
 * rock's pockmarks are stable across reloads.
 */
function makeCraters(seed: number): Crater[] {
  const rng = makeRng(seed ^ 0xc0ffee);
  const count = 3 + Math.floor(rng() * 4); // 3–6 craters
  const craters: Crater[] = [];
  for (let i = 0; i < count; i++) {
    // Uniform random direction on the unit sphere.
    const u = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    craters.push({
      cx: r * Math.cos(theta),
      cy: r * Math.sin(theta),
      cz: u,
      angularRadius: 0.35 + rng() * 0.5, // ~20°–49°
      depth: 0.1 + rng() * 0.14,
    });
  }
  return craters;
}

/**
 * Build a craggy, cratered asteroid mesh.
 *
 * Technique: take a high-detail icosahedron, apply an axial scale, then
 * displace each vertex along its own normal by three layers:
 *   1. low-frequency lumps that break the round silhouette into an
 *      irregular potato/peanut shape;
 *   2. multi-octave fbm for the rough rocky surface;
 *   3. seeded impact craters — inward bowls with a slightly raised rim,
 *      which is what most reads as "asteroid" vs "glob".
 * Normals are recomputed so lighting follows the new silhouette.
 *
 * `detail=5` (~10k verts) gives enough resolution for clean crater rims
 * while staying cheap — we only build it once per asteroid (4 of them).
 */
function buildAsteroidGeometry(opts: {
  radius: number;
  detail: number;
  bumpiness: number;
  octaves: number;
  baseFrequency: number;
  axialScale: [number, number, number];
  seed: number;
}): THREE.BufferGeometry {
  const { radius, detail, bumpiness, octaves, baseFrequency, axialScale, seed } = opts;
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  if (!pos) return geo;

  // One sampler per octave for the surface roughness, plus a single
  // coarse sampler for the big asymmetric lumps.
  const samplers = Array.from({ length: octaves }, (_, i) =>
    makeNoise3((seed + i * 0x9e3779b1) >>> 0, 8),
  );
  const lumpSampler = makeNoise3((seed ^ 0x5bd1e995) >>> 0, 4);
  const craters = makeCraters(seed);

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Apply axial scale BEFORE displacement so the rock is oblong /
    // round at the silhouette level, then noise adds the rocky surface.
    v.x *= axialScale[0];
    v.y *= axialScale[1];
    v.z *= axialScale[2];
    const len = v.length();
    if (len === 0) continue;
    const nx = v.x / len;
    const ny = v.y / len;
    const nz = v.z / len;

    // (1) Big irregular lumps — low frequency, signed, large amplitude.
    const lf = (baseFrequency * 0.4) / radius;
    const lump = lumpSampler(v.x * lf, v.y * lf, v.z * lf) * 0.32 * radius;

    // (2) Rough rocky surface — multi-octave fbm.
    const f = baseFrequency / radius;
    const surface = fbm3(samplers, v.x * f, v.y * f, v.z * f) * bumpiness * radius;

    // (3) Craters — inward bowls with a raised rim, by angular distance
    // from each crater centre along this vertex's surface normal.
    let crater = 0;
    for (const c of craters) {
      const cosang = Math.min(1, Math.max(-1, nx * c.cx + ny * c.cy + nz * c.cz));
      const ang = Math.acos(cosang);
      if (ang < c.angularRadius) {
        const t = ang / c.angularRadius; // 0 centre → 1 rim
        const bowl = -(1 - t * t); // inward, deepest at centre
        const rim = Math.exp(-(((t - 0.86) / 0.1) ** 2)) * 0.5; // raised lip
        crater += (bowl + rim) * c.depth * radius;
      }
    }

    const offset = lump + surface + crater;
    v.set(v.x + nx * offset, v.y + ny * offset, v.z + nz * offset);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function AsteroidBody({
  asteroidId,
  name,
  resource,
  flavor,
  orbitRadius,
  orbitSpeed,
  orbitPhase,
  inclination,
  bodyRadius,
  axialScale,
  selected,
  isHome,
  isActive,
  onSelect,
}: AsteroidBodyProps) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Sprite>(null);

  const style = useMemo(() => resolveStyle(resource, flavor), [resource, flavor]);

  // Geometry + halo texture are memoised so React + r3f never rebuild
  // them. The seed comes from the asteroid id so the same rock always
  // has the same silhouette across reloads.
  const geometry = useMemo(
    () =>
      buildAsteroidGeometry({
        radius: bodyRadius,
        detail: 5,
        bumpiness: style.bumpiness,
        octaves: style.octaves,
        baseFrequency: style.baseFrequency,
        axialScale,
        seed: hashSeed(asteroidId),
      }),
    [asteroidId, bodyRadius, style.bumpiness, style.octaves, style.baseFrequency, axialScale],
  );

  const haloTexture = useMemo(() => makeHaloTexture(), []);
  const ringTexture = useMemo(() => makeRingTexture(), []);

  // Self-spin axis: deterministic per asteroid so each rock looks
  // distinct without sharing the same tumble direction.
  const spinAxis = useMemo(() => {
    const rng = makeRng(hashSeed(asteroidId) ^ 0xa5a5a5a5);
    const v = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5);
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    return v.normalize();
  }, [asteroidId]);

  // Self-spin rate: small per-rock variance.
  const spinRate = useMemo(() => {
    const rng = makeRng(hashSeed(asteroidId) ^ 0x12345678);
    return 0.18 + rng() * 0.35;
  }, [asteroidId]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    const angle = orbitPhase + t * orbitSpeed;
    // Orbit on a tilted plane: position the body in (x, z), then
    // tilt the whole orbit by `inclination` around the X-axis.
    const x = Math.cos(angle) * orbitRadius;
    const zFlat = Math.sin(angle) * orbitRadius;
    const y = Math.sin(inclination) * zFlat;
    const z = Math.cos(inclination) * zFlat;
    groupRef.current.position.set(x, y, z);
    if (meshRef.current) {
      meshRef.current.rotateOnAxis(spinAxis, delta * spinRate);
    }
    if (haloRef.current && (selected || isActive || isHome)) {
      const pulse = 1 + Math.sin(t * 2) * 0.06;
      haloRef.current.scale.set(bodyRadius * 4 * pulse, bodyRadius * 4 * pulse, 1);
    }
  });

  const haloScale = bodyRadius * (selected || isActive || isHome ? 4.2 : 3.4);
  const haloOpacity = style.haloIntensity * (selected ? 1.6 : isActive ? 1.4 : isHome ? 1.2 : 1.0);

  return (
    <group ref={groupRef}>
      {/* Generous click target; slightly larger than the body so
          hits are forgiving on small asteroids and the user doesn't
          have to pixel-aim through bumpy silhouette gaps. */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <sphereGeometry args={[bodyRadius * 1.6, 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>

      {/* The rocky body — smooth shading on multi-octave noise. */}
      <mesh ref={meshRef} geometry={geometry} castShadow={false} receiveShadow={false}>
        <meshStandardMaterial
          color={style.bodyColor}
          emissive={style.emissive}
          emissiveIntensity={style.emissiveIntensity}
          metalness={style.metalness}
          roughness={style.roughness}
        />
      </mesh>

      {/* Soft halo / atmospheric glow. */}
      <sprite ref={haloRef} scale={[haloScale, haloScale, 1]}>
        <spriteMaterial
          map={haloTexture}
          color={style.haloColor}
          transparent
          opacity={haloOpacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </sprite>

      {/* Selection ring — only visible when selected. */}
      {selected && (
        <sprite scale={[bodyRadius * 5.8, bodyRadius * 5.8, 1]}>
          <spriteMaterial
            map={ringTexture}
            color="#00d4ff"
            transparent
            opacity={0.85}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </sprite>
      )}

      {/* Floating label. Drei's Html projects DOM into the scene; we
          tag it pointer-events-none so the click hits the asteroid,
          not the label. The label fades in on hover/select via CSS. */}
      <Html center distanceFactor={14} position={[0, bodyRadius * 1.9, 0]} zIndexRange={[10, 0]}>
        <div
          className={`pointer-events-none whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-sm transition-opacity ${
            selected || isActive || isHome
              ? 'border-cosmos/40 bg-space-950/80 text-white opacity-100'
              : 'border-white/10 bg-space-950/55 text-white/75 opacity-90'
          }`}
        >
          <span className={`resource-dot resource-dot--${resource}`} />
          {name}
          <span className="ml-1.5 text-white/50">· {flavor}</span>
          {isActive && <span className="ml-2 text-cosmos">· here</span>}
          {isHome && <span className="ml-2 text-ember">· home</span>}
        </div>
      </Html>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sprite textures                                                           */
/* -------------------------------------------------------------------------- */

function makeHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const cx = size / 2;
  const grd = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A thin annular ring texture for selection feedback. Two stacked
 * radial gradients carve out the inner hole.
 */
function makeRingTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const cx = size / 2;
  const outer = ctx.createRadialGradient(cx, cx, cx * 0.6, cx, cx, cx);
  outer.addColorStop(0, 'rgba(0,212,255,0)');
  outer.addColorStop(0.45, 'rgba(0,212,255,1)');
  outer.addColorStop(1, 'rgba(0,212,255,0)');
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'destination-out';
  const inner = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.45);
  inner.addColorStop(0, 'rgba(0,0,0,1)');
  inner.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = inner;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
