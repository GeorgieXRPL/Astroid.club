'use client';

/**
 * @fileoverview The Astroid Club hero starfield.
 *
 * Same visual DNA as the StarMap on astroid.space (procedural sprite
 * stars, drei DeepStars layers, additive nebulae + galactic band,
 * foreground dust for parallax, drifting camera, ACES tone-mapping +
 * bloom + vignette) - but stripped of every interactive piece. The
 * Club hero never needs to be clicked, named, focused, or hit-tested,
 * so we drop the named-star sprites, OrbitControls, the click hit
 * meshes, and the entire `lib/stars` dependency chain.
 *
 * Result: ~250 lines instead of ~700, no router coupling, identical
 * cinematic feel.
 */

import { useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars as DeepStars, OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { BlendFunction, KernelSize } from 'postprocessing';
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/*  Procedural textures (no image assets shipped)                              */
/* -------------------------------------------------------------------------- */

/** Radial gradient sprite, white-on-transparent. Tinted at draw time. */
function makeRadialTexture(size: number, sharpness: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
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
 * Why this is structured the way it is:
 *
 *   Value noise (a grid of random scalars + smoothstep interpolation)
 *   has a fundamental flaw for cloud textures: every grid corner is
 *   an extremum, so the noise has zero derivative there. That creates
 *   visible "blob" cells - rounded squares with flat tops. Smoothstep
 *   hides the linear seams but cannot hide the blob shape, and once a
 *   sprite is bloom-amplified the eye reads it as blockiness.
 *
 *   Perlin gradient noise fixes this at the source. Each grid corner
 *   gets a unit-length random gradient VECTOR; the noise value at a
 *   sample point is the interpolated dot product of that point's
 *   distance from each corner with that corner's gradient. Crucially:
 *
 *     - The noise is exactly zero at every grid corner.
 *     - The derivative is non-zero and varies continuously through
 *       corners (with the fade(t) = 6t^5 - 15t^4 + 10t^3 quintic).
 *
 *   Result: flowing curves, no blobs, no perceptible cell structure.
 *
 *   Four octaves (8, 16, 32, 64 cells) with halving amplitude give us
 *   classic fbm - large shapes layered with progressively finer detail
 *   - on top of a true gaussian edge falloff so the sprite has no
 *   perceptible boundary.
 *
 *   We expose a `seed` parameter so the caller can build several
 *   independent variants. Overlapping sprites that share the same
 *   texture would echo each other's pattern and give the trick away;
 *   distributing variants across the scene eliminates that.
 */
function makeCloudTexture(size: number, seed: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  // Seeded PRNG so each variant is deterministic across reloads.
  let s = (seed | 0) || 0x9e3779b1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /**
   * One Perlin octave at NxN grid resolution. Returns a sampler over
   * the unit square (u, v in [0, 1]) producing values in roughly
   * [-0.7, 0.7]; we remap to [0, 1] at the consumer.
   */
  const makeOctave = (N: number) => {
    const gx = new Float32Array(N * N);
    const gy = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const a = rnd() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    // Quintic fade curve: zero first AND second derivative at endpoints.
    // This is what gives Perlin its flowing, derivative-continuous look.
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
      // Dot product of (sample - corner) with each corner's gradient.
      const i00 = y0 * N + x0;
      const i10 = y0 * N + x1;
      const i01 = y1 * N + x0;
      const i11 = y1 * N + x1;
      const d00 = gx[i00] * fx + gy[i00] * fy;
      const d10 = gx[i10] * (fx - 1) + gy[i10] * fy;
      const d01 = gx[i01] * fx + gy[i01] * (fy - 1);
      const d11 = gx[i11] * (fx - 1) + gy[i11] * (fy - 1);
      const ux = fade(fx);
      const uy = fade(fy);
      const top = d00 + ux * (d10 - d00);
      const bot = d01 + ux * (d11 - d01);
      return top + uy * (bot - top);
    };
  };

  const o1 = makeOctave(8); //   broad gas shape
  const o2 = makeOctave(16); //  mid wisp structure
  const o3 = makeOctave(32); //  fine streaks
  const o4 = makeOctave(64); //  micro detail

  // Tuned so edge fade is essentially zero by d~1.4 with no perceptible
  // boundary anywhere within the sprite quad.
  const k = 1.35;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const edgeFade = Math.exp(-(k * k) * (dx * dx + dy * dy));
      // Classic fbm: amplitudes 1/2, 1/4, 1/8, 1/16. Remap from
      // Perlin's signed range to [0, 1].
      const raw =
        o1(u, v) * 0.5 +
        o2(u, v) * 0.25 +
        o3(u, v) * 0.125 +
        o4(u, v) * 0.0625;
      const n = raw * 0.7 + 0.5; // ~[0, 1]
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

/**
 * Each entry is a NEBULA CENTER - a notional cloud anchor in space.
 * At module load time we explode each anchor into a cluster of small
 * overlapping puffs (see `NEBULA_PUFFS` below). Same trick we used for
 * the galactic band: one big stretched sprite shows its texture's
 * structure; many small ones with varied position/rotation/texture
 * variant blend into something that has no perceptible repetition.
 */
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

/**
 * Explode each nebula anchor into 6 small puffs scattered within ~40%
 * of the anchor's scale, with per-puff color/opacity/rotation jitter
 * and a random texture-variant index. Total ~48 sprites instead of 8 -
 * negligible perf cost, dramatic quality difference.
 */
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
      // Bias the first puff toward the anchor center so each cluster
      // has a "core"; the rest scatter freely.
      const bias = i === 0 ? 0.15 : 1.0;
      const ox = (rnd() - 0.5) * spread * 2 * bias;
      const oy = (rnd() - 0.5) * spread * 1.4 * bias;
      const oz = (rnd() - 0.5) * spread * 1.6 * bias;
      // Puff scales 35-65% of anchor scale. Smaller than the original
      // sprite, so the texture is sampled at a finer effective rate
      // and any feature stays sub-perceptual.
      const scale = a.scale * (0.35 + rnd() * 0.3);
      // Opacity per puff: anchor opacity / sqrt(count) keeps total
      // luminance roughly constant after additive blending, then
      // jittered +/- 25%.
      const opacity =
        (a.opacity / Math.sqrt(PUFFS_PER_ANCHOR)) * (0.75 + rnd() * 0.5);
      out.push({
        position: [
          a.position[0] + ox,
          a.position[1] + oy,
          a.position[2] + oz,
        ],
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

/**
 * Milky-Way-style band.
 *
 * The naive way to do this is one or two huge sprites stretched 5x along
 * the band axis. That fails: stretching a square noise texture 5:1
 * stretches every internal noise feature 5:1 too, so the band reads as
 * a blocky, streaky rectangle - the exact artifact a "galaxy" should
 * not have. No amount of mipmaps or anisotropy fixes a sprite that's
 * already wrong in object space.
 *
 * The fix is to build the band from many SMALL, mostly-square puffs
 * scattered along the axis. Each puff has scale ratio <= 1.6, so the
 * texture is sampled at near-original aspect and there's no stretch
 * artifact. Their additive overlap creates an organic, continuous band
 * with real variation - different colors, different rotations, density
 * tapering at the edges - that no single sprite can fake.
 *
 * Generated once at module load with a seeded PRNG so the shape is
 * deterministic across reloads (no hot-reload reshuffling).
 */
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

  // Six related hues - mostly cool indigo/violet with a couple of warm
  // magenta accents. Keeps the band reading as one structure, not a
  // rainbow blob.
  const palette = [
    '#4a3a8a',
    '#5a3a8a',
    '#3a4a9a',
    '#7a3a7a',
    '#5a4a9a',
    '#8a4a6a',
  ];

  const puffs: BandPuff[] = [];
  const COUNT = 26;

  for (let i = 0; i < COUNT; i++) {
    // Position along the band axis (-1 to +1), with jitter so the
    // puffs don't sit in a regular line.
    const t = (i / (COUNT - 1)) * 2 - 1;
    const x = t * 115 + (rnd() - 0.5) * 22;
    // Vertical wander - a sine wave plus jitter gives the band a
    // natural drift instead of a flat line.
    const y = Math.sin(t * 1.4 + 0.6) * 6 + (rnd() - 0.5) * 14;
    // Z-jitter so puffs occlude/reveal each other across depth, which
    // adds parallax cue when the camera rotates.
    const z = -58 + (rnd() - 0.5) * 28;

    // Square-ish: base 30-60 units, horizontal stretch capped at 1.5x.
    // At that ratio the noise texture's features stay readable.
    const base = 30 + rnd() * 32;
    const stretch = 1.0 + rnd() * 0.5;
    const scale: [number, number, number] = [base * stretch, base, 1];

    // Density tapers at the band's ends (gaussian falloff in t).
    const edgeMask = Math.exp(-t * t * 1.6);
    const opacity = (0.09 + rnd() * 0.13) * edgeMask;

    const color = palette[Math.floor(rnd() * palette.length)];
    // Random rotation per puff so noise patterns don't align across
    // sprites and give the trick away.
    const rotation = (rnd() - 0.5) * Math.PI;
    // Round-robin across the three texture variants so adjacent puffs
    // tend not to share a pattern.
    const textureIndex = Math.floor(rnd() * 3);

    puffs.push({
      position: [x, y, z],
      scale,
      color,
      opacity,
      rotation,
      textureIndex,
    });
  }
  return puffs;
})();

function GalacticBand({
  textures,
}: {
  textures: ReadonlyArray<THREE.Texture>;
}) {
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

/* -------------------------------------------------------------------------- */
/*  Foreground dust (parallax cue)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Tiny additive specks in a slab close to the camera. Strong "I'm
 * flying through space" parallax cue when the camera drifts.
 */
function DustField({
  texture,
  count = 500,
}: {
  texture: THREE.Texture;
  count?: number;
}) {
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
/*  Top-level scene                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The .space hero uses CameraDrift because it's the home page background -
 * a static, never-touched mood piece. The Club hero is the entire page,
 * so we hand the camera to OrbitControls with a slow auto-rotate. When
 * a visitor grabs the scene, the rotate pauses naturally and they can
 * fly the camera around. Pan is disabled so the camera never strays
 * far enough that the scene goes empty.
 */
export function StarFieldHero() {
  // Three independent cloud variants so overlapping sprites don't echo
  // each other's pattern. 512px each (~750KB), built once on mount;
  // mipmaps + anisotropy are set at texture-creation time. Total cost
  // is paid once and the GPU caches all three forever after.
  const textures = useMemo(
    () => ({
      clouds: [
        makeCloudTexture(512, 0x12345678),
        makeCloudTexture(512, 0x9abcdef0),
        makeCloudTexture(512, 0xfeedface),
      ] as ReadonlyArray<THREE.Texture>,
      dust: makeRadialTexture(32, 2.0),
    }),
    []
  );

  return (
    <div className="absolute inset-0 w-full h-full">
      <Suspense fallback={null}>
        <Canvas
          camera={{ position: [0, 1.5, 14], fov: 72, near: 0.1, far: 400 }}
          style={{ background: 'transparent', display: 'block' }}
          dpr={[1, 2]}
          gl={{
            antialias: true,
            powerPreference: 'high-performance',
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.25,
          }}
        >
          <ambientLight intensity={0.2} />

          <GalacticBand textures={textures.clouds} />
          <NebulaField textures={textures.clouds} />

          {/* Four layers of deep starfield - very far / far / mid / near.
              Different sizes and speeds give real parallax when the
              user (or auto-rotate) moves the camera. */}
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
          <DeepStars
            radius={60}
            depth={30}
            count={800}
            factor={7}
            saturation={0.22}
            fade
            speed={0.7}
          />

          <DustField texture={textures.dust} count={650} />

          {/* Interactive controls: drag rotates, scroll zooms, gentle
              auto-rotate when idle. Pan is locked so the camera can't
              wander out of the field. Polar limits keep us from flipping
              upside-down past the galactic plane. */}
          <OrbitControls
            enableRotate
            enableZoom
            enablePan={false}
            autoRotate
            autoRotateSpeed={0.15}
            rotateSpeed={0.45}
            zoomSpeed={0.6}
            minDistance={4}
            maxDistance={55}
            minPolarAngle={Math.PI * 0.18}
            maxPolarAngle={Math.PI * 0.82}
            makeDefault
          />

          <EffectComposer multisampling={0}>
            <Bloom
              intensity={1.55}
              luminanceThreshold={0.14}
              luminanceSmoothing={0.7}
              kernelSize={KernelSize.LARGE}
              mipmapBlur
            />
            {/* Light vignette only - the page text already sits over a
                separate CSS gradient for legibility, so we don't need to
                frame the canvas itself. */}
            <Vignette
              offset={0.35}
              darkness={0.45}
              blendFunction={BlendFunction.NORMAL}
            />
          </EffectComposer>
        </Canvas>
      </Suspense>
    </div>
  );
}
