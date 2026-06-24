'use client';

/**
 * Left-rail navigation guide for the arena (roadmap §3.3).
 *
 * Lists the player's **home** planet, the planet they're **actively mining**,
 * every planet with **active miners**, and any planet currently **under threat**
 * (inbound raids or an incoming meteor). Clicking a row focuses/selects that
 * asteroid in the 3D scene. Doubles as the attacker/meteor notification surface:
 * each row shows live badges (miners, ⚔ inbound raids, ☄ meteor).
 */

import { useState } from 'react';

import type { AsteroidListing, NetworkStatsSnapshot } from '../../lib/session';
import { asResourceKind, type ResourceKind } from './asteroid-orbits';

const RESOURCE_DOT: Record<ResourceKind, string> = {
  carbon: '#9ca3af',
  silver: '#cbd5e1',
  gold: '#fbbf24',
  oil: '#a78bfa',
};

export interface NavRailProps {
  asteroids: ReadonlyArray<AsteroidListing>;
  stats: NetworkStatsSnapshot | null;
  /** Asteroid ids with an incoming (not-yet-resolved) meteor. */
  meteorAsteroidIds: ReadonlyArray<string>;
  selectedId: string | null;
  homeId: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
}

interface Row {
  id: string;
  name: string;
  resource: ResourceKind;
  miners: number;
  raids: number;
  meteor: boolean;
  isHome: boolean;
  isActive: boolean;
  priority: number;
}

export function NavRail({
  asteroids,
  stats,
  meteorAsteroidIds,
  selectedId,
  homeId,
  activeId,
  onSelect,
}: NavRailProps) {
  const [navOpen, setNavOpen] = useState(true);
  const [raidsOpen, setRaidsOpen] = useState(true);

  const meteorSet = new Set(meteorAsteroidIds);
  const statFor = (id: string) => stats?.asteroids.find((a) => a.asteroidId === id);

  const rows: Row[] = asteroids
    .map((a) => {
      const s = statFor(a.id);
      const miners = s?.minerCount ?? 0;
      const raids = s?.activeRaidCount ?? 0;
      const meteor = meteorSet.has(a.id);
      const isHome = homeId === a.id;
      const isActive = activeId === a.id;
      // Higher priority floats to the top of the rail.
      let priority = 0;
      if (meteor) priority += 100;
      if (raids > 0) priority += 80;
      if (isActive) priority += 40;
      if (isHome) priority += 30;
      if (miners > 0) priority += 10 + Math.min(miners, 9);
      return {
        id: a.id,
        name: a.name,
        resource: asResourceKind(a.resource),
        miners,
        raids,
        meteor,
        isHome,
        isActive,
        priority,
      };
    })
    // Show home + active always; otherwise only "interesting" rocks (mined or
    // under threat) so the rail stays focused as the fleet grows.
    .filter((r) => r.isHome || r.isActive || r.miners > 0 || r.raids > 0 || r.meteor)
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  // Asteroids currently under an active raid (or an inbound meteor) — surfaced
  // as their own "threats" list so players can jump straight to the action.
  const raidRows = rows
    .filter((r) => r.raids > 0 || r.meteor)
    .sort((a, b) => b.raids - a.raids || a.name.localeCompare(b.name));

  if (rows.length === 0 && raidRows.length === 0) return null;

  return (
    <nav
      aria-label="Navigation guide"
      className="pointer-events-auto z-10 hidden max-h-[55vh] w-56 flex-col overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-2 backdrop-blur-md sm:flex"
    >
      {raidRows.length > 0 && (
        <section className="mb-1">
          <SectionHeader
            count={raidRows.length}
            label="Active raids"
            onToggle={() => setRaidsOpen((o) => !o)}
            open={raidsOpen}
            tone="rose"
          />
          {raidsOpen && (
            <ul className="space-y-1">
              {raidRows.map((r) => {
                const selected = selectedId === r.id;
                return (
                  <li key={`raid-${r.id}`}>
                    <button
                      aria-current={selected ? 'true' : undefined}
                      className={[
                        'flex w-full items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left transition',
                        selected ? 'bg-white/15' : 'hover:bg-white/10',
                        r.meteor ? 'border-orange-400/40' : 'border-rose-400/30',
                      ].join(' ')}
                      onClick={() => onSelect(r.id)}
                      type="button"
                    >
                      <span className="truncate font-mono text-[12px] text-white/90">{r.name}</span>
                      <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
                        {r.raids > 0 && <span className="text-rose-300">⚔ {r.raids}</span>}
                        {r.meteor && (
                          <span className="animate-pulse text-orange-300">☄</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section>
        <SectionHeader
          count={rows.length}
          label="Navigation"
          onToggle={() => setNavOpen((o) => !o)}
          open={navOpen}
        />
        {navOpen && (
          <ul className="space-y-1">
            {rows.map((r) => {
              const selected = selectedId === r.id;
              return (
                <li key={r.id}>
                  <button
                    aria-current={selected ? 'true' : undefined}
                    className={[
                      'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition',
                      selected ? 'bg-white/15 ring-1 ring-white/30' : 'hover:bg-white/10',
                      r.meteor ? 'ring-1 ring-orange-400/40' : '',
                    ].join(' ')}
                    onClick={() => onSelect(r.id)}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: RESOURCE_DOT[r.resource],
                        boxShadow: r.isActive ? '0 0 8px 1px rgba(74,222,128,0.9)' : undefined,
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[12px] text-white/90">
                          {r.name}
                        </span>
                        {r.isHome && (
                          <span className="shrink-0 rounded bg-sky-400/15 px-1 font-mono text-[8px] uppercase tracking-wider text-sky-300">
                            Home
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-white/45">
                        {r.miners > 0 && (
                          <span className={r.isActive ? 'text-emerald-300' : undefined}>
                            ⛏ {r.miners}
                          </span>
                        )}
                        {r.raids > 0 && <span className="text-rose-300">⚔ {r.raids}</span>}
                        {r.meteor && <span className="animate-pulse text-orange-300">☄ inbound</span>}
                        {r.miners === 0 && r.raids === 0 && !r.meteor && <span>idle</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </nav>
  );
}

/** Collapsible section header with a large, easy-to-tap chevron. */
function SectionHeader({
  label,
  count,
  open,
  onToggle,
  tone,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tone?: 'rose';
}) {
  return (
    <button
      aria-expanded={open}
      className="mb-1.5 flex w-full items-center justify-between rounded px-1 pb-1 pt-0.5 transition hover:bg-white/5"
      onClick={onToggle}
      type="button"
    >
      <span className="flex items-center gap-1.5">
        <span className={`telemetry-label ${tone === 'rose' ? '!text-rose-300' : ''}`}>{label}</span>
        <span className="font-mono text-[10px] text-white/35">{count}</span>
      </span>
      <span aria-hidden className="text-base leading-none text-white/55">
        {open ? '▾' : '▸'}
      </span>
    </button>
  );
}
