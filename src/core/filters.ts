import type { Pool } from "./types.js";

/**
 * A person's own limits on what Tide sends them.
 * mcapMin/mcapMax: market cap range in usd (null = no limit).
 * maxPumpPct: skip tokens already up more than this in 24h (null = don't skip).
 */
export interface PickFilters {
  mcapMin: number | null;
  mcapMax: number | null;
  maxPumpPct: number | null;
}

/** By default, anything that already more than doubled in a day is too late to send. */
export const DEFAULT_MAX_PUMP_PCT = 100;

export const NO_FILTERS: PickFilters = { mcapMin: null, mcapMax: null, maxPumpPct: null };

/** Market cap, or fully diluted value when the market cap isn't reported. */
export function capOf(p: Pool): number | null {
  return p.marketCapUsd ?? p.fdvUsd;
}

/**
 * Why a pool doesn't fit someone's limits, or null if it does.
 * For a pool under a day old, its 24h change is its whole life, so "already up"
 * means since launch.
 */
export function filterMiss(p: Pool, f: PickFilters): string | null {
  const cap = capOf(p);
  if (f.mcapMax !== null && (cap === null || cap > f.mcapMax)) return "market cap over your limit";
  if (f.mcapMin !== null && cap !== null && cap < f.mcapMin) return "market cap under your floor";
  if (f.maxPumpPct !== null && p.priceChangePct.h24 > f.maxPumpPct) return "already pumped";
  return null;
}

/** "between $20k and $150k", "under $100k", "any size". */
export function describeCapRange(f: Pick<PickFilters, "mcapMin" | "mcapMax">, money: (n: number) => string): string {
  if (f.mcapMin !== null && f.mcapMax !== null) return `between ${money(f.mcapMin)} and ${money(f.mcapMax)}`;
  if (f.mcapMax !== null) return `under ${money(f.mcapMax)}`;
  if (f.mcapMin !== null) return `over ${money(f.mcapMin)}`;
  return "any size";
}
