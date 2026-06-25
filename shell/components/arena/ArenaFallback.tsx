'use client';

/**
 * 2D fallback for the arena when WebGL is unavailable.
 *
 * Mirrors `ArenaProps` so it's a drop-in replacement for the Three.js
 * `<Arena>` canvas. Renders each asteroid as a clickable card laid out
 * in a responsive grid, preserving the selected / home / mining state
 * the HUD relies on. Everything the player needs to drive the game loop
 * (select → mine / stake / raid via the overlay panels) keeps working,
 * so a missing GPU context degrades the experience without breaking it.
 */

import { RESOURCE_LABEL, asResourceKind } from './asteroid-orbits';
import type { ArenaProps } from './Arena';

export function ArenaFallback({
  asteroids,
  selectedAsteroidId,
  homeAsteroidId,
  activeAsteroidId,
  onSelectAsteroid,
}: ArenaProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-y-auto px-4 py-20 sm:px-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-300/90">
            Lite mode · 3D unavailable
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            Your browser couldn&rsquo;t start a WebGL/GPU context, so the cinematic view is off. The
            map below is fully playable. Pick an asteroid to mine, stake, or raid.
          </p>
        </div>

        {asteroids.length === 0 ? (
          <p className="py-12 text-center font-mono text-xs uppercase tracking-[0.2em] text-white/40">
            Sign in to load the asteroid field
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {asteroids.map((a) => {
              const resource = asResourceKind(a.resource);
              const isSelected = selectedAsteroidId === a.id;
              const isHome = homeAsteroidId === a.id;
              const isActive = activeAsteroidId === a.id;
              return (
                <li key={a.id}>
                  <button
                    aria-pressed={isSelected}
                    className={`pointer-events-auto w-full rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? 'border-cosmos/60 bg-cosmos/10'
                        : 'border-white/10 bg-space-950/60 hover:border-white/25 hover:bg-space-950/80'
                    }`}
                    onClick={() => onSelectAsteroid(a.id)}
                    type="button"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className={`resource-dot resource-dot--${resource}`} />
                      <span className="font-display text-base text-white">{a.name}</span>
                      {isActive && (
                        <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.16em] text-cosmos">
                          Mining
                        </span>
                      )}
                      {isHome && !isActive && (
                        <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.16em] text-ember">
                          Home
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                      {a.flavor} · {a.sector}
                    </p>
                    <p className="mt-1 text-xs text-white/55">{RESOURCE_LABEL[resource]}</p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
