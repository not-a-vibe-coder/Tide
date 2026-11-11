/** A user's sniper rules. Stored as preferences on Walrus like every other setting. */
export interface SnipeRules {
  /** Buy matching launches automatically. */
  auto: boolean;
  /** Send a one-tap alert for matching launches (used when auto is off). */
  alerts: boolean;
  /** SOL to spend per snipe. */
  sol: number;
  maxPerDay: number;
  mcapMinUsd: number | null;
  mcapMaxUsd: number | null;
  /** Skip launches where the creator bought more than this % of supply. */
  devMaxPct: number;
  /** Wait for this many distinct buyers before buying (0 = buy on the create itself). */
  minBuyers: number;
  /** How long to watch a launch for buyers, in seconds. */
  windowSec: number;
  /** Sell everything at +tp% or -sl% (null = off). */
  tpPct: number | null;
  slPct: number | null;
}

export const DEFAULT_RULES: SnipeRules = {
  auto: false,
  alerts: false,
  sol: 0.05,
  maxPerDay: 5,
  mcapMinUsd: null,
  mcapMaxUsd: 30_000,
  devMaxPct: 10,
  minBuyers: 5,
  windowSec: 20,
  tpPct: 100,
  slPct: 40,
};

export const RULE_KEYS: Record<keyof SnipeRules, string> = {
  auto: "snipe_auto",
  alerts: "snipe_alerts",
  sol: "snipe_sol",
  maxPerDay: "snipe_per_day",
  mcapMinUsd: "snipe_mcap_min",
  mcapMaxUsd: "snipe_mcap_max",
  devMaxPct: "snipe_dev_max",
  minBuyers: "snipe_min_buyers",
  windowSec: "snipe_window",
  tpPct: "snipe_tp",
  slPct: "snipe_sl",
};

export function readRules(get: (key: string) => string | null): SnipeRules {
  const r: SnipeRules = { ...DEFAULT_RULES };
  for (const [field, key] of Object.entries(RULE_KEYS) as [keyof SnipeRules, string][]) {
    const v = get(key);
    if (v === null) continue;
    if (field === "auto" || field === "alerts") (r[field] as boolean) = v === "true";
    else if (v === "off") (r[field] as number | null) = null;
    else if (Number.isFinite(Number(v))) (r[field] as number) = Number(v);
  }
  return r;
}

/** A new pump.fun token, as the live stream reports it. */
export interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  /** Tokens the creator bought in the create transaction (pump.fun supply is 1B). */
  creatorBuyTokens: number;
  marketCapSol: number;
  at: number;
}

/** What happened in a launch's first seconds. */
export interface LaunchStats {
  buyers: number;
  buys: number;
  sells: number;
  marketCapSol: number;
}

const PUMP_SUPPLY = 1_000_000_000;

/** Why a launch doesn't fit someone's rules, or null if it does. `stats` is null before watching. */
export function launchMiss(l: Launch, stats: LaunchStats | null, r: SnipeRules, solUsd: number): string | null {
  const mcapUsd = (stats?.marketCapSol ?? l.marketCapSol) * solUsd;
  if (r.mcapMaxUsd !== null && mcapUsd > r.mcapMaxUsd) return "market cap over your limit";
  if (r.mcapMinUsd !== null && mcapUsd < r.mcapMinUsd) return "market cap under your floor";
  if ((l.creatorBuyTokens / PUMP_SUPPLY) * 100 > r.devMaxPct) return "creator holds too much";
  if (r.minBuyers > 0) {
    if (!stats) return "waiting for buyers";
    if (stats.buyers < r.minBuyers) return "not enough buyers yet";
    if (stats.sells > stats.buys) return "more sells than buys";
  }
  return null;
}

export const creatorPct = (l: Launch) => (l.creatorBuyTokens / PUMP_SUPPLY) * 100;

/** Take-profit or stop-loss hit for a position up or down `changePct`. */
export function exitHit(changePct: number, tpPct: number | null, slPct: number | null): "take_profit" | "stop_loss" | null {
  if (tpPct !== null && changePct >= tpPct) return "take_profit";
  if (slPct !== null && changePct <= -slPct) return "stop_loss";
  return null;
}

/** "0.05 sol a snipe, under $30k mcap, creator ≤10%, 5+ buyers in 20s, tp +100% / sl -40%, 5 a day" */
export function describeRules(r: SnipeRules, money: (n: number) => string): string {
  const cap =
    r.mcapMinUsd !== null && r.mcapMaxUsd !== null
      ? `${money(r.mcapMinUsd)} to ${money(r.mcapMaxUsd)} mcap`
      : r.mcapMaxUsd !== null
        ? `under ${money(r.mcapMaxUsd)} mcap`
        : r.mcapMinUsd !== null
          ? `over ${money(r.mcapMinUsd)} mcap`
          : "any mcap";
  const buyers = r.minBuyers > 0 ? `${r.minBuyers}+ buyers in the first ${r.windowSec}s` : "buys on launch, no waiting";
  const exits = [r.tpPct !== null ? `take profit +${r.tpPct}%` : null, r.slPct !== null ? `stop loss -${r.slPct}%` : null].filter(Boolean).join(", ") || "no auto exits";
  return [`${r.sol} sol a snipe, ${r.maxPerDay} a day at most`, cap, `creator holds ${r.devMaxPct}% or less`, buyers, exits].join("\n");
}
