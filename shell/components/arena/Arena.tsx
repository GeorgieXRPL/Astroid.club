'use client';

/**
 * The 3D arena scene.
 *
 * One Three.js Canvas containing the cosmic backdrop, four orbiting
 * asteroid bodies, the camera + OrbitControls, and the post-processing
 * pass (Bloom + Vignette). The HUD lives outside the canvas in
 * `ArenaPage` and overlays the canvas in pure DOM.
 *
 * Camera + controls match the public Astroid.club hero so the two
 * scenes share the same "feel": ACES tone-mapping, large-kernel bloom,
 * idle auto-rotate that pauses on user interaction, polar limits that
 * keep the camera from flipping past the galactic plane.
 */

import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { BlendFunction, KernelSize } from 'postprocessing';
import { Component, type ReactNode, Suspense, useEffect, useState } from 'react';
import * as THREE from 'three';

import { isWebGLAvailable } from '../../lib/webgl';
import { ArenaFallback } from './ArenaFallback';
import { AsteroidBelt } from './AsteroidBelt';
import { AsteroidBody } from './AsteroidBody';
import { MeteorStrike, type MeteorMode } from './MeteorStrike';
import { Starfield } from './Starfield';
import { asResourceKind, orbitFromListing } from './asteroid-orbits';

export interface ArenaAsteroid {
  id: string;
  name: string;
  resource: string;
  flavor: string;
  sector: string;
  position: { x: number; y: number; z: number };
}

/** A live meteor threat to visualise against a target asteroid. */
export interface ArenaMeteor {
  meteorId: string;
  asteroidId: string;
  mode: MeteorMode;
}

export interface ArenaProps {
  asteroids: ReadonlyArray<ArenaAsteroid>;
  selectedAsteroidId: string | null;
  homeAsteroidId: string | null;
  activeAsteroidId: string | null;
  onSelectAsteroid: (id: string) => void;
  /** Active/resolving meteor strikes to render. */
  meteors?: ReadonlyArray<ArenaMeteor>;
}

export function Arena(props: ArenaProps) {
  // Probe WebGL on the client before committing to the canvas. `null`
  // = still checking (render nothing; the global CSS starfield already
  // paints the backdrop), `false` = degrade to the 2D fallback so the
  // game stays playable on machines without a usable GPU context.
  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  useEffect(() => {
    setWebglOk(isWebGLAvailable());
  }, []);

  if (webglOk === null) return null;
  if (webglOk === false) return <ArenaFallback {...props} />;

  // The probe can pass and yet context allocation still fail at render
  // time (e.g. a flaky GPU process in a VM). The error boundary catches
  // that and swaps in the same 2D fallback rather than crashing the page.
  return (
    <WebGLErrorBoundary fallback={<ArenaFallback {...props} />}>
      <ArenaCanvas {...props} />
    </WebGLErrorBoundary>
  );
}

function ArenaCanvas({
  asteroids,
  selectedAsteroidId,
  homeAsteroidId,
  activeAsteroidId,
  onSelectAsteroid,
  meteors = [],
}: ArenaProps) {
  return (
    <Canvas
      camera={{ position: [0, 8, 38], fov: 60, near: 0.1, far: 600 }}
      dpr={[1, 2]}
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.25,
      }}
      style={{ background: 'transparent', display: 'block' }}
    >
      <Suspense fallback={null}>
        <ambientLight intensity={0.35} />
        {/* A single warm key light gives the rocks side-lit drama
            without flattening the metallic gold shading. */}
        <directionalLight position={[18, 12, 8]} intensity={1.4} color="#ffe7c8" />
        {/* A cold rim light from behind picks out the silhouettes
            against the nebula glow. */}
        <directionalLight position={[-12, -4, -10]} intensity={0.5} color="#9bd5ff" />

        <Starfield />

        {/* Background asteroid belt — adds galactic depth without
            stealing focus from the named (clickable) rocks. */}
        <AsteroidBelt count={1500} />

        {asteroids.map((a) => {
          const orbit = orbitFromListing({
            id: a.id,
            sector: a.sector,
            position: a.position,
          });
          return (
            <AsteroidBody
              key={a.id}
              asteroidId={a.id}
              name={a.name}
              resource={asResourceKind(a.resource)}
              flavor={a.flavor}
              orbitRadius={orbit.orbitRadius}
              orbitSpeed={orbit.orbitSpeed}
              orbitPhase={orbit.orbitPhase}
              inclination={orbit.inclination}
              bodyRadius={orbit.bodyRadius}
              axialScale={orbit.axialScale}
              selected={selectedAsteroidId === a.id}
              isHome={homeAsteroidId === a.id}
              isActive={activeAsteroidId === a.id}
              onSelect={() => onSelectAsteroid(a.id)}
            />
          );
        })}

        {/* Ambient branding (mascot flythrough) temporarily disabled — will be
            re-enabled with updated art. */}
        {/* <RocketFlythrough asteroids={asteroids} /> */}

        {meteors.map((m) => {
          const a = asteroids.find((x) => x.id === m.asteroidId);
          if (!a) return null;
          const orbit = orbitFromListing({ id: a.id, sector: a.sector, position: a.position });
          return (
            <MeteorStrike
              key={m.meteorId}
              meteorId={m.meteorId}
              orbitRadius={orbit.orbitRadius}
              orbitSpeed={orbit.orbitSpeed}
              orbitPhase={orbit.orbitPhase}
              inclination={orbit.inclination}
              bodyRadius={orbit.bodyRadius}
              mode={m.mode}
            />
          );
        })}

        <OrbitControls
          autoRotate
          autoRotateSpeed={0.18}
          enablePan={false}
          enableRotate
          enableZoom
          makeDefault
          maxDistance={90}
          maxPolarAngle={Math.PI * 0.82}
          minDistance={6}
          minPolarAngle={Math.PI * 0.18}
          rotateSpeed={0.45}
          zoomSpeed={0.6}
        />

        <EffectComposer multisampling={0}>
          <Bloom
            intensity={1.2}
            kernelSize={KernelSize.LARGE}
            luminanceSmoothing={0.7}
            luminanceThreshold={0.18}
            mipmapBlur
          />
          <Vignette blendFunction={BlendFunction.NORMAL} darkness={0.5} offset={0.3} />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}

/**
 * Catches synchronous render/init failures from the WebGL canvas (the
 * Three.js renderer throws "Error creating WebGL context" when the GPU
 * process can't hand back a context) and shows the 2D fallback instead
 * of letting the error bubble up and blank the whole route.
 */
class WebGLErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
