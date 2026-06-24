'use client';

/**
 * Background starfield for the asteroid arena.
 *
 * Adapted from `Astroid.club/app/components/StarFieldHero.tsx` — same
 * procedural Perlin-noise nebula textures, same multi-layer Drei
 * starfields, same galactic-band puff distribution. The only thing
 * removed is interactivity: the arena's parent scene owns
 * `OrbitControls` and post-processing so the asteroids and the stars
 * share one camera and one bloom pass.
 *
 * Drift these constants and you drift the brand. The puff layouts and
 * noise seeds are deliberately deterministic so the arena's "sky"
 * looks visually identical to the public Astroid.club hero.
 */

import { Stars as DeepStars } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/*  Procedural textures                                                        */
/* -------------------------------------------------------------------------- */

function makeRadialTexture(size: number, sharpness: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const cx = size / 2;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const v = Math.max(0, 1 - d);
      const a = Math.pow(v, sharpness);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Soft cloud texture for nebulae and the galactic band.
 *
 * Four-octave Perlin noise (8/16/32/64-cell grids, halving amplitude)
 * with a Gaussian edge fade. The full reasoning lives in
 * `Astroid.club/app/components/StarFieldHero.tsx`; the short version
 * is: gradient noise has zero value AND smooth derivatives at every
 * grid corner, which kills the "blob" cells value noise produces.
 *
 * `seed` lets the caller mint several independent variants so
 * overlapping sprites don't echo each other's pattern.
 */
function makeCloudTexture(size: number, seed: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const cx = size / 2;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  let s = seed | 0 || 0x9e3779b1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const makeOctave = (N: number) => {
    const gx = new Float32Array(N * N);
    const gy = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const a = rnd() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    return (u: number, v: number) => {
      const x = u * (N - 1);
      const y = v * (N - 1);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const x1 = Math.min(N - 1, x0 + 1);
      const y1 = Math.min(N - 1, y0 + 1);
      const i00 = y0 * N + x0;
      const i10 = y0 * N + x1;
      const i01 = y1 * N + x0;
      const i11 = y1 * N + x1;
      const d00 = gx[i00]! * fx + gy[i00]! * fy;
      const d10 = gx[i10]! * (fx - 1) + gy[i10]! * fy;
      const d01 = gx[i01]! * fx + gy[i01]! * (fy - 1);
      const d11 = gx[i11]! * (fx - 1) + gy[i11]! * (fy - 1);
      const ux = fade(fx);
      const uy = fade(fy);
      const top = d00 + ux * (d10 - d00);
      const bot = d01 + ux * (d11 - d01);
      return top + uy * (bot - top);
    };
  };

  const o1 = makeOctave(8);
  const o2 = makeOctave(16);
  const o3 = makeOctave(32);
  const o4 = makeOctave(64);

  const k = 1.35;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const edgeFade = Math.exp(-(k * k) * (dx * dx + dy * dy));
      const raw = o1(u, v) * 0.5 + o2(u, v) * 0.25 + o3(u, v) * 0.125 + o4(u, v) * 0.0625;
      const n = raw * 0.7 + 0.5;
      const a = edgeFade * Math.max(0, Math.min(1, n));
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/*  Background structures                                                      */
/* -------------------------------------------------------------------------- */

interface NebulaAnchor {
  position: [number, number, number];
  scale: number;
  color: string;
  opacity: number;
}

const NEBULA_ANCHORS: ReadonlyArray<NebulaAnchor> = [
  { position: [-60, 6, -90], scale: 130, color: '#3b3a8a', opacity: 0.42 },
  { position: [70, -10, -85], scale: 150, color: '#7a2a6a', opacity: 0.32 },
  { position: [10, 22, 95], scale: 120, color: '#1f5d8a', opacity: 0.36 },
  { position: [-55, -18, 80], scale: 100, color: '#6b3a1f', opacity: 0.22 },
  { position: [40, -40, -10], scale: 90, color: '#1f3d6b', opacity: 0.28 },
  { position: [-30, 40, 30], scale: 80, color: '#5a1f6b', opacity: 0.24 },
  { position: [85, 30, 10], scale: 70, color: '#00d4ff', opacity: 0.14 },
  { position: [-80, -25, -20], scale: 75, color: '#ff7a45', opacity: 0.12 },
];

interface NebulaPuff {
  position: [number, number, number];
  scale: number;
  color: string;
  opacity: number;
  rotation: number;
  textureIndex: number;
}

const NEBULA_PUFFS: ReadonlyArray<NebulaPuff> = (() => {
  let s = 0xa5b6c7d8;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const out: NebulaPuff[] = [];
  const PUFFS_PER_ANCHOR = 6;
  for (const a of NEBULA_ANCHORS) {
    const spread = a.scale * 0.4;
    for (let i = 0; i < PUFFS_PER_ANCHOR; i++) {
      const bias = i === 0 ? 0.15 : 1.0;
      const ox = (rnd() - 0.5) * spread * 2 * bias;
      const oy = (rnd() - 0.5) * spread * 1.4 * bias;
      const oz = (rnd() - 0.5) * spread * 1.6 * bias;
      const scale = a.scale * (0.35 + rnd() * 0.3);
      const opacity = (a.opacity / Math.sqrt(PUFFS_PER_ANCHOR)) * (0.75 + rnd() * 0.5);
      out.push({
        position: [a.position[0] + ox, a.position[1] + oy, a.position[2] + oz],
        scale,
        color: a.color,
        opacity,
        rotation: (rnd() - 0.5) * Math.PI,
        textureIndex: Math.floor(rnd() * 3),
      });
    }
  }
  return out;
})();

function NebulaField({ textures }: { textures: ReadonlyArray<THREE.Texture> }) {
  return (
    <group>
      {NEBULA_PUFFS.map((p, i) => (
        <sprite key={i} position={p.position} scale={p.scale}>
          <spriteMaterial
            map={textures[p.textureIndex] ?? textures[0]}
            color={p.color}
            transparent
            opacity={p.opacity}
            rotation={p.rotation}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest={false}
          />
        </sprite>
      ))}
    </group>
  );
}

interface BandPuff {
  position: [number, number, number];
  scale: [number, number, number];
  color: string;
  opacity: number;
  rotation: number;
  textureIndex: number;
}

const BAND_PUFFS: ReadonlyArray<BandPuff> = (() => {
  let s = 0x12345678;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const palette = ['#4a3a8a', '#5a3a8a', '#3a4a9a', '#7a3a7a', '#5a4a9a', '#8a4a6a'];

  const puffs: BandPuff[] = [];
  const COUNT = 26;

  for (let i = 0; i < COUNT; i++) {
    const t = (i / (COUNT - 1)) * 2 - 1;
    const x = t * 115 + (rnd() - 0.5) * 22;
    const y = Math.sin(t * 1.4 + 0.6) * 6 + (rnd() - 0.5) * 14;
    const z = -58 + (rnd() - 0.5) * 28;

    const base = 30 + rnd() * 32;
    const stretch = 1.0 + rnd() * 0.5;
    const scale: [number, number, number] = [base * stretch, base, 1];

    const edgeMask = Math.exp(-t * t * 1.6);
    const opacity = (0.09 + rnd() * 0.13) * edgeMask;

    const color = palette[Math.floor(rnd() * palette.length)] ?? palette[0]!;
    const rotation = (rnd() - 0.5) * Math.PI;
    const textureIndex = Math.floor(rnd() * 3);

    puffs.push({ position: [x, y, z], scale, color, opacity, rotation, textureIndex });
  }
  return puffs;
})();

function GalacticBand({ textures }: { textures: ReadonlyArray<THREE.Texture> }) {
  return (
    <group rotation={[0.15, 0, 0.4]}>
      {BAND_PUFFS.map((p, i) => (
        <sprite key={i} position={p.position} scale={p.scale}>
          <spriteMaterial
            map={textures[p.textureIndex] ?? textures[0]}
            color={p.color}
            transparent
            opacity={p.opacity}
            rotation={p.rotation}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest={false}
          />
        </sprite>
      ))}
    </group>
  );
}

/**
 * Tiny additive specks in a slab close to the camera. Strong "I'm
 * flying through space" parallax cue when the camera drifts.
 */
function DustField({ texture, count = 500 }: { texture: THREE.Texture; count?: number }) {
  const ref = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const m = new THREE.PointsMaterial({
      map: texture,
      size: 0.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: '#cfd6ff',
    });
    return { geometry: g, material: m };
  }, [texture, count]);

  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.02;
    ref.current.rotation.x += delta * 0.008;
  });

  return <points ref={ref} geometry={geometry} material={material} />;
}

