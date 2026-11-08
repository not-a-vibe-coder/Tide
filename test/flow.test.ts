import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoinInfo, SuiReader } from "../src/chain/sui.js";
import { normaliseCoinType } from "../src/core/buys.js";
import type { Balance, Pool } from "../src/core/types.js";
import type { Market, TokenQuote } from "../src/market/gecko.js";
import { decodeEvent, userNamespace } from "../src/memory/events.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type Button } from "../src/tide.js";
import { SCOOP, pool } from "./fixtures.js";

const SUI = "0x2::sui::SUI";
const USER = 4242;

class FakeSui {
  balancesNow: Balance[] = [{ coinType: SUI, raw: String(100 * 1e9) }];
  async balances() {
    return this.balancesNow;
  }
  async coinInfo(coinType: string): Promise<CoinInfo> {
    return coinType.endsWith("::SUI") ? { symbol: "SUI", decimals: 9 } : { symbol: coinType.split("::").at(-1)!, decimals: 9 };
  }
}

class FakeMarket {
  pools: Pool[] = [];
  prices = new Map<string, number>([[normaliseCoinType(SUI), 3]]);
  async candidatePools() {
    return this.pools;
  }
  async quote(coinType: string): Promise<TokenQuote | null> {
    const p = this.prices.get(normaliseCoinType(coinType));
    return p === undefined ? null : { priceUsd: p, volumeH24Usd: 100_000, liquidityUsd: 80_000 };
  }
}

function setup() {
  const store = new Store(":memory:");
  const mock = MemWalMock.create();
  const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: mock as never });
  const sui = new FakeSui();
  const market = new FakeMarket();
  const tide = new Tide(store, memory, { sui: sui as unknown as SuiReader }, market as unknown as Market);
  const sent: { html: string; buttons?: Button[][] }[] = [];
  tide.attach({ send: async (_c, html, buttons) => void sent.push({ html, buttons }) });
  return { store, mock, memory, sui, market, tide, sent };
}

const spikePool = (i: number, coinType = `0x${String(i).padStart(64, "0")}::tok${i}::TOK${i}`): Pool =>
  pool({ address: `0xpool${i}`, baseCoinType: normaliseCoinType(coinType), baseSymbol: `TOK${i}`, name: `TOK${i} / SUI`, priceUsd: 1 });

