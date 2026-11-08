import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLaunch, detectSpike } from "../src/core/spike.js";
import type { Pool } from "../src/core/types.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";
import { NOW, pool } from "./fixtures.js";

const minsAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000);
const launch = (over: Partial<Pool> = {}) =>
  pool({
    address: "0xnew",
    createdAt: minsAgo(12),
    liquidityUsd: 15_000,
    volumeUsd: { m5: 500, h1: 3_000, h6: 3_000, h24: 3_000 }, // too quiet to count as a spike
    priceChangePct: { m5: 1, h1: 5, h6: 5, h24: 5 },
    txH1: { buys: 40, sells: 12 },
    ...over,
  });

describe("detectLaunch", () => {
  it("flags a pool minutes old with liquidity and buyers", () => {
    const s = detectLaunch(launch(), undefined, NOW);
    expect(s?.kind).toBe("launch");
    expect(s?.tokenClass).toBe("new");
    expect(s?.reasons).toEqual(["the pool went live 12 minutes ago", "40 buys and 12 sells so far"]);
    expect(detectSpike(launch(), undefined, NOW)).toBeNull();
  });

  it("skips empty, old or buyerless launches", () => {
    expect(detectLaunch(launch({ liquidityUsd: 800 }), undefined, NOW)).toBeNull();
    expect(detectLaunch(launch({ createdAt: minsAgo(90) }), undefined, NOW)).toBeNull();
    expect(detectLaunch(launch({ txH1: { buys: 2, sells: 0 } }), undefined, NOW)).toBeNull();
    expect(detectLaunch(launch({ createdAt: null }), undefined, NOW)).toBeNull();
  });
});

describe("launch alerts", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  function setup() {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const reader: ChainReader = { balances: async () => [], coinInfo: async () => ({ symbol: "X", decimals: 9 }) };
    let pools: Pool[] = [];
    const market = { candidatePools: async () => pools, quote: async () => null } as unknown as Market;
    const tide = new Tide(store, memory, { sui: reader }, market, {
      sui: { minLiquidityUsd: 10_000, minHourlyVolumeUsd: 5_000, minVolumeMultiple: 3, minPriceChangeH1Pct: 20 },
    });
    const sent: string[] = [];
    tide.attach({ send: async (_c, html) => void sent.push(html) });
    return { tide, store, sent, setPools: (p: Pool[]) => (pools = p) };
  }

  it("are off by default and only go to people who turn them on", async () => {
    const { tide, sent, setPools } = setup();
    tide.start(1, 1);
    tide.start(2, 2);
    tide.setLaunches(2, true);
    setPools([launch()]);
    expect(await tide.scan()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("fresh launch on sui");
    expect(sent[0]).toContain("most of them go to zero");
  });

  it("come one per chain every 45 minutes, never the same pool twice", async () => {
    const { tide, store, setPools } = setup();
    tide.start(1, 1);
    tide.setLaunches(1, true);
    setPools([launch({ address: "0xnew1" }), launch({ address: "0xnew2" })]);
    expect(await tide.scan()).toBe(1);
    expect(await tide.scan()).toBe(0); // too soon
    tide.alertGapMs = 0;
    expect(await tide.scan()).toBe(1); // the other launch, not 0xnew1 again
    expect(await tide.scan()).toBe(0); // nothing new left
    const day = new Date(Date.now() - 24 * 3_600_000);
    expect(store.recentAlertCount(1, day, "launch")).toBe(2);
  });

  it("fall back to the strongest mover when nothing spiked or launched", async () => {
    const { tide, sent, setPools } = setup();
    tide.start(1, 1);
    const calm = pool({ address: "0xcalm", baseSymbol: "CALM", priceChangePct: { m5: 1, h1: 9, h6: 12, h24: 15 }, volumeUsd: { m5: 500, h1: 4_000, h6: 20_000, h24: 80_000 }, txH1: { buys: 40, sells: 20 } });
    setPools([calm]);
    expect(await tide.scan()).toBe(1);
    expect(sent.at(-1)).toContain("strongest mover on sui");
  });

  it("feed the new-token track record like any alert", async () => {
    const { tide, store, setPools } = setup();
    tide.start(1, 1);
    tide.setLaunches(1, true);
    setPools([launch()]);
    await tide.scan();
    expect(store.recentAlerts(1, 1)[0]!.tokenClass).toBe("new");
  });
});
