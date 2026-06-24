/**
 * Asteroid definitions and resource taxonomy for astroid.club.
 *
 * Ported from `Black-Gold-main/config/mines.ts` per `docs/PORTING_NOTES.md`.
 * Resource taxonomy and mechanics preserved verbatim; entity types renamed
 * Mine→Asteroid; the 20 concrete asteroid entries are intentionally left
 * empty as a TODO for the design pass (naming and placing 20 real-world
 * asteroids on a star map is a creative decision the operator should make
 * deliberately, not one auto-generated during a logic port).
 */

/**
 * Resource taxonomy. The four mechanic classes are
 * `carbon | gold | oil | silver`. The `carbon` class is the
 * carbonaceous, steady-yield asteroid type and is shown to players as
 * "Carbonaceous". Game-formula values are preserved from the audited
 * economy. Player-visible display strings (e.g. "Iron", "Helium-3",
 * "Platinum") are a frontend concern.
 */
export type ResourceType = 'carbon' | 'gold' | 'oil' | 'silver';

/** Asteroid definition with location and resource properties. */
export interface AsteroidDefinition {
  /** Unique asteroid identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Resource type (drives mechanics). */
  resource: ResourceType;
  /**
   * Galactic sector for grouping in UI. Examples used by the design pass:
   * "Inner Belt", "Trojan Cluster", "Kuiper Belt", "Lagrange L4".
   */
  sector: string;
  /**
   * Galactic Cartesian position in arbitrary star-map units. The frontend
   * star-map decides the unit and projection. The server uses this only
   * for display; gameplay logic is location-agnostic.
   */
  position: { x: number; y: number; z: number };
  /** Base discovery time in milliseconds. */
  baseDiscoveryTimeMs: number;
  /** Base reward multiplier. */
  baseRewardMultiplier: number;
  /** Description for UI tooltip. */
  description: string;
  /**
   * Cosmetic flavor name shown to players (e.g. "Iridium", "Helium-3",
   * "Water Ice"). Drives the arena's per-asteroid material tint and label
   * but NEVER drives game mechanics — those are owned by `resource`. Lets
   * us ship 20+ visually-distinct rocks while keeping the four-class
   * economy intact. Optional; defaults to the capitalized `resource`
   * symbol when omitted.
   */
  flavor?: string;
}

/** Resource-specific mechanics configuration. */
export interface ResourceMechanics {
  /** Special ability name. */
  abilityName: string;
  /** Ability description. */
  abilityDescription: string;
  /** Discovery time in ms. */
  discoveryTimeMs: number;
  /** Reward style description. */
  rewardStyle: string;
  /** Resource-specific discovery name (e.g. "Vein"/"Nugget"/"Burst"/"Lode"). */
  discoveryName: string;
  /** Discovery verb. */
  discoveryVerb: string;
  /** Discovery emoji (kept for UI continuity with BG; can be redesigned). */
  discoveryEmoji: string;
}

/**
 * Resource mechanics by type. Numerical values (discovery times, rates,
 * multipliers) are preserved exactly from BG. Only player-facing strings
 * are themed for space (see GLOSSARY.md):
 *
 * - "Gold Rush" → "Stellar Strike"
 * - "Silver Surge" → "Solar Flare"
 *
 * Internal mechanic names that BG used as labels ("Steady Burn",
 * "Speculation", "Syndicate") are kept; they read fine in either setting.
 */
