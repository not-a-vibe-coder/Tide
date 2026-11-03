import { describe, expect, it } from "vitest";
import { diffBalances, isCash, normaliseCoinType, toUnits } from "../src/core/buys.js";
import { proposeBudget, startOfWeekLagos, suggestSize, trackRecordMultiplier } from "../src/core/sizing.js";
import { assessRisk, classifyToken, detectSpike } from "../src/core/spike.js";
import { coinTypeFromTokenId, normalisePool } from "../src/market/gecko.js";
import { NOW, SCOOP, pool, rawGeckoPool } from "./fixtures.js";

describe("sizing", () => {
  it("matches the worked example in the project doc", () => {
    const r = suggestSize({ budgetLeftUsd: 30, baseShare: 0.25, trackRecord: 0.8, riskMultiplier: 0.5 });
    expect(r.maxUsd).toBe(3);
  });

  it("never suggests a size from a negative budget", () => {
    expect(suggestSize({ budgetLeftUsd: -10, baseShare: 0.25, trackRecord: 1, riskMultiplier: 1 }).maxUsd).toBe(0);
  });

  it("keeps h at 1 until 5 outcomes, then maps win rate to 0.5..1.2", () => {
    expect(trackRecordMultiplier([true, false, false, false])).toBe(1);
    expect(trackRecordMultiplier([false, false, false, false, false])).toBe(0.5);
    expect(trackRecordMultiplier([true, true, true, true, true])).toBe(1.2);
    expect(trackRecordMultiplier([true, true, false, false, false])).toBe(0.78);
  });

  it("only uses the most recent 10 outcomes", () => {
    const old = Array(10).fill(false);
    const recent = Array(10).fill(true);
    expect(trackRecordMultiplier([...old, ...recent])).toBe(1.2);
  });

  it("proposes 10% of liquid balance rounded to $5, minimum $5", () => {
    expect(proposeBudget(300)).toBe(30);
    expect(proposeBudget(12)).toBe(5);
    expect(proposeBudget(1234)).toBe(125);
  });

  it("starts the week on Monday in Lagos time", () => {
    // Monday 3 Nov 2026 00:30 Lagos = Sunday 2 Nov 23:30 UTC
    expect(startOfWeekLagos(new Date("2026-11-05T12:00:00Z")).toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(startOfWeekLagos(new Date("2026-11-01T23:30:00Z")).toISOString()).toBe("2026-11-01T23:00:00.000Z");
  });
});

describe("spike detection", () => {
  it("flags a pool whose last hour is 3x+ its average hour", () => {
    const s = detectSpike(pool(), undefined, NOW);
    expect(s).not.toBeNull();
    expect(s!.volumeMultiple).toBe(8);
    expect(s!.reasons[0]).toContain("8.0×");
  });

  it("flags a fast price / market cap jump", () => {
    const s = detectSpike(pool({ volumeUsd: { m5: 0, h1: 6_000, h6: 30_000, h24: 120_000 }, priceChangePct: { m5: 0, h1: 25, h6: 0, h24: 0 } }), undefined, NOW);
    expect(s!.reasons).toEqual(["price and market cap up 25% in 1h"]);
  });

  it("ignores thin or quiet pools", () => {
    expect(detectSpike(pool({ liquidityUsd: 2_000 }), undefined, NOW)).toBeNull();
    expect(detectSpike(pool({ volumeUsd: { m5: 0, h1: 1_000, h6: 0, h24: 2_000 } }), undefined, NOW)).toBeNull();
    expect(detectSpike(pool({ volumeUsd: { m5: 0, h1: 6_000, h6: 0, h24: 120_000 }, priceChangePct: { m5: 0, h1: 5, h6: 0, h24: 0 } }), undefined, NOW)).toBeNull();
  });

  it("classes pools under 7 days as new", () => {
    expect(classifyToken(pool({ createdAt: new Date("2026-11-03T00:00:00Z") }), NOW)).toBe("new");
    expect(classifyToken(pool(), NOW)).toBe("established");
  });
});

describe("risk check", () => {
  it("is lower risk for a deep, older pool", () => {
    const r = assessRisk(pool(), NOW);
    expect(r.multiplier).toBe(1);
    expect(r.label).toBe("lower");
  });

  it("stacks thin liquidity, young pool and heavy selling, floored at 0.25", () => {
    const r = assessRisk(
      pool({ liquidityUsd: 15_000, createdAt: new Date("2026-11-05T06:00:00Z"), txH1: { buys: 10, sells: 40 } }),
      NOW,
    );
    expect(r.multiplier).toBe(0.25);
    expect(r.label).toBe("high");
    expect(r.flags).toHaveLength(3);
  });
});

describe("buy detection", () => {
  const SUI = "0x2::sui::SUI";
  it("treats the first snapshot as a baseline", () => {
    expect(diffBalances(null, [{ coinType: SCOOP, raw: "100" }])).toEqual([]);
  });

  it("detects a swap from SUI into a token and ignores cash coins", () => {
    const before = [{ coinType: SUI, raw: "5000000000" }];
    const after = [
      { coinType: SUI, raw: "3000000000" },
      { coinType: SCOOP, raw: "1500000000" },
    ];
    expect(diffBalances(before, after)).toEqual([{ coinType: normaliseCoinType(SCOOP), rawDelta: 1_500_000_000n }]);
  });

  it("detects a top-up of an existing position but not a sale", () => {
    const before = [{ coinType: SCOOP, raw: "100" }];
    expect(diffBalances(before, [{ coinType: SCOOP, raw: "250" }])[0]!.rawDelta).toBe(150n);
    expect(diffBalances(before, [{ coinType: SCOOP, raw: "50" }])).toEqual([]);
  });

  it("normalises long and short forms of SUI", () => {
    expect(isCash("0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI")).toBe(true);
    expect(isCash(SCOOP)).toBe(false);
  });

  it("converts raw amounts with decimals", () => {
    expect(toUnits(1_500_000_000n, 9)).toBe(1.5);
    expect(toUnits("2500000", 6)).toBe(2.5);
  });
});

describe("GeckoTerminal parsing", () => {
  it("reads a real pool shape", () => {
    const p = normalisePool(rawGeckoPool as never);
    expect(p.baseCoinType).toBe(normaliseCoinType(SCOOP));
    expect(p.baseSymbol).toBe("SCOOP");
    expect(p.priceUsd).toBeCloseTo(0.0123);
    expect(p.marketCapUsd).toBeNull();
    expect(p.liquidityUsd).toBeCloseTo(45000.5);
    expect(p.volumeUsd.h1).toBe(25_000);
    expect(p.priceChangePct.h1).toBeCloseTo(34.5);
    expect(p.txH1).toEqual({ buys: 90, sells: 40 });
  });

  it("strips the network prefix from token ids", () => {
    expect(coinTypeFromTokenId("sui-network_0x2::sui::SUI")).toBe("0x2::sui::SUI");
  });
});
