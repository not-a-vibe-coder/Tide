import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chainVolumeLine, lowCapList } from "../src/bot/format.js";
import { amounts, parseIntent } from "../src/bot/intents.js";
import { DEFAULT_MAX_PUMP_PCT, filterMiss, NO_FILTERS } from "../src/core/filters.js";
import type { Pool } from "../src/core/types.js";
import type { Market } from "../src/market/gecko.js";
import { parseOverview } from "../src/market/llama.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";
import { NOW, pool } from "./fixtures.js";

const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const launch = (over: Partial<Pool> = {}) =>
  pool({
    address: "0xnew",
    createdAt: minsAgo(12),
    liquidityUsd: 15_000,
    marketCapUsd: 60_000,
    volumeUsd: { m5: 500, h1: 3_000, h6: 3_000, h24: 3_000 },
    priceChangePct: { m5: 1, h1: 5, h6: 5, h24: 5 },
    txH1: { buys: 40, sells: 12 },
    ...over,
  });

describe("plain words", () => {
  it("reads amounts with k and m", () => {
    expect(amounts("between 20k and 1.5m")).toEqual([20_000, 1_500_000]);
    expect(amounts("$50k-150k")).toEqual([50_000, 150_000]);
  });

  it("sets a market cap range", () => {
    expect(parseIntent("only send me tokens under 100k mcap")).toEqual({ action: "mcap", min: null, max: 100_000 });
    expect(parseIntent("market cap between 20k and 150k")).toEqual({ action: "mcap", min: 20_000, max: 150_000 });
    expect(parseIntent("mcap 20k-150k")).toEqual({ action: "mcap", min: 20_000, max: 150_000 });
    expect(parseIntent("only tokens above 30k market cap")).toEqual({ action: "mcap", min: 30_000 });
    expect(parseIntent("only send tokens under 100k")).toEqual({ action: "mcap", min: null, max: 100_000 });
    expect(parseIntent("i want early tokens, nothing above 200k mc")).toEqual({ action: "mcap", min: null, max: 200_000 });
    expect(parseIntent("remove the mcap limit")).toEqual({ action: "mcap", min: null, max: null });
    expect(parseIntent("what's the mcap of $WIF?")).toBeNull();
  });

  it("sets the pump limit", () => {
    expect(parseIntent("skip tokens already up 200%")).toEqual({ action: "pump", pct: 200 });
    expect(parseIntent("don't send me pumped tokens")).toEqual({ action: "pump", pct: 100 });
    expect(parseIntent("allow pumped tokens")).toEqual({ action: "pump", pct: null });
  });

  it("finds low caps on demand", () => {
    expect(parseIntent("find me low caps on solana under 50k")).toEqual({ action: "lowCaps", chains: ["solana"], maxCap: 50_000 });
    expect(parseIntent("any gems?")).toEqual({ action: "lowCaps", chains: undefined, maxCap: undefined });
    expect(parseIntent("show me small caps on sui")).toEqual({ action: "lowCaps", chains: ["sui"], maxCap: undefined });
  });

  it("asks for chain volume", () => {
    expect(parseIntent("how much volume is on solana?")).toEqual({ action: "chainVolume", chains: ["solana"] });
    expect(parseIntent("sui volume today")).toEqual({ action: "chainVolume", chains: ["sui"] });
    expect(parseIntent("what's the dex volume across chains")).toEqual({ action: "chainVolume", chains: undefined });
    expect(parseIntent("what's the volume on $WIF")).toBeNull();
    expect(parseIntent("top 5 on solana by volume")?.action).not.toBe("chainVolume");
  });
});

describe("filters", () => {
  it("checks cap range and how far it already ran", () => {
    const f = { mcapMin: 20_000, mcapMax: 100_000, maxPumpPct: 100 };
    expect(filterMiss(launch(), f)).toBeNull();
    expect(filterMiss(launch({ marketCapUsd: 150_000 }), f)).toBe("market cap over your limit");
    expect(filterMiss(launch({ marketCapUsd: 5_000 }), f)).toBe("market cap under your floor");
    expect(filterMiss(launch({ marketCapUsd: null, fdvUsd: 80_000 }), f)).toBeNull();
    expect(filterMiss(launch({ priceChangePct: { m5: 0, h1: 50, h6: 200, h24: 310 } }), f)).toBe("already pumped");
    expect(filterMiss(launch({ priceChangePct: { m5: 0, h1: 50, h6: 200, h24: 310 } }), NO_FILTERS)).toBeNull();
  });
});