export const RESOURCE_MECHANICS: Record<ResourceType, ResourceMechanics> = {
  carbon: {
    abilityName: 'Steady Drill',
    abilityDescription:
      'No raid immunity, but +10% loyalty bonus after 7 days at the same asteroid.',
    discoveryTimeMs: 5 * 60 * 1000, // 5 minutes
    rewardStyle: 'Small, consistent yields',
    discoveryName: 'Vein',
    discoveryVerb: 'struck',
    discoveryEmoji: '⛏️',
  },
  gold: {
    abilityName: 'Stellar Strike',
    abilityDescription: 'Random 5x jackpot chance per discovery. Attracts raiders.',
    discoveryTimeMs: 20 * 60 * 1000, // 20 minutes
    rewardStyle: 'Large, jackpot-style yields',
    discoveryName: 'Nugget',
    discoveryVerb: 'found',
    discoveryEmoji: '🥇',
  },
  oil: {
    abilityName: 'Syndicate',
    abilityDescription: 'Yields multiply with miner count (up to 3x at 50+ miners).',
    discoveryTimeMs: 10 * 60 * 1000, // 10 minutes
    rewardStyle: 'Scales with group size',
    discoveryName: 'Burst',
    discoveryVerb: 'hit',
    discoveryEmoji: '🛢️',
  },
  silver: {
    abilityName: 'Speculation',
    abilityDescription:
      'High-variance yields (0.5x – 2x random). Extra stake yield during Solar Flare events.',
    discoveryTimeMs: 8 * 60 * 1000, // 8 minutes
    rewardStyle: 'Volatile yields',
    discoveryName: 'Lode',
    discoveryVerb: 'discovered',
    discoveryEmoji: '🥈',
  },
};

/**
 * **Canonical mining roster — 20 asteroids across 4 sectors.**
 *
 * Five asteroids per resource class so every mechanic branch (Steady
 * Drill / Solar Flare / Stellar Strike / Syndicate) is represented at
 * different yield tiers and orbital depths. Real-world asteroid names
 * where possible; orbital positions are arbitrary star-map units (the
 * arena projects them onto a tilted-orbit layout around the world
 * origin) tuned so each `sector` reads as a distinct visual ring.
 *
 * Sector budget:
 *   - Near-Earth      : 4 rocks at orbit radius ~6-9
 *   - Inner Belt      : 6 rocks at orbit radius ~10-14
 *   - Outer Belt      : 6 rocks at orbit radius ~15-22
 *   - Trojan / Kuiper : 4 rocks at orbit radius ~24-30
 *
 * `flavor` is purely cosmetic — it gives every rock a distinct mineral
 * identity ("Iridium", "Helium-3", "Lithium", ...) without growing the
 * server-side resource taxonomy. Game mechanics remain driven by the
 * four classes; tests assert against `resource`, not `flavor`.
 *
 * Discovery times and reward multipliers preserve BG's resource-curve
 * tuning (5/8/10/20 min, multipliers 1.0-2.0) with small per-asteroid
 * variation so the design pass can later differentiate "richer" vs
 * "leaner" rocks within a class.
 */
