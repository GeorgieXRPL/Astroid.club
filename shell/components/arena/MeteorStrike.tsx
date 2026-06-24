'use client';

/**
 * A single meteor visual in the 3D arena.
 *
 * Given the target asteroid's orbit parameters (the same pure-function-of-clock
 * motion `AsteroidBody` uses), the meteor streaks in from deep space toward the
 * asteroid's live position over a short window, trailing a glowing tail and
 * casting a warm point light. Once the server resolves the threat the parent
 * flips `mode`:
 *   - `deflected` → a cyan shield burst (the strike was paid off), or
 *   - `struck`    → a red-hot impact shockwave that punches into the rock.
 *
 * All motion is derived from `clock.elapsedTime` so the scene stays
 * deterministic and frame-rate independent.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

import { hashSeed, makeRng } from './noise';

export type MeteorMode = 'incoming' | 'deflected' | 'struck';

export interface MeteorStrikeProps {
  /** Stable id (server meteor id) — also seeds the approach direction. */
  meteorId: string;
  orbitRadius: number;
  orbitSpeed: number;
  orbitPhase: number;
  inclination: number;
  /** Target body radius — sizes the impact shockwave. */
  bodyRadius: number;
  mode: MeteorMode;
  /** Seconds the approach streak takes. */
  approachSeconds?: number;
  /** Called once the resolve animation has fully faded, so the parent can drop it. */
  onDone?: () => void;
}

/** Live world position of the target asteroid at clock time `t`. */
function asteroidPosition(
  t: number,
  orbitPhase: number,
  orbitSpeed: number,
  orbitRadius: number,
  inclination: number,
  out: THREE.Vector3,
): void {
  const angle = orbitPhase + t * orbitSpeed;
  const x = Math.cos(angle) * orbitRadius;
  const zFlat = Math.sin(angle) * orbitRadius;
  out.set(x, Math.sin(inclination) * zFlat, Math.cos(inclination) * zFlat);
}

export function MeteorStrike({
  meteorId,
  orbitRadius,
  orbitSpeed,
  orbitPhase,
  inclination,
  bodyRadius,
  mode,
  approachSeconds = 2.6,
  onDone,
}: MeteorStrikeProps) {
  const headRef = useRef<THREE.Mesh>(null);
  const tailRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const shockRef = useRef<THREE.Mesh>(null);
  const shockMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);

  // Per-meteor random approach direction (unit vector) from a far distance.
  const approach = useMemo(() => {
    const rng = makeRng(hashSeed(meteorId));
    const dir = new THREE.Vector3(rng() * 2 - 1, rng() * 0.8 + 0.3, rng() * 2 - 1).normalize();
    return { dir, distance: 46 + rng() * 10 };
  }, [meteorId]);

  // Clock time the meteor entered its current resolve mode (set on first frame
  // where mode !== 'incoming'). Drives the shockwave/fade timing.
  const resolveStart = useRef<number | null>(null);
  const startElapsed = useRef<number | null>(null);
  const target = useMemo(() => new THREE.Vector3(), []);
  const headPos = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    if (startElapsed.current === null) startElapsed.current = t;

    asteroidPosition(t, orbitPhase, orbitSpeed, orbitRadius, inclination, target);

    if (mode === 'incoming') {
      // Streak from far along `dir` toward the asteroid; ease-in for a sense
      // of acceleration. Hold just off the surface once it arrives, slowly
      // circling, until the parent flips mode.
      const elapsed = t - (startElapsed.current ?? t);
      const p = Math.min(1, elapsed / approachSeconds);
      const eased = p * p;
      const dist = approach.distance * (1 - eased) + bodyRadius * 1.6 * eased;
      // A slow ominous circle once arrived.
      const wobble = p >= 1 ? Math.sin(t * 1.5) * 0.15 : 0;
      headPos.copy(approach.dir).multiplyScalar(dist + wobble).add(target);
      g.position.copy(headPos);

      // Orient the tail back along the travel direction (from asteroid outward).
      if (tailRef.current) {
        tailRef.current.position.set(0, 0, 0);
        const look = approach.dir.clone();
        g.lookAt(target.clone().sub(look)); // face toward target
      }
      if (lightRef.current) lightRef.current.intensity = 2.2 + Math.sin(t * 8) * 0.5;
      if (shockMatRef.current) shockMatRef.current.opacity = 0;
      return;
    }

    // Resolve animation (deflected / struck).
    if (resolveStart.current === null) resolveStart.current = t;
    const rt = t - resolveStart.current;
    const dur = 1.25;
    const k = Math.min(1, rt / dur);

    // The head dives into the asteroid surface and fades.
    headPos.copy(approach.dir).multiplyScalar(bodyRadius * 1.4 * (1 - k)).add(target);
    g.position.copy(headPos);
    const headMat = headRef.current?.material as THREE.MeshBasicMaterial | undefined;
    const tailMat = tailRef.current?.material as THREE.MeshBasicMaterial | undefined;
    if (headMat) headMat.opacity = 1 - k;
    if (tailMat) tailMat.opacity = (1 - k) * 0.8;
    if (lightRef.current) lightRef.current.intensity = (1 - k) * 3;

    // Shockwave ring expands from the impact point.
    if (shockRef.current && shockMatRef.current) {
      shockRef.current.position.copy(target);
      shockRef.current.lookAt(state.camera.position);
      const scale = bodyRadius * (1 + k * 5);
      shockRef.current.scale.setScalar(scale);
      shockMatRef.current.opacity = (1 - k) * 0.8;
    }

    if (k >= 1) onDone?.();
  });

  const isDeflected = mode === 'deflected';
  const hot = isDeflected ? '#5fd6ff' : '#ff7a3c';
  const core = isDeflected ? '#d6f3ff' : '#ffe6b0';

  return (
    <group>
      <group ref={groupRef}>
        {/* Glowing head. */}
        <mesh ref={headRef}>
          <icosahedronGeometry args={[0.42, 1]} />
          <meshBasicMaterial color={core} transparent toneMapped={false} />
        </mesh>
        {/* Stretched tail behind the head along travel direction. */}
        <mesh ref={tailRef} position={[0, 0, 1.6]}>
          <coneGeometry args={[0.32, 3.2, 12, 1, true]} />
          <meshBasicMaterial
            color={hot}
            transparent
            opacity={0.8}
            side={THREE.DoubleSide}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
        <pointLight ref={lightRef} color={hot} distance={14} intensity={2.4} />
      </group>

      {/* Impact / deflect shockwave ring (hidden while incoming). */}
      <mesh ref={shockRef} visible={mode !== 'incoming'}>
        <ringGeometry args={[0.82, 1, 48]} />
        <meshBasicMaterial
          ref={shockMatRef}
          color={hot}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
