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
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Stars as DeepStars } from '@react-three/drei';
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
 * Soft cloud texture for the Milky Way band and large nebulae.
 * Layered low-frequency value noise - no image assets needed.
 */
function makeCloudTexture(size: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  let s = 0x9e3779b1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const N = 32;
  const noise: number[] = [];
  for (let i = 0; i < N * N; i++) noise.push(rnd());
  const sample = (u: number, v: number) => {
    const x = u * (N - 1);
    const y = v * (N - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = Math.min(N - 1, x0 + 1);
    const y1 = Math.min(N - 1, y0 + 1);
    const a = noise[y0 * N + x0];
    const b = noise[y0 * N + x1];
    const c = noise[y1 * N + x0];
    const d2 = noise[y1 * N + x1];
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return (
      a * (1 - sx) * (1 - sy) +
      b * sx * (1 - sy) +
      c * (1 - sx) * sy +
      d2 * sx * sy
    );
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      const n =
        sample(x / size, y / size) * 0.65 +
        sample((x * 2.3) / size, (y * 2.3) / size) * 0.35;
      const radial = Math.max(0, 1 - d);
      const a = Math.pow(radial, 1.3) * Math.pow(n, 1.4);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/*  Background structures                                                      */
/* -------------------------------------------------------------------------- */

interface NebulaCloud {
  position: [number, number, number];
  scale: number;
  color: string;
  opacity: number;
}

// Hand-tuned, deliberately few and large. Sit far beyond the star shell.
const NEBULAE: ReadonlyArray<NebulaCloud> = [
  { position: [-60, 6, -90], scale: 110, color: '#3b3a8a', opacity: 0.32 },
  { position: [70, -10, -85], scale: 130, color: '#7a2a6a', opacity: 0.22 },
  { position: [10, 22, 95], scale: 100, color: '#1f5d8a', opacity: 0.28 },
  { position: [-55, -18, 80], scale: 90, color: '#6b3a1f', opacity: 0.18 },
  { position: [40, -40, -10], scale: 80, color: '#1f3d6b', opacity: 0.22 },
  { position: [-30, 40, 30], scale: 70, color: '#5a1f6b', opacity: 0.18 },
];

function NebulaField({ texture }: { texture: THREE.Texture }) {
  return (
    <group>
      {NEBULAE.map((c, i) => (
        <sprite key={i} position={c.position} scale={c.scale}>
          <spriteMaterial
            map={texture}
            color={c.color}
            transparent
            opacity={c.opacity}
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
 * Milky-Way-style band: long stretched cloud sprite tilted across the
 * scene. Suggests a galactic plane the camera is moving through.
 */
function GalacticBand({ texture }: { texture: THREE.Texture }) {
  return (
    <group rotation={[0.15, 0, 0.4]}>
      <sprite position={[0, 0, -60]} scale={[260, 50, 1]}>
        <spriteMaterial
          map={texture}
          color="#5a4a8a"
          transparent
          opacity={0.32}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
        />
      </sprite>
      <sprite position={[10, -2, -55]} scale={[200, 32, 1]}>
        <spriteMaterial
          map={texture}
          color="#9a4a6a"
          transparent
          opacity={0.18}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest={false}
        />
      </sprite>
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
/*  Camera drift (explorer feel)                                               */
/* -------------------------------------------------------------------------- */

function CameraDrift() {
  const { camera } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = 6;
    const speed = 0.06;
    const x = Math.cos(t * speed) * r;
    const z = Math.sin(t * speed) * r * 0.6 - 4;
    const y = Math.sin(t * speed * 0.7) * 1.4;
    camera.position.set(x, y, z);
    const look = new THREE.Vector3(
      Math.cos(t * speed + 0.3) * (r + 2),
      Math.sin(t * speed * 0.7 + 0.2) * 1.0,
      Math.sin(t * speed + 0.3) * r * 0.6 - 8
    );
    camera.lookAt(look);
    camera.rotation.z += Math.sin(t * 0.25) * 0.0008;
  });
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Top-level scene                                                            */
/* -------------------------------------------------------------------------- */

export function StarFieldHero() {
  const textures = useMemo(
    () => ({
      cloud: makeCloudTexture(256),
      dust: makeRadialTexture(32, 2.0),
    }),
    []
  );

  return (
    <div className="absolute inset-0 w-full h-full">
      <Suspense fallback={null}>
        <Canvas
          camera={{ position: [0, 1.5, 14], fov: 72, near: 0.1, far: 400 }}
          style={{ background: 'transparent' }}
          dpr={[1, 2]}
          gl={{
            antialias: true,
            powerPreference: 'high-performance',
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.2,
          }}
        >
          <ambientLight intensity={0.18} />

          <GalacticBand texture={textures.cloud} />
          <NebulaField texture={textures.cloud} />

          {/* Three layers of deep starfield: very far / mid / near, each
              with different sizes and speeds, so the drift produces parallax. */}
          <DeepStars
            radius={300}
            depth={140}
            count={14000}
            factor={2.5}
            saturation={0.05}
            fade
            speed={0.15}
          />
          <DeepStars
            radius={180}
            depth={90}
            count={6000}
            factor={4}
            saturation={0.1}
            fade
            speed={0.3}
          />
          <DeepStars
            radius={90}
            depth={50}
            count={1800}
            factor={6}
            saturation={0.15}
            fade
            speed={0.55}
          />

          <DustField texture={textures.dust} count={500} />

          <CameraDrift />

          <EffectComposer multisampling={0}>
            <Bloom
              intensity={1.25}
              luminanceThreshold={0.16}
              luminanceSmoothing={0.65}
              kernelSize={KernelSize.LARGE}
              mipmapBlur
            />
            <Vignette
              offset={0.2}
              darkness={0.78}
              blendFunction={BlendFunction.NORMAL}
            />
          </EffectComposer>
        </Canvas>
      </Suspense>
    </div>
  );
}