export const ASTEROIDS: AsteroidDefinition[] = [
  // ===================== Near-Earth (orbit ~6-9) =====================
  {
    id: 'bennu',
    name: 'Bennu',
    resource: 'carbon',
    flavor: 'Carbonaceous',
    sector: 'Near-Earth',
    position: { x: -180, y: 40, z: -90 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1.0,
    description:
      'Near-Earth carbonaceous body. Steady-Drill class — the training rock every new miner learns on.',
  },
  {
    id: 'ryugu',
    name: 'Ryugu',
    resource: 'carbon',
    flavor: 'Hydrated Clay',
    sector: 'Near-Earth',
    position: { x: -150, y: 12, z: 110 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1.05,
    description:
      'Diamond-shaped C-type with hydrated minerals returned by Hayabusa2. Slightly fatter yields than Bennu.',
  },
  {
    id: 'apollo',
    name: 'Apollo',
    resource: 'silver',
    flavor: 'Lithium',
    sector: 'Near-Earth',
    position: { x: 70, y: 25, z: -180 },
    baseDiscoveryTimeMs: 8 * 60 * 1000,
    baseRewardMultiplier: 1.4,
    description:
      'Silicate Near-Earth crosser, lithium-rich pockets. Volatile yields with a Solar-Flare kicker.',
  },
  {
    id: 'eros',
    name: 'Eros',
    resource: 'gold',
    flavor: 'Iron-Nickel',
    sector: 'Near-Earth',
    position: { x: 180, y: -10, z: -150 },
    baseDiscoveryTimeMs: 18 * 60 * 1000,
    baseRewardMultiplier: 1.7,
    description:
      'Closest metallic body to the inner planets. Stellar-Strike class — rare jackpots and frequent raiders.',
  },

  // ===================== Inner Belt (orbit ~10-14) =====================
  {
    id: 'vesta',
    name: 'Vesta',
    resource: 'silver',
    flavor: 'Rare Earths',
    sector: 'Inner Belt',
    position: { x: 220, y: 0, z: 80 },
    baseDiscoveryTimeMs: 8 * 60 * 1000,
    baseRewardMultiplier: 1.5,
    description:
      'Inner-belt protoplanet. Speculation class — high-variance yields with extra payout during Solar Flare events.',
  },
  {
    id: 'eunomia',
    name: 'Eunomia',
    resource: 'silver',
    flavor: 'Cobalt',
    sector: 'Inner Belt',
    position: { x: 240, y: 50, z: -40 },
    baseDiscoveryTimeMs: 8 * 60 * 1000,
    baseRewardMultiplier: 1.55,
    description:
      'S-type heavyweight, cobalt-rich. Volatile by design; pairs with refinery stake for stability.',
  },
  {
    id: 'iris',
    name: 'Iris',
    resource: 'silver',
    flavor: 'Manganese',
    sector: 'Inner Belt',
    position: { x: -260, y: -20, z: 140 },
    baseDiscoveryTimeMs: 8 * 60 * 1000,
    baseRewardMultiplier: 1.45,
    description:
      'Bright inner-belt S-type. Manganese deposits; high Solar Flare amplitude when active.',
  },
  {
    id: 'mathilde',
    name: 'Mathilde',
    resource: 'carbon',
    flavor: 'Sooty Carbon',
    sector: 'Inner Belt',
    position: { x: -210, y: -50, z: -120 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 0.95,
    description:
      'Slow-rotating C-type, sooty surface. Reliable but modest — perfect for the low-variance crowd.',
  },
  {
    id: 'lutetia',
    name: 'Lutetia',
    resource: 'gold',
    flavor: 'Platinum',
    sector: 'Inner Belt',
    position: { x: 290, y: 80, z: -240 },
    baseDiscoveryTimeMs: 20 * 60 * 1000,
    baseRewardMultiplier: 1.85,
    description:
      'Enigmatic M/C-mix; platinum-group veins. Stellar-Strike-class with a slightly tighter jackpot rate than Psyche.',
  },
  {
    id: 'kleopatra',
    name: 'Kleopatra',
    resource: 'gold',
    flavor: 'Palladium',
    sector: 'Inner Belt',
    position: { x: -300, y: 30, z: 180 },
    baseDiscoveryTimeMs: 20 * 60 * 1000,
    baseRewardMultiplier: 1.95,
    description:
      'Dog-bone shaped metallic body with two moons. Palladium-rich. Defenders rally hard here — raiders, expect resistance.',
  },

  // ===================== Outer Belt (orbit ~15-22) =====================
  {
    id: 'psyche',
    name: 'Psyche',
    resource: 'gold',
    flavor: 'Iridium',
    sector: 'Outer Belt',
    position: { x: 360, y: 60, z: -180 },
    baseDiscoveryTimeMs: 20 * 60 * 1000,
    baseRewardMultiplier: 2.0,
    description:
      'The headliner — exposed iron core of a protoplanet. Iridium veins, the fattest jackpots in the belt. Always under raid threat.',
  },
  {
    id: 'davida',
    name: 'Davida',
    resource: 'gold',
    flavor: 'Osmium',
    sector: 'Outer Belt',
    position: { x: 380, y: -30, z: 80 },
    baseDiscoveryTimeMs: 20 * 60 * 1000,
    baseRewardMultiplier: 1.9,
    description:
      'Massive C/M body deep in the belt. Osmium pockets. Slower jackpots but enormous when they hit.',
  },
  {
    id: 'themis',
    name: 'Themis',
    resource: 'oil',
    flavor: 'Water Ice',
    sector: 'Outer Belt',
    position: { x: 280, y: -30, z: 240 },
    baseDiscoveryTimeMs: 10 * 60 * 1000,
    baseRewardMultiplier: 1.25,
    description:
      'Confirmed water ice on the surface. Syndicate class — yields scale up to 3x as more miners commit.',
  },
  {
    id: 'hygiea',
    name: 'Hygiea',
    resource: 'oil',
    flavor: 'Methane Clathrate',
    sector: 'Outer Belt',
    position: { x: -340, y: 70, z: -210 },
    baseDiscoveryTimeMs: 10 * 60 * 1000,
    baseRewardMultiplier: 1.3,
    description:
      'Quasi-spherical C-type, methane clathrates. Strong Syndicate scaling — bring friends.',
  },
  {
    id: 'hilda',
    name: 'Hilda',
    resource: 'carbon',
    flavor: 'Phosphorus',
    sector: 'Outer Belt',
    position: { x: -380, y: -40, z: 60 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1.1,
    description: 'Trojan-resonance D/P-type, phosphorus enriched. Steady-Drill at outer-belt pace.',
  },
  {
    id: 'astraea',
    name: 'Astraea',
    resource: 'silver',
    flavor: 'Titanium',
    sector: 'Outer Belt',
    position: { x: 320, y: 90, z: 200 },
    baseDiscoveryTimeMs: 8 * 60 * 1000,
    baseRewardMultiplier: 1.6,
    description: 'Titanium-bearing S-type. Pronounced Solar Flare events — patience is rewarded.',
  },

  // ===================== Trojan / Kuiper (orbit ~24-30) =====================
  {
    id: 'chariklo',
    name: 'Chariklo',
    resource: 'oil',
    flavor: 'Helium-3',
    sector: 'Trojan / Kuiper',
    position: { x: 480, y: 110, z: -120 },
    baseDiscoveryTimeMs: 10 * 60 * 1000,
    baseRewardMultiplier: 1.45,
    description:
      'Centaur with confirmed rings. Helium-3 reserves; Syndicate scaling caps higher than the Outer Belt.',
  },
  {
    id: 'chiron',
    name: 'Chiron',
    resource: 'oil',
    flavor: 'Hydrogen',
    sector: 'Trojan / Kuiper',
    position: { x: -460, y: -80, z: -260 },
    baseDiscoveryTimeMs: 10 * 60 * 1000,
    baseRewardMultiplier: 1.5,
    description:
      'Volatile-rich Centaur, hydrogen ice. Highest Syndicate ceiling in the world — ideal for crews.',
  },
  {
    id: 'pholus',
    name: 'Pholus',
    resource: 'carbon',
    flavor: 'Methane',
    sector: 'Trojan / Kuiper',
    position: { x: -500, y: 60, z: 220 },
    baseDiscoveryTimeMs: 5 * 60 * 1000,
    baseRewardMultiplier: 1.15,
    description:
      'Reddest body in the solar system; tholin-coated with subsurface methane. Steady-Drill, tinged exotic.',
  },
  {
    id: 'nessus',
    name: 'Nessus',
    resource: 'gold',
    flavor: 'Rhodium',
    sector: 'Trojan / Kuiper',
    position: { x: 520, y: -100, z: 280 },
    baseDiscoveryTimeMs: 22 * 60 * 1000,
    baseRewardMultiplier: 2.1,
    description:
      'Distant Centaur with rhodium signatures. Slowest jackpot cadence; biggest possible single payout in the world.',
  },
];

/** Resource colors for UI theming. Kept verbatim from BG. */
export const RESOURCE_COLORS: Record<
  ResourceType,
  { primary: string; secondary: string; glow: string }
> = {
  carbon: {
    primary: '#1a1a1a',
    secondary: '#4a4a4a',
    glow: '#ff6b35',
  },
  gold: {
    primary: '#ffd700',
    secondary: '#ffec8b',
    glow: '#fff59d',
  },
  oil: {
    primary: '#1a1a2e',
    secondary: '#16213e',
    glow: '#4a69bd',
  },
  silver: {
    primary: '#c0c0c0',
    secondary: '#e8e8e8',
    glow: '#f0f0f0',
  },
};

/** Get all asteroids of a specific resource type. */
export function getAsteroidsByResource(resource: ResourceType): AsteroidDefinition[] {
  return ASTEROIDS.filter((asteroid) => asteroid.resource === resource);
}

/** Get an asteroid by its ID. */
export function getAsteroidById(id: string): AsteroidDefinition | undefined {
  return ASTEROIDS.find((asteroid) => asteroid.id === id);
}

/** Get resource mechanics by type. */
export function getResourceMechanics(resource: ResourceType): ResourceMechanics {
  return RESOURCE_MECHANICS[resource];
}
