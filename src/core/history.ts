import type { TokenClass } from "./types.js";

/** One hourly candle: unix seconds, open, high, low, close, volume in USD. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface HistorySignal {
  kind: "spike" | "launch";
  /** Unix seconds of the candle the signal fired on. */
  t: number;
  tokenClass: TokenClass;
  priceAtSignal: number;
  priceAfter24h: number;
  changePct: number;
}

export interface ReplayRules {
  minVolumeMultiple: number;
  minPriceChangeH1Pct: number;
  minHourlyVolumeUsd: number;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export function parseOhlcv(list: number[][]): Candle[] {
  return list
    .filter((r) => r.length >= 6 && r.every((x) => Number.isFinite(Number(x))))
    .map(([t, o, h, l, c, v]) => ({ t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) }))
    .filter((k) => k.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Replays Tide's live rules over real past candles and reports what happened
 * 24 hours after each time they would have fired. Same thresholds as the
 * live scanner; a pool can only fire once per 6 hours, like live alerts.
 */
export function replaySignals(candles: Candle[], createdAt: Date | null, rules: ReplayRules): HistorySignal[] {
  const out: HistorySignal[] = [];
  const byTime = new Map(candles.map((k) => [k.t, k]));
  const after = (t: number) => byTime.get(t + DAY) ?? candles.find((k) => k.t >= t + DAY && k.t <= t + DAY + 2 * HOUR);
  const created = createdAt ? Math.floor(createdAt.getTime() / 1000) : null;
  const classAt = (t: number): TokenClass => (created !== null && t - created < 7 * DAY ? "new" : "established");
  let lastFired = -Infinity;

  // A launch: the first candle in the pool's first hour, if there was real trading.
  if (created !== null) {
    const first = candles.find((k) => k.t >= created - HOUR && k.t <= created + HOUR);
    if (first && first.v >= rules.minHourlyVolumeUsd) {
      const later = after(first.t);
      if (later) {
        out.push(signal("launch", first, later, "new"));
        lastFired = first.t;
      }
    }
  }

  for (let i = 24; i < candles.length; i++) {
    const k = candles[i]!;
    if (k.t - lastFired < 6 * HOUR) continue;
    if (k.v < rules.minHourlyVolumeUsd) continue;
    const prior = candles.slice(i - 24, i);
    const avg = prior.reduce((s, p) => s + p.v, 0) / prior.length;
    const volSpike = avg > 0 ? k.v / avg >= rules.minVolumeMultiple : false;
    const priceSpike = k.o > 0 && (k.c / k.o - 1) * 100 >= rules.minPriceChangeH1Pct;
    if (!volSpike && !priceSpike) continue;
    const later = after(k.t);
    if (!later) continue;
    out.push(signal("spike", k, later, classAt(k.t)));
    lastFired = k.t;
  }
  return out;
}

function signal(kind: "spike" | "launch", at: Candle, later: Candle, tokenClass: TokenClass): HistorySignal {
  return {
    kind,
    t: at.t,
    tokenClass,
    priceAtSignal: at.c,
    priceAfter24h: later.c,
    changePct: Math.round((later.c / at.c - 1) * 1000) / 10,
  };
}
