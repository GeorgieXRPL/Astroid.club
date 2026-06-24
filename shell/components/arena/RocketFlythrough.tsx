'use client';

/**
 * Ambient branding moment for the arena (roadmap §3.5): Astroid — the dog
 * mascot riding his rocket — periodically flies a curved path between two of
 * the named asteroids, then rests off-screen before the next trip. The play:
 * the mascot ("Astroid") mines asteroids with $ASTROID, so he literally drifts
 * planet-to-planet across the belt.
 *
 * Rendered as a camera-facing billboard sprite of the mascot art
 * (`/mascot-rocket.png`), horizontally flipped so the rocket nose always leads
 * the direction of travel. Trips are timed off `clock.elapsedTime` and the
 * endpoints track each asteroid's live orbit position (same pure motion
 * `AsteroidBody` uses), so he genuinely flies "from planet to planet".
 */

import { useTexture } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { ArenaAsteroid } from './Arena';
import { orbitFromListing } from './asteroid-orbits';

const MASCOT_SRC = '/mascot-rocket.png';
/** Source art aspect (width / height) after background crop. */
const MASCOT_ASPECT = 275 / 166;

interface OrbitNode {
  orbitRadius: number;
  orbitSpeed: number;
  orbitPhase: number;
  inclination: number;
}

function nodePosition(t: number, n: OrbitNode, out: THREE.Vector3): void {
  const angle = n.orbitPhase + t * n.orbitSpeed;
  const x = Math.cos(angle) * n.orbitRadius;
  const zFlat = Math.sin(angle) * n.orbitRadius;
  out.set(x, Math.sin(n.inclination) * zFlat, Math.cos(n.inclination) * zFlat);
}

export interface RocketFlythroughProps {
  asteroids: ReadonlyArray<ArenaAsteroid>;
  /** Seconds a single flight lasts. */
  flightSeconds?: number;
  /** Rest window (seconds) between flights — randomised within ±50%. */
  restSeconds?: number;
  /** Mascot sprite height in scene units (width derives from the art aspect). */
  height?: number;
}

export function RocketFlythrough({
  asteroids,
  flightSeconds = 9,
  restSeconds = 45,
  height = 3,
}: RocketFlythroughProps) {
  const groupRef = useRef<THREE.Group>(null);
  const spriteRef = useRef<THREE.Sprite>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  const texture = useTexture(MASCOT_SRC, (t) => {
    const tex = t as THREE.Texture;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  });

  const baseW = height * MASCOT_ASPECT;

  const nodes = useMemo<OrbitNode[]>(
    () =>
      asteroids.map((a) => {
        const o = orbitFromListing({ id: a.id, sector: a.sector, position: a.position });
        return {
          orbitRadius: o.orbitRadius,
          orbitSpeed: o.orbitSpeed,
          orbitPhase: o.orbitPhase,
          inclination: o.inclination,
        };
      }),
    [asteroids],
  );

  // Mutable trip state (kept in refs so it survives frames without re-render).
  const trip = useRef<{
    from: number;
    to: number;
    start: number; // clock time the flight began
    bow: THREE.Vector3; // sideways/upward arc offset
    nextAt: number; // clock time the next flight should begin (during rest)
  } | null>(null);

  const a = useMemo(() => new THREE.Vector3(), []);
  const b = useMemo(() => new THREE.Vector3(), []);
  const ctrl = useMemo(() => new THREE.Vector3(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const prev = useMemo(() => new THREE.Vector3(), []);
  const vel = useMemo(() => new THREE.Vector3(), []);
  const camRight = useMemo(() => new THREE.Vector3(), []);

  function planTrip(now: number, stagger = 0): void {
    if (nodes.length < 2) {
      trip.current = null;
      return;
    }
    const from = Math.floor(Math.random() * nodes.length) % nodes.length;
    let to = Math.floor(Math.random() * nodes.length) % nodes.length;
    if (to === from) to = (to + 1) % nodes.length;
    // A sideways + upward bow so the path arcs rather than going dead-straight.
    const side = (Math.random() - 0.5) * 14;
    const lift = 6 + Math.random() * 8;
    trip.current = {
      from,
      to,
      start: now + stagger,
      bow: new THREE.Vector3(side, lift, side * 0.5),
      nextAt: 0,
    };
  }

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;

    if (nodes.length < 2) {
      g.visible = false;
      return;
    }

    // First-ever plan: hold the first flight back a while so the mascot
    // doesn't buzz the scene right on load.
    if (!trip.current) planTrip(t, 12);
    const cur = trip.current;
    if (!cur) {
      g.visible = false;
      return;
    }

    // Resting between flights.
    if (cur.nextAt !== 0) {
      g.visible = false;
      if (t >= cur.nextAt) planTrip(t);
      return;
    }

    // Pre-flight stagger (start is in the future on the first trip).
    if (t < cur.start) {
      g.visible = false;
      return;
    }

    const p = (t - cur.start) / flightSeconds;
    if (p >= 1) {
      // Land + schedule the next flight after a randomised rest.
      g.visible = false;
      cur.nextAt = t + restSeconds * (0.5 + Math.random());
      return;
    }

    g.visible = true;
    nodePosition(t, nodes[cur.from]!, a);
    nodePosition(t, nodes[cur.to]!, b);
    // Quadratic bezier through a bowed control point between the endpoints.
    ctrl.copy(a).add(b).multiplyScalar(0.5).add(cur.bow);
    const omp = 1 - p;
    pos
      .copy(a)
      .multiplyScalar(omp * omp)
      .addScaledVector(ctrl, 2 * omp * p)
      .addScaledVector(b, p * p);

    g.position.copy(pos);

    // Flip the sprite so the rocket nose leads its on-screen travel direction.
    // The art faces right, so face right when moving screen-right.
    vel.copy(pos).sub(prev);
    prev.copy(pos);
    if (spriteRef.current && vel.lengthSq() > 1e-6) {
      camRight.setFromMatrixColumn(state.camera.matrixWorld, 0);
      const facing = vel.dot(camRight) >= 0 ? 1 : -1;
      spriteRef.current.scale.set(facing * baseW, height, 1);
    }

    // Subtle engine glow that plays with the scene bloom.
    if (lightRef.current) lightRef.current.intensity = 1.4 + Math.sin(t * 28) * 0.4;
  });

  return (
    <group ref={groupRef} visible={false}>
      <sprite ref={spriteRef} scale={[baseW, height, 1]}>
        <spriteMaterial map={texture} transparent depthWrite={false} />
      </sprite>
      <pointLight ref={lightRef} color="#7fc4ff" distance={9} intensity={1.6} />
    </group>
  );
}
