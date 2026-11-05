import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOhlcv, replaySignals, type Candle } from "../src/core/history.js";
import { DEFAULT_SPIKE_RULES } from "../src/core/spike.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";
import { pool } from "./fixtures.js";

const H = 3600;
const T0 = 1_762_000_000 - (1_762_000_000 % H);

/** 72 quiet hours with one spike at hour `at`, then price ends `endMult`× the spike price. */
function series(at: number, endMult: number): Candle[] {
  return Array.from({ length: 72 }, (_, i) => {
    const spike = i === at;
    const c = i < at ? 1 : i === at ? 1.3 : endMult * 1.3;
    return { t: T0 + i * H, o: spike ? 1 : c, h: c, l: c, c, v: spike ? 60_000 : 6_000 };
  });
}

describe("replaying signals over past candles", () => {
  it("parses GeckoTerminal ohlcv rows in any order", () => {
    const k = parseOhlcv([
      [T0 + H, 1, 2, 1, 2, 10],
      [T0, 1, 1, 1, 1, 5],
      [T0 + 2 * H, 0, 0, 0, 0, 0], // dead candle dropped
    ]);
    expect(k.map((c) => c.t)).toEqual([T0, T0 + H]);
  });

  it("fires where the live rules would and measures 24h later", () => {
    const sigs = replaySignals(series(30, 0.5), null, DEFAULT_SPIKE_RULES);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ kind: "spike", t: T0 + 30 * H, tokenClass: "established", changePct: -50 });
  });

  it("records a launch from the pool's first hour", () => {
    const created = new Date(T0 * 1000);
    const k = series(40, 2).map((c, i) => (i === 0 ? { ...c, v: 20_000 } : c));
    const sigs = replaySignals(k, created, DEFAULT_SPIKE_RULES);
    expect(sigs[0]).toMatchObject({ kind: "launch", tokenClass: "new" });
    expect(sigs.find((s) => s.kind === "spike")?.tokenClass).toBe("new"); // 40h old < 7 days
  });

  it("skips signals without a full 24h after them", () => {
    expect(replaySignals(series(60, 2), null, DEFAULT_SPIKE_RULES)).toEqual([]);
  });
});

describe("backfill", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date((T0 + 80 * H) * 1000), toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("writes history outcomes once, and new users start from the market's record", async () => {
    const store = new Store(":memory:");
    const mock = MemWalMock.create();
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: mock as never });
    const reader: ChainReader = { balances: async () => [], coinInfo: async () => ({ symbol: "X", decimals: 9 }) };
    const pools = Array.from({ length: 24 }, (_, i) => pool({ address: `0xp${i}`, baseCoinType: `0x${i + 10}::t::T${i}`, baseSymbol: `T${i}`, createdAt: null }));
    const market = {
      historyCandidates: async () => pools,
      // 6 of 24 went up after their spike, 18 went down
      hourlyCandles: async (_c: string, addr: string) => series(30, Number(addr.slice(3)) < 6 ? 1.5 : 0.6),
      candidatePools: async () => [],
      quote: async () => null,
    } as unknown as Market;
    const tide = new Tide(store, memory, { sui: reader }, market, { sui: DEFAULT_SPIKE_RULES });

    const [sui] = await tide.backfill();
    expect(sui).toMatchObject({ chain: "sui", pools: 24, outcomes: 24, up: 6 });
    await tide.backfill(); // same signals again
    expect(store.outcomeSources()).toEqual({ live: 0, history: 24 });

    await memory.flush();
    const stored = await mock.recall({ query: "[tide:token_outcome]", namespace: "tide-tokens", limit: 100 });
    expect(stored.results.length).toBe(24);
    expect(stored.results[0]!.text).toContain("Market history:");

    tide.start(1, 1);
    tide.setBudget(1, 40);
    const user = store.getUser(1)!;
    // market h = 0.5 + 0.7 × 6/24 = 0.675, softened halfway to 1 → 0.84
    expect(tide.trackRecord(user, "established")).toEqual({ h: 0.84, from: "market" });
    expect(tide.sizingFor(user, "established", 1)).toMatchObject({ trackRecord: 0.84, trackRecordFrom: "market", maxUsd: 8.4 });
  });
});
