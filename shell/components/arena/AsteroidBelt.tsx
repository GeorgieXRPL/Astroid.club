'use client';

/**
 * Background asteroid belt.
 *
 * Adds visual depth and "galaxy" scale to the arena: ~1500 small,
 * non-interactive rocks distributed in a thick torus around the world
 * origin, drifting slowly as a single group. Rendered with a single
 * `THREE.InstancedMesh` so the per-frame cost is one draw call and one
 * group rotation — independent of how many instances we add.
 *
 * Composed of two instanced layers so the belt has texture rather than
 * looking like uniform gravel:
 *   - `inner` ring at radius ~30-40, mostly grey C-type carbonaceous.
 *   - `outer` ring at radius ~42-58, mix of grey and rusty rock.
 *
 * The instances are NOT interactive; the named asteroids (rendered by
 * `<AsteroidBody>`) remain the only click targets.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { fbm3, makeNoise3, makeRng } from './noise';

interface BeltLayerProps {
  count: number;
  innerRadius: number;
  outerRadius: number;
  /** Vertical thickness of the torus (±this from y=0). */
  verticalSpread: number;
  scaleMin: number;
  scaleMax: number;
  color: string;
  roughness: number;
  metalness: number;
  rotationSpeed: number;
  seed: number;
}

/** Build one shared rocky geometry for an entire instanced layer. */
function buildSharedRockGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const pos = geo.attributes.position;
  if (!pos) return geo;
  const samplers = [
    makeNoise3((seed + 0x9e37) >>> 0, 8),
    makeNoise3((seed + 0xa42c) >>> 0, 8),
    makeNoise3((seed + 0xbf50) >>> 0, 8),
  ];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length();
    if (len === 0) continue;
    const nx = v.x / len;
    const ny = v.y / len;
    const nz = v.z / len;
    const n = fbm3(samplers, v.x * 1.4, v.y * 1.4, v.z * 1.4);
    const offset = n * 0.32;
    v.set(v.x + nx * offset, v.y + ny * offset, v.z + nz * offset);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function BeltLayer({
  count,
  innerRadius,
  outerRadius,
  verticalSpread,
  scaleMin,
  scaleMax,
  color,
  roughness,
  metalness,
  rotationSpeed,
  seed,
}: BeltLayerProps) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const geometry = useMemo(() => buildSharedRockGeometry(seed), [seed]);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness,
      }),
    [color, roughness, metalness],
  );

  // Place the instances once on mount. Seeded RNG keeps the belt
  // identical across reloads (good for screenshots).
  useEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    const rng = makeRng(seed);
    for (let i = 0; i < count; i++) {
      // Torus distribution.
      const theta = rng() * Math.PI * 2;
      const r = innerRadius + rng() * (outerRadius - innerRadius);
      const y = (rng() - 0.5) * verticalSpread * 2;
      // Slight non-uniform y to fade the belt edges.
      const yFalloff = 1 - Math.abs(y) / verticalSpread;
      const yJitter = y * (0.6 + yFalloff * 0.4);
      dummy.position.set(Math.cos(theta) * r, yJitter, Math.sin(theta) * r);
      dummy.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
      const s = scaleMin + rng() * (scaleMax - scaleMin);
      dummy.scale.set(s, s * (0.85 + rng() * 0.3), s * (0.85 + rng() * 0.3));
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [count, innerRadius, outerRadius, scaleMin, scaleMax, seed, verticalSpread]);

  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * rotationSpeed;
  });

  return (
    <group ref={groupRef}>
      <instancedMesh ref={meshRef} args={[geometry, material, count]} frustumCulled={false} />
    </group>
  );
}

export interface AsteroidBeltProps {
  /** Total count budget. Split between inner and outer layers. */
  count?: number;
}

/**
 * Two-layer asteroid belt. The inner ring sits closer to the named
 * asteroids and shares similar tones; the outer ring fades outward
 * with a touch of rusty colour for warmth.
 */
export function AsteroidBelt({ count = 1500 }: AsteroidBeltProps) {
  const innerCount = Math.round(count * 0.6);
  const outerCount = count - innerCount;

  return (
    <>
      <BeltLayer
        count={innerCount}
        innerRadius={30}
        outerRadius={40}
        verticalSpread={4.5}
        scaleMin={0.05}
        scaleMax={0.18}
        color="#3b3f48"
        roughness={1}
        metalness={0.05}
        rotationSpeed={0.0055}
        seed={0xb1011a}
      />
      <BeltLayer
        count={outerCount}
        innerRadius={42}
        outerRadius={58}
        verticalSpread={6}
        scaleMin={0.04}
        scaleMax={0.16}
        color="#52483c"
        roughness={1}
        metalness={0.05}
        rotationSpeed={0.0035}
        seed={0xc0ffee}
      />
    </>
  );
}
