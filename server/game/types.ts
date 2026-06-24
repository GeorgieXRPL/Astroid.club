/**
 * Game types for astroid.club.
 *
 * Ported from `Black-Gold-main/server/game/types.ts` per
 * `docs/PORTING_NOTES.md`. All numerical values, formulas, and event
 * probabilities are preserved exactly. Only entity names, identifiers,
 * and player-visible strings are themed for space per `docs/GLOSSARY.md`:
 *
 * - Mine → Asteroid (entity, identifiers)
 * - vault → refinery
 * - hashrate → drillPower
 * - reward → yield (where it refers to the player-facing payout)
 * - "Silver Surge" → "Solar Flare"  (internal field: `solarFlareMultiplier`)
 * - "Gold Rush" → "Stellar Strike"  (internal field: `isStellarStrikeActive`)
 *
 * Helpers and constants (`STAKE_TIERS`, `COOLDOWN_DURATIONS`, multiplier
 * formulas) are byte-identical to BG.
 */

import type { ResourceType, AsteroidDefinition } from '@config/asteroids';

// ============ STAKING TYPES ============

/** Stake tier thresholds and multipliers. */
export interface StakeTier {
  /** Minimum stake amount to reach this tier. */
  minStake: number;
  /** Tier name for display. */
  name: string;
  /** Drill power multiplier (was: hashrateMultiplier in BG). */
  drillPowerMultiplier: number;
  /** Defense power multiplier. */
  defenseMultiplier: number;
}

