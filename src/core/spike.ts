import type { Pool, RiskCheck, Spike, TokenClass } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SpikeRules {
  minLiquidityUsd: number;
  minHourlyVolumeUsd: number;
  /** Last hour must be at least this many times the average hour. */
  minVolumeMultiple: number;
  /** Or price (≈ market cap) up at least this much in the last hour. */
  minPriceChangeH1Pct: number;
}

export const DEFAULT_SPIKE_RULES: SpikeRules = {
  minLiquidityUsd: 10_000,
  minHourlyVolumeUsd: 5_000,
  minVolumeMultiple: 3,
  minPriceChangeH1Pct: 20,
};

export function classifyToken(pool: Pool, now: Date = new Date()): TokenClass {
  if (!pool.createdAt) return "established";
  return now.getTime() - pool.createdAt.getTime() < 7 * DAY_MS ? "new" : "established";
}

/**
 * A spike is a pool whose last hour is far busier than its average hour,
 * or whose price (and so market cap) jumped, with enough liquidity and
 * volume that it isn't noise.
 */
export function detectSpike(pool: Pool, rules: SpikeRules = DEFAULT_SPIKE_RULES, now = new Date()): Spike | null {
  if (pool.liquidityUsd < rules.minLiquidityUsd) return null;
  if (pool.volumeUsd.h1 < rules.minHourlyVolumeUsd) return null;

  const avgHour = pool.volumeUsd.h24 / 24;
  const volumeMultiple = avgHour > 0 ? pool.volumeUsd.h1 / avgHour : Infinity;

  const reasons: string[] = [];
  if (volumeMultiple >= rules.minVolumeMultiple) {
    reasons.push(
      Number.isFinite(volumeMultiple)
        ? `the last hour traded ${volumeMultiple.toFixed(1)}× its usual volume`
        : "this is its first hour of real trading",
    );
  }
  if (pool.priceChangePct.h1 >= rules.minPriceChangeH1Pct) {
    reasons.push(`price and market cap are up ${pool.priceChangePct.h1.toFixed(0)}% in an hour`);
  }
  if (reasons.length === 0) return null;

  return { pool, tokenClass: classifyToken(pool, now), volumeMultiple, reasons };
}

/**
 * Token risk multiplier r. Starts at 1 and is cut for thin liquidity,
 * a very young pool, and more sellers than buyers.
 */
export function assessRisk(pool: Pool, now: Date = new Date()): RiskCheck {
  let r = 1;
  const flags: string[] = [];

  if (pool.liquidityUsd < 20_000) {
    r *= 0.5;
    flags.push(`thin liquidity ($${Math.round(pool.liquidityUsd).toLocaleString("en-US")})`);
  } else if (pool.liquidityUsd < 50_000) {
    r *= 0.75;
    flags.push(`modest liquidity ($${Math.round(pool.liquidityUsd).toLocaleString("en-US")})`);
  }

  if (pool.createdAt) {
    const ageDays = (now.getTime() - pool.createdAt.getTime()) / DAY_MS;
    if (ageDays < 1) {
      r *= 0.5;
      flags.push("pool under 1 day old");
    } else if (ageDays < 7) {
      r *= 0.75;
      flags.push(`pool ${Math.floor(ageDays)} days old`);
    }
  } else {
    flags.push("pool age unknown");
  }

  const { buys, sells } = pool.txH1;
  if (sells > buys * 1.5 && sells >= 10) {
    r *= 0.75;
    flags.push(`more sells than buys in 1h (${sells} vs ${buys})`);
  }

  if (pool.marketCapUsd !== null && pool.fdvUsd !== null && pool.fdvUsd > pool.marketCapUsd * 3) {
    flags.push("most supply not yet circulating");
  }

  const multiplier = Math.max(0.25, Math.min(1, r));
  const label = multiplier >= 0.75 ? "lower" : multiplier >= 0.5 ? "medium" : "high";
  return { multiplier, label, flags };
}

export interface LaunchRules {
  /** Only pools younger than this count as a fresh launch. */
  maxAgeMinutes: number;
  minLiquidityUsd: number;
  /** Real buyers already showing up in the first hour. */
  minBuysH1: number;
}

export const DEFAULT_LAUNCH_RULES: LaunchRules = { maxAgeMinutes: 60, minLiquidityUsd: 5_000, minBuysH1: 10 };

/**
 * A fresh launch: a pool created in the last hour that already has some
 * liquidity and buyers. Filters out the empty pools most launches start as.
 */
export function detectLaunch(pool: Pool, rules: LaunchRules = DEFAULT_LAUNCH_RULES, now = new Date()): Spike | null {
  if (!pool.createdAt) return null;
  const ageMin = (now.getTime() - pool.createdAt.getTime()) / 60_000;
  if (ageMin < 0 || ageMin > rules.maxAgeMinutes) return null;
  if (pool.liquidityUsd < rules.minLiquidityUsd) return null;
  if (pool.txH1.buys < rules.minBuysH1) return null;
  const mins = Math.max(1, Math.round(ageMin));
  const reasons = [
    `the pool went live ${mins} minute${mins === 1 ? "" : "s"} ago`,
    `${pool.txH1.buys} buys and ${pool.txH1.sells} sells so far`,
  ];
  return { kind: "launch", pool, tokenClass: "new", volumeMultiple: 0, reasons };
}