describe("Tide end to end", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00Z"), toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("onboards, detects a buy, asks why, and stores it all on Walrus Memory", async () => {
    const { tide, sui, market, store, memory, mock, sent } = setup();
    tide.start(USER, USER);

    const { liquidUsd, proposedBudget } = await tide.setWallet(USER, "0x" + "1".repeat(64));
    expect(liquidUsd).toBe(300); // 100 SUI at $3
    expect(proposedBudget).toBe(30);
    tide.setBudget(USER, 30);

    market.prices.set(normaliseCoinType(SCOOP), 0.01);
    sui.balancesNow = [
      { coinType: SUI, raw: String(98 * 1e9) },
      { coinType: SCOOP, raw: String(600 * 1e9) },
    ];
    expect(await tide.checkWallet(store.getUser(USER)!)).toBe(1);
    expect(sent.at(-1)!.html).toContain("what made you buy it?");
    expect(store.openHoldings(USER)[0]!.costUsd).toBeCloseTo(6);

    expect(tide.answerReason(USER, "DEX volume is rising")).toBe("SCOOP");
    expect(store.openHoldings(USER)[0]!.reason).toBe("DEX volume is rising");

    await memory.flush();
    const stats = store.memoryStats(userNamespace(USER));
    expect(stats.confirmed).toBeGreaterThanOrEqual(5);
    expect(stats.failed).toBe(0);
    const stored = await mock.recall({ query: "[tide:buy_reason]", namespace: userNamespace(USER), limit: 100 });
    expect(stored.results.map((r) => decodeEvent(r.text)?.data.type)).toContain("buy_reason");
  });

  it("shrinks suggested size after losing alerts, then the wipe test restores everything", async () => {
    const { tide, market, store, memory, sent } = setup();
    tide.start(USER, USER);
    await tide.setWallet(USER, "0x" + "1".repeat(64));
    tide.setBudget(USER, 40);

    // Six alerts, one per hourly scan (one per chain every 45 minutes), all established pools with full liquidity (r = 1).
    market.pools = [1, 2, 3].map((i) => spikePool(i));
    expect(await tide.scan()).toBe(1);
    const firstAlert = sent.at(-1)!.html;
    expect(firstAlert).toContain("keep it under <b>$10</b>"); // 40 × 25% × 1 × 1
    expect(firstAlert).toContain("moving on sui");
    expect(await tide.scan()).toBe(0); // too soon for another sui alert

    for (let i = 2; i <= 6; i++) {
      vi.setSystemTime(new Date(Date.parse("2026-11-04T10:00:00Z") + (i - 1) * 3_600_000));
      market.pools = [spikePool(i)];
      expect(await tide.scan()).toBe(1);
    }

    // A day later every token is down 40%.
    vi.setSystemTime(new Date("2026-11-05T18:00:00Z"));
    for (let i = 1; i <= 6; i++) market.prices.set(spikePool(i).baseCoinType, 0.6);
    expect(await tide.resolveOutcomes()).toBe(6);
    expect(store.outcomes(USER, "established")).toEqual(Array(6).fill(false));

    // Next alert of the same class is sized down by the track record (h = 0.5).
    vi.setSystemTime(new Date("2026-11-05T19:00:00Z"));
    market.pools = [spikePool(7)];
    expect(await tide.scan()).toBe(1);
    const later = sent.at(-1)!.html;
    expect(later).toContain("track record 0.5");
    expect(later).toContain("keep it under <b>$5</b>");
    expect(later).toContain("established tokens were up 24h later on 0 of 6 signals like this");

    // "Not for me" mutes the class.
    const alertId = sent.at(-1)!.buttons![0]![2]!.data.split(":")[2]!;
    tide.handleAlertAction(USER, alertId, "not_for_me");
    vi.setSystemTime(new Date("2026-11-05T20:00:00Z"));
    market.pools = [spikePool(8)];
    expect(await tide.scan()).toBe(0);

    // Wipe test: drop the cache, rebuild from Walrus Memory alone.
    const before = tide.memoryReport(USER);
    await memory.flush();
    store.wipeDerived();
    expect(store.getUser(USER)).toBeNull();
    const counts = await memory.rebuild([USER]);
    expect(counts[userNamespace(USER)]).toBeGreaterThan(10);
    expect(store.getUser(USER)!.budgetUsd).toBe(40);
    expect(store.getPref(USER, "mute_established")).toBe("true");
    expect(store.outcomes(USER, "established")).toHaveLength(6);
    // Report differs only in the Walrus write counters, which live outside the replayed tables.
    const stripCounts = (s: string) => s.replace(/\d+ stored.*$/m, "");
    expect(stripCounts(tide.memoryReport(USER))).toBe(stripCounts(before));
  });

  it("brings every user back after a deploy wipes the disk", async () => {
    const { tide, store, memory } = setup();
    tide.start(USER, USER);
    tide.setBudget(USER, 25);
    tide.setLaunches(USER, true);
    tide.start(99, 99); // not an admin, found through the shared registry
    await memory.flush();
    store.wipeDerived();
    expect(store.allUserIds()).toEqual([]);
    expect(await tide.restore([])).toBe(2);
    expect(store.getUser(USER)!.budgetUsd).toBe(25);
    expect(store.getPref(USER, "launches")).toBe("true");
    expect(await tide.restore([])).toBe(0); // only runs on an empty cache
  });

  it("closes a position when the coin leaves the wallet", async () => {
    const { tide, sui, market, store } = setup();
    tide.start(USER, USER);
    await tide.setWallet(USER, "0x" + "1".repeat(64));
    market.prices.set(normaliseCoinType(SCOOP), 0.01);
    sui.balancesNow = [{ coinType: SUI, raw: "1" }, { coinType: SCOOP, raw: String(100 * 1e9) }];
    await tide.checkWallet(store.getUser(USER)!);
    market.prices.set(normaliseCoinType(SCOOP), 0.015);
    sui.balancesNow = [{ coinType: SUI, raw: "1" }];
    await tide.checkWallet(store.getUser(USER)!);
    expect(store.openHoldings(USER)).toHaveLength(0);
  });
});