/* -------------------------------------------------------------------------- */
/*  Public component                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The full background sky for the arena: galactic band + nebula
 * field + four layers of deep stars + dust parallax. No camera or
 * post-processing — the parent scene owns those so the arena and the
 * starfield share one camera/bloom pass.
 */
export function Starfield() {
  const textures = useMemo(
    () => ({
      clouds: [
        makeCloudTexture(512, 0x12345678),
        makeCloudTexture(512, 0x9abcdef0),
        makeCloudTexture(512, 0xfeedface),
      ] as ReadonlyArray<THREE.Texture>,
      dust: makeRadialTexture(32, 2.0),
    }),
    [],
  );

  return (
    <>
      <GalacticBand textures={textures.clouds} />
      <NebulaField textures={textures.clouds} />

      {/* Four layers of deep stars at varied radii / sizes / speeds.
          Real parallax when the camera moves. */}
      <DeepStars
        radius={320}
        depth={160}
        count={18000}
        factor={2.2}
        saturation={0.05}
        fade
        speed={0.12}
      />
      <DeepStars
        radius={200}
        depth={100}
        count={8000}
        factor={3.5}
        saturation={0.1}
        fade
        speed={0.25}
      />
      <DeepStars
        radius={110}
        depth={60}
        count={2400}
        factor={5}
        saturation={0.18}
        fade
        speed={0.45}
      />
      <DeepStars radius={60} depth={30} count={800} factor={7} saturation={0.22} fade speed={0.7} />

      <DustField texture={textures.dust} count={650} />
    </>
  );
}