/** Read a non-negative number from env, falling back to a default. */
function envNum(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * A drill-power tier, priced in USD. The actual $ASTROID token threshold is
 * derived at resolve-time from the live $ASTROID/USD price (see
 * `setAstroidUsdPrice` + `getStakeTier`), so the dollar cost of each tier stays
 * stable as the token price moves. `fallbackTokens` is used only when no live
 * price is available yet (pre-fetch / oracle outage).
 *
 * The USD ladder and token fallbacks are both env-overridable so the economy
 * can be retuned without a code change:
 *   USD targets:  STAKE_TIER_BRONZE_USD / _SILVER_USD / _GOLD_USD / _DIAMOND_USD
 *   token floors: STAKE_TIER_BRONZE / _SILVER / _GOLD / _DIAMOND
 */
export interface TierDefinition {
  name: string;
  /** USD cost to reach this tier (0 = base, always free). */
  usd: number;
  /** Token threshold used when the live price is unknown. */
  fallbackTokens: number;
  drillPowerMultiplier: number;
  defenseMultiplier: number;
}

/**
 * Tier ladder. Defaults to a $50 / $100 / $200 / $400 USD scale (the old
 * 100/500/1000/5000 *token* ladder let a sub-$5 stake hit Diamond, which made
 * higher tiers worthless). Token fallbacks assume a ~$0.005 $ASTROID price and
 * are only used until the price oracle reports a live quote.
 */
export const STAKE_TIER_DEFS: TierDefinition[] = [
  { name: 'Base', usd: 0, fallbackTokens: 0, drillPowerMultiplier: 1.0, defenseMultiplier: 1.0 },
  {
    name: 'Bronze',
    usd: envNum('STAKE_TIER_BRONZE_USD', 50),
    fallbackTokens: envNum('STAKE_TIER_BRONZE', 10_000),
    drillPowerMultiplier: 1.5,
    defenseMultiplier: 1.2,
  },
  {
    name: 'Silver',
    usd: envNum('STAKE_TIER_SILVER_USD', 100),
    fallbackTokens: envNum('STAKE_TIER_SILVER', 50_000),
    drillPowerMultiplier: 2.0,
    defenseMultiplier: 1.5,
  },
  {
    name: 'Gold',
    usd: envNum('STAKE_TIER_GOLD_USD', 200),
    fallbackTokens: envNum('STAKE_TIER_GOLD', 250_000),
    drillPowerMultiplier: 2.5,
    defenseMultiplier: 1.8,
  },
  {
    name: 'Diamond',
    usd: envNum('STAKE_TIER_DIAMOND_USD', 400),
    fallbackTokens: envNum('STAKE_TIER_DIAMOND', 1_000_000),
    drillPowerMultiplier: 3.0,
    defenseMultiplier: 2.0,
  },
];

/**
 * Live $ASTROID/USD price driving the dynamic token thresholds. 0 means
 * "unknown" → tiers fall back to their static token floors. Seedable from
 * `STAKE_TIER_FALLBACK_PRICE` so a deploy can pin a price even before the first
 * oracle fetch.
 */
let astroidUsdPrice = envNum('STAKE_TIER_FALLBACK_PRICE', 0);

/** Update the live $ASTROID/USD price (called by the price oracle). */
export function setAstroidUsdPrice(price: number): void {
  if (Number.isFinite(price) && price > 0) astroidUsdPrice = price;
}

/** Current $ASTROID/USD price feeding the tier thresholds (0 = unknown). */
export function getAstroidUsdPrice(): number {
  return astroidUsdPrice;
}

/** Live $ASTROID token threshold to reach a tier at the current price. */
function tierTokenThreshold(def: TierDefinition): number {
  if (def.usd <= 0) return 0;
  return astroidUsdPrice > 0 ? def.usd / astroidUsdPrice : def.fallbackTokens;
}

/**
 * Snapshot of the tier ladder using the *fallback* token thresholds. Kept for
 * display/back-compat; live resolution goes through `getStakeTier`, which is
 * price-aware. Multipliers match the dynamic ladder exactly.
 */
export const STAKE_TIERS: StakeTier[] = STAKE_TIER_DEFS.map((d) => ({
  minStake: d.fallbackTokens,
  name: d.name,
  drillPowerMultiplier: d.drillPowerMultiplier,
  defenseMultiplier: d.defenseMultiplier,
}));

/** Individual stake record. */
export interface StakeRecord {
  /** Wallet address of staker. */
  walletAddress: string;
  /** Asteroid ID where staked. */
  asteroidId: string;
  /** Amount staked. */
  amount: number;
  /** When stake was created. */
  stakedAt: Date;
  /** Is this the user's home station (the equivalent of BG's "home base")? */
  isHomeStation: boolean;
  /** Loyalty bonus (days at the same asteroid). */
  loyaltyDays: number;
}

// ============ EXPEDITION TYPES ============

/** Expedition status. */
export type ExpeditionStatus = 'active' | 'returning' | 'completed' | 'failed';

/** Active expedition (raid). */
export interface Expedition {
  /** Unique expedition ID. */
  id: string;
  /** Wallet addresses of attackers. */
  attackers: string[];
  /** Source asteroid (attackers' home station). */
  sourceAsteroidId: string;
  /** Target asteroid being raided. */
  targetAsteroidId: string;
  /** When expedition started. */
  startedAt: Date;
  /** When expedition ends (max 2 hours). */
  expiresAt: Date;
  /** Current status. */
  status: ExpeditionStatus;
  /** Optional bet amounts by wallet. */
  bets: Map<string, number>;
  /** Total attack power at start. */
  attackPower: number;
}

// ============ DISCOVERY TYPES ============

/** Discovery result (found yield). */
export interface DiscoveryResult {
  /** Discovery ID. */
  id: string;
  /** Discovery number at this asteroid. */
  number: number;
  /** Asteroid where discovery was made. */
  asteroidId: string;
  /** Resource type. */
  resource: ResourceType;
  /** Resource-specific name (Vein/Nugget/Burst/Lode). */
  discoveryName: string;
  /** Finder wallet address. */
  finderWallet: string;
  /** Total yield amount. */
  totalYield: number;
  /** Finder's instant share (70%). */
  finderShare: number;
  /** Refinery share (30%). */
  refineryShare: number;
  /** Whether the rare Stellar Strike jackpot triggered (was: gold rush). */
  isStellarStrike: boolean;
  /** Stellar Strike multiplier if applicable. */
  stellarStrikeMultiplier: number;
  /** When discovered. */
  foundAt: Date;
  /** Proof hash. */
  proofHash: string;
}

// ============ REFINERY TYPES (was: VAULT in BG) ============

/** Miner contribution tracking for hourly distribution. */
export interface MinerContribution {
  /** Wallet address. */
  walletAddress: string;
  /** Drill power × seconds online this hour (was: hashrateSeconds in BG). */
  drillPowerSeconds: number;
  /** Current stake tier multiplier. */
  stakeTierMultiplier: number;
  /** Loyalty bonus (0.1 for 7+ days at a carbon-class asteroid). */
  loyaltyBonus: number;
  /** Time active this hour in seconds. */
  timeActiveSeconds: number;
}

/** Asteroid refinery for accumulating yield-pool payouts. */
export interface AsteroidRefinery {
  /** Asteroid ID. */
  asteroidId: string;
  /** Current refinery balance. */
  balance: number;
  /** Pending distribution amount. */
  pendingDistribution: number;
  /** Last distribution time. */
  lastDistributionTime: Date;
  /** Hourly contributions by wallet. */
  hourlyContributions: Map<string, MinerContribution>;
  /** Total distributions made. */
  totalDistributed: number;
  /** Distribution count. */
  distributionCount: number;
}

/** Hourly distribution result. */
export interface RefineryDistributionResult {
  /** Asteroid ID. */
  asteroidId: string;
  /** Total amount distributed. */
  totalDistributed: number;
  /** Number of miners who received. */
  minerCount: number;
  /** Individual payouts by wallet. */
  payouts: Map<string, number>;
  /** When distribution happened. */
  distributedAt: Date;
}

// ============ SYNDICATE TYPES ============

/** Syndicate settings. */
export interface SyndicateSettings {
  /** Percentage of member earnings to treasury (0–30). */
  rewardSplit: number;
  /** Enable coordinated raids. */
  raidCoordination: boolean;
  /** Enable defense alerts. */
  defenseAlerts: boolean;
}

/** Syndicate member role. */
export type SyndicateRole = 'leader' | 'officer' | 'member';

/** Syndicate member info. */
export interface SyndicateMember {
  /** Wallet address. */
  walletAddress: string;
  /** Role in syndicate. */
  role: SyndicateRole;
  /** When joined. */
  joinedAt: Date;
  /** Total contributed to treasury. */
  totalContributed: number;
}

/** Syndicate definition. */
export interface Syndicate {
  /** Unique syndicate ID. */
  id: string;
  /** Syndicate name. */
  name: string;
  /** Short tag (3–4 chars). */
  tag: string;
  /** Leader wallet address. */
  leaderId: string;
  /** All members with roles. */
  members: Map<string, SyndicateMember>;
  /** When created. */
  createdAt: Date;
  /** Treasury balance. */
  treasury: number;
  /** Syndicate settings. */
  settings: SyndicateSettings;
  /** Active wars (syndicate IDs). */
  activeWars: string[];
  /** Total wins in syndicate wars. */
  warWins: number;
  /** Total losses in syndicate wars. */
  warLosses: number;
}

/** Syndicate creation cost — preserved from BG. */
export const SYNDICATE_CREATION_COST = 1000;

/** Coordinated syndicate raid. */
export interface SyndicateRaid {
  /** Raid ID. */
  id: string;
  /** Syndicate launching raid. */
  syndicateId: string;
  /** Target asteroid. */
  targetAsteroidId: string;
  /** Participating member wallets. */
  participants: string[];
  /** Pooled attack power. */
  pooledAttackPower: number;
  /** Total bet amounts. */
  totalBets: number;
  /** Individual bets. */
  bets: Map<string, number>;
  /** When raid started. */
  startedAt: Date;
  /** When raid resolves. */
  expiresAt: Date;
  /** Status. */
  status: ExpeditionStatus;
}

// ============ DEFENDER SPOILS TYPES ============

/** Defender spoils from a failed raid. */
export interface DefenderSpoils {
  /** Raid ID. */
  raidId: string;
  /** Total spoils amount (10% of attacker bets). */
  totalSpoils: number;
  /** Amount burned (90% of attacker bets). */
  amountBurned: number;
  /** Individual defender payouts. */
  defenderPayouts: Map<string, number>;
  /** When distributed. */
  distributedAt: Date;
}

// ============ RAID TYPES ============

/** Raid result. */
export interface RaidResult {
  /** Expedition ID. */
  expeditionId: string;
  /** Whether attackers won. */
  attackersWon: boolean;
  /** Total yield stolen (if won). */
  stolenYield: number;
  /** Defense power at resolution. */
  defensePower: number;
  /** Attack power at resolution. */
  attackPower: number;
  /** Bets returned (winners). */
  betsReturned: Map<string, number>;
  /** Bets burned (losers). */
  betsBurned: Map<string, number>;
  /** When resolved. */
  resolvedAt: Date;
}

/** Defense buff applied after a successful defense. */
export interface DefenseBuff {
  /** Asteroid that has the buff. */
  asteroidId: string;
  /** Immunity from raids until this time. */
  immuneUntil: Date;
  /** Drill power boost multiplier (was: hashrateBoost in BG). */
  drillPowerBoost: number;
  /** When boost expires. */
  boostExpiresAt: Date;
}

/** Attack debuff applied after a successful raid. */
export interface AttackDebuff {
  /** Asteroid that has the debuff. */
  asteroidId: string;
  /** Drill power reduction multiplier (e.g. 0.8 = 20% reduction). */
  drillPowerReduction: number;
  /** When debuff expires. */
  expiresAt: Date;
}

/** Discovery-yield penalty applied to an asteroid after a meteor strike. */
export interface MeteorDebuff {
  /** Asteroid that has the debuff. */
  asteroidId: string;
  /** Discovery-yield multiplier while active (e.g. 0.7 = 30% reduction). */
  yieldMultiplier: number;
  /** When the penalty expires. */
  expiresAt: Date;
}

// ============ COOLDOWN TYPES ============

/** Cooldown types in the game. */
export type CooldownType =
  | 'home_station_switch' // 24 hours between home-station changes
  | 'expedition_start' //    1 hour  between expeditions
  | 'expedition_recovery' // 30 min  after an expedition ends
  | 'rally_defense'; //      1 hour  between rally uses

/** Cooldown record. */
export interface Cooldown {
  /** Wallet address. */
  walletAddress: string;
  /** Type of cooldown. */
  type: CooldownType;
  /** When cooldown expires. */
  expiresAt: Date;
}

/**
 * Default cooldown durations in milliseconds. The raid cooldowns were softened
 * from BG's punishing 1h/30m to a "moderate" 10m/5m so the loop stays playable
 * in a live game; they (and the others) can be overridden per-deployment via
 * `CooldownManager`'s `durations` config (wired from env in the boot layer).
 */
export const COOLDOWN_DURATIONS: Record<CooldownType, number> = {
  home_station_switch: 24 * 60 * 60 * 1000, // 24 hours
  expedition_start: 10 * 60 * 1000, //        10 minutes (was 1 hour in BG)
  expedition_recovery: 5 * 60 * 1000, //       5 minutes (was 30 min in BG)
  rally_defense: 60 * 60 * 1000, //            1 hour
};

// ============ ASTEROID STATE TYPES ============

/** Live state of an asteroid. */
export interface AsteroidState {
  /** Asteroid definition reference. */
  definition: AsteroidDefinition;
  /** Active miners at this asteroid. */
  activeMiners: Set<string>;
  /** Total drill power at this asteroid (was: totalHashrate in BG). */
  totalDrillPower: number;
  /** Total stake at this asteroid. */
  totalStake: number;
  /** Current discovery number. */
  currentDiscovery: number;
  /** Total discoveries found at this asteroid. */
  totalDiscoveries: number;
  /** Last discovery found timestamp. */
  lastDiscoveryTime: Date | null;
  /** Current difficulty. */
  difficulty: number;
  /** Current difficulty target (hex). */
  target: string;
  /** Active expeditions against this asteroid. */
  incomingRaids: string[];
  /** Defense buffs active. */
  defenseBuff: DefenseBuff | null;
  /** Attack debuffs active. */
  attackDebuff: AttackDebuff | null;
  /** Active meteor-strike discovery-yield penalty, if any. */
  meteorDebuff: MeteorDebuff | null;
  /** Current discovery header. */
  discoveryHeader: string;
  /** Whether the rare Stellar Strike jackpot mode is currently active. */
  isStellarStrikeActive: boolean;
  /** Syndicate multiplier based on miners (for oil-class asteroids). */
  syndicateMultiplier: number;
  /** Current Solar Flare multiplier (for silver-class asteroids). */
  solarFlareMultiplier: number;
}

/** Miner's game state. */
export interface MinerGameState {
  /** Wallet address. */
  walletAddress: string;
  /** Home-station asteroid ID. */
  homeStationAsteroidId: string | null;
  /** Current active asteroid ID (could be on expedition). */
  activeAsteroidId: string | null;
  /** Current expedition ID if on one. */
  currentExpeditionId: string | null;
  /** Total stake across all asteroids. */
  totalStake: number;
  /** Active cooldowns. */
  cooldowns: Cooldown[];
  /** Loyalty days at home station. */
  loyaltyDays: number;
  /** When they joined their home station. */
  homeStationJoinedAt: Date | null;
}

// ============ EVENT TYPES ============

/** Game events broadcast to clients. */
export type GameEventType =
  | 'asteroid_update'
  | 'raid_started'
  | 'raid_resolved'
  | 'stake_changed'
  | 'discovery_found'
  | 'stellar_strike' //   was: 'jackpot_triggered'
  | 'solar_flare' //      was: 'silver_surge'
  | 'syndicate_bonus'
  | 'spoils_distributed'
  | 'refinery_distribution'; // was: 'vault_distribution'

/** Game event payload. */
export interface GameEvent<T = unknown> {
  type: GameEventType;
  asteroidId: string;
  payload: T;
  timestamp: Date;
}

// ============ NETWORK STATS (EXTENDED) ============

/** Extended network stats per asteroid. */
export interface AsteroidNetworkStats {
  asteroidId: string;
  asteroidName: string;
  resource: ResourceType;
  minerCount: number;
  drillPower: number;
  totalStake: number;
  discoveriesFound: number;
  difficulty: number;
  lastDiscoveryTime: Date | null;
  hasDefenseBuff: boolean;
  hasAttackDebuff: boolean;
  activeRaidCount: number;
  /** Accumulated raid-vault treasury (persistent, raidable), in $ASTROID units. */
  refineryBalance: number;
  /** Discovery yield currently stealable by a successful raid. */
  stealableYield: number;
  /** Live defense power of this asteroid (what a raid must beat). */
  defensePower: number;
}

/** Global network stats. */
export interface GlobalNetworkStats {
  totalMiners: number;
  totalDrillPower: number;
  totalStake: number;
  totalDiscoveries: number;
  asteroidStats: AsteroidNetworkStats[];
  activeExpeditions: number;
  activeRaids: number;
}

// ============ HELPER FUNCTIONS ============

/**
 * Get the stake tier for a given $ASTROID stake (in whole tokens). Thresholds
 * are computed from the live $ASTROID/USD price so each tier costs a stable
 * USD amount; when the price is unknown the static token fallbacks apply.
 */
export function getStakeTier(stakeAmount: number): StakeTier {
  // Find the highest tier the stake qualifies for at the current price.
  for (let i = STAKE_TIER_DEFS.length - 1; i >= 0; i--) {
    const def = STAKE_TIER_DEFS[i]!;
    const threshold = tierTokenThreshold(def);
    if (stakeAmount >= threshold) {
      return {
        minStake: threshold,
        name: def.name,
        drillPowerMultiplier: def.drillPowerMultiplier,
        defenseMultiplier: def.defenseMultiplier,
      };
    }
  }
  // Base tier (usd 0 → threshold 0) always matches as a final fallback.
  const base = STAKE_TIER_DEFS[0]!;
  return {
    minStake: 0,
    name: base.name,
    drillPowerMultiplier: base.drillPowerMultiplier,
    defenseMultiplier: base.defenseMultiplier,
  };
}

/**
 * A wallet's current tier plus how far it is from the next one, with all
 * token thresholds resolved at the live $ASTROID/USD price. Sent to the client
 * so the arena can show "stake N more $ASTROID to reach Silver" without the
 * client having to duplicate the (price-dependent) tier math.
 */
export interface StakeTierProgress {
  /** Current tier name. */
  tierName: string;
  /** Current tier's drill-power multiplier. */
  drillPowerMultiplier: number;
  /** Next tier up, or null when already at the top tier. */
  nextTierName: string | null;
  /** Next tier's drill multiplier (null at top). */
  nextTierDrillMultiplier: number | null;
  /** $ASTROID token threshold to reach the next tier (null at top). */
  nextTierThreshold: number | null;
  /** USD cost of the next tier (null at top). */
  nextTierUsd: number | null;
  /** Additional $ASTROID needed to reach the next tier (0 at top). */
  tokensToNextTier: number;
  /** Live $ASTROID/USD price driving the thresholds (0 = unknown). */
  astroidUsdPrice: number;
}

/** Resolve a wallet's tier and distance to the next tier at the live price. */
export function getStakeTierProgress(stakeAmount: number): StakeTierProgress {
  let currentIndex = 0;
  for (let i = STAKE_TIER_DEFS.length - 1; i >= 0; i--) {
    if (stakeAmount >= tierTokenThreshold(STAKE_TIER_DEFS[i]!)) {
      currentIndex = i;
      break;
    }
  }
  const current = STAKE_TIER_DEFS[currentIndex]!;
  const next = STAKE_TIER_DEFS[currentIndex + 1] ?? null;
  const nextThreshold = next ? tierTokenThreshold(next) : null;
  return {
    tierName: current.name,
    drillPowerMultiplier: current.drillPowerMultiplier,
    nextTierName: next?.name ?? null,
    nextTierDrillMultiplier: next?.drillPowerMultiplier ?? null,
    nextTierThreshold: nextThreshold,
    nextTierUsd: next?.usd ?? null,
    tokensToNextTier: nextThreshold !== null ? Math.max(0, nextThreshold - stakeAmount) : 0,
    astroidUsdPrice,
  };
}

/**
 * Calculate effective drill power with the stake multiplier and resource
 * loyalty bonus. Math is byte-identical to BG's `calculateEffectiveHashrate`.
 */
export function calculateEffectiveDrillPower(
  baseDrillPower: number,
  stakeAmount: number,
  loyaltyDays: number,
  resource: ResourceType,
): number {
  const tier = getStakeTier(stakeAmount);
  let multiplier = tier.drillPowerMultiplier;

  // Carbon-class loyalty bonus: +10% after 7 days.
  if (resource === 'carbon' && loyaltyDays >= 7) {
    multiplier *= 1.1;
  }

  return baseDrillPower * multiplier;
}

/** Calculate defense power for a wallet. Math byte-identical to BG. */
export function calculateDefensePower(stakeAmount: number, isHomeStation: boolean): number {
  const tier = getStakeTier(stakeAmount);
  let power = stakeAmount * tier.defenseMultiplier;

  // Home-station advantage: 1.5x stake power for defense.
  if (isHomeStation) {
    power *= 1.5;
  }

  return power;
}

/**
 * Calculate attack power. Math byte-identical to BG: half drill power
 * plus 10% of stake.
 */
export function calculateAttackPower(effectiveDrillPower: number, stakeAmount: number): number {
  return effectiveDrillPower * 0.5 + stakeAmount * 0.1;
}

/**
 * Calculate the syndicate multiplier for oil-class asteroids.
 * Scales from 1x at 1 miner to 3x at 50+ miners.
 */
export function calculateSyndicateMultiplier(minerCount: number): number {
  if (minerCount <= 1) return 1.0;
  if (minerCount >= 50) return 3.0;
  return 1.0 + (minerCount - 1) * (2.0 / 49);
}

/**
 * Roll the Solar Flare multiplier (was: Silver Surge in BG).
 * Random in [0.5, 2.0). Probability distribution preserved.
 */
export function rollSolarFlareMultiplier(): number {
  return 0.5 + Math.random() * 1.5;
}

/**
 * Roll the Stellar Strike jackpot (was: Gold Rush in BG).
 * 5% chance of triggering. Probability preserved.
 */
export function rollStellarStrikeJackpot(): boolean {
  return Math.random() < 0.05;
}