describe("alerts with someone's limits", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  function setup() {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const reader: ChainReader = { balances: async () => [], coinInfo: async () => ({ symbol: "X", decimals: 9 }) };
    let pools: Pool[] = [];
    const market = { candidatePools: async () => pools, newPools: async () => [], quote: async () => null } as unknown as Market;
    const tide = new Tide(store, memory, { sui: reader }, market, {
      sui: { minLiquidityUsd: 10_000, minHourlyVolumeUsd: 5_000, minVolumeMultiple: 3, minPriceChangeH1Pct: 20 },
    });
    const sent: string[] = [];
    tide.attach({ send: async (_c, html) => void sent.push(html) });
    tide.start(1, 1);
    tide.setLaunches(1, true);
    return { tide, sent, setPools: (p: Pool[]) => (pools = p) };
  }

  it("skips a launch that already ran, like BUIDL at +310%", async () => {
    const { tide, sent, setPools } = setup();
    expect(tide.filtersFor(1).maxPumpPct).toBe(DEFAULT_MAX_PUMP_PCT);
    setPools([launch({ baseSymbol: "BUIDL", priceChangePct: { m5: 5, h1: 120, h6: 310, h24: 310 } })]);
    expect(await tide.scan()).toBe(0);
    tide.setPumpLimit(1, null);
    expect(await tide.scan()).toBe(1);
    expect(sent.at(-1)).toContain("BUIDL");
  });

  it("keeps to the market cap range", async () => {
    const { tide, sent, setPools } = setup();
    tide.setMcap(1, { max: 50_000 });
    setPools([launch({ address: "0xbig", baseSymbol: "BIG", marketCapUsd: 150_000 }), launch({ address: "0xsmall", baseSymbol: "SMALL", marketCapUsd: 30_000 })]);
    expect(await tide.scan()).toBe(1);
    expect(sent.at(-1)).toContain("SMALL");
  });

  it("picks the earliest launch first, then the smallest", async () => {
    const { tide, sent, setPools } = setup();
    setPools([
      launch({ address: "0xold", baseSymbol: "OLDER", createdAt: minsAgo(40), liquidityUsd: 90_000 }),
      launch({ address: "0xyoung", baseSymbol: "YOUNG", createdAt: minsAgo(8) }),
    ]);
    await tide.scan();
    expect(sent.at(-1)).toContain("YOUNG");
  });

  it("lists low caps with buyers, under the cap, busiest first", async () => {
    const { tide, setPools } = setup();
    setPools([
      launch({ address: "a", baseCoinType: "A", baseSymbol: "A", marketCapUsd: 40_000, volumeUsd: { m5: 0, h1: 9_000, h6: 0, h24: 0 } }),
      launch({ address: "b", baseCoinType: "B", baseSymbol: "B", marketCapUsd: 20_000, volumeUsd: { m5: 0, h1: 20_000, h6: 0, h24: 0 } }),
      launch({ address: "c", baseCoinType: "C", baseSymbol: "C", marketCapUsd: 900_000 }),
      launch({ address: "d", baseCoinType: "D", baseSymbol: "D", marketCapUsd: 30_000, txH1: { buys: 2, sells: 0 } }),
    ]);
    const [res] = await tide.lowCaps(["sui"], 50_000);
    expect(res!.pools.map((p) => p.baseSymbol)).toEqual(["B", "A"]);
    expect(lowCapList("sui", res!.pools, 50_000, () => "high")).toContain("low caps on sui under $50");
  });
});

describe("chain volume", () => {
  it("reads DefiLlama's overview and says it plainly", () => {
    const v = parseOverview("solana", {
      total24h: 2_310_000_000,
      change_1d: -8.2,
      total7d: 16_000_000_000,
      protocols: [
        { displayName: "Raydium", total24h: 900_000_000 },
        { displayName: "Orca", total24h: 600_000_000 },
        { displayName: "Meteora", total24h: 400_000_000 },
        { displayName: "Tiny", total24h: 1 },
      ],
    });
    expect(v.topDexes.map((d) => d.name)).toEqual(["Raydium", "Orca", "Meteora"]);
    const line = chainVolumeLine({ chain: "solana", volume: v });
    expect(line).toContain("<b>solana</b> did $2.31B in dex volume in the last 24h, down 8% on the day before");
    expect(line).toContain("raydium $900.0M");
    expect(() => parseOverview("sui", {})).toThrow();
  });

  it("falls back to top pools when the full number isn't available", () => {
    expect(chainVolumeLine({ chain: "sui", approxUsd: 45_000_000 })).toContain("about $45.0M across its top 20 pools");
  });
});
