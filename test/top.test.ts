import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Companion } from "../src/ai/companion.js";
import { Llm } from "../src/ai/llm.js";
import { topList } from "../src/bot/format.js";
import { isCash } from "../src/core/buys.js";
import { SOLANA_USDC, SOL_MINT } from "../src/core/chains.js";
import { Market, isStableSymbol } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { pool, rawGeckoPool } from "./fixtures.js";

function raw(baseId: string, vol24: string, name: string, liq = "500000", created = "2026-10-01T00:00:00Z") {
  const r = structuredClone(rawGeckoPool) as any;
  r.relationships.base_token.data.id = baseId;
  r.attributes.volume_usd.h24 = vol24;
  r.attributes.reserve_in_usd = liq;
  r.attributes.pool_created_at = created;
  r.attributes.address = `${baseId}-${vol24}`;
  r.attributes.name = name;
  return r;
}

describe("top tokens", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ranks by 24h volume, one row per token, skipping SOL, stablecoins and tiny pools", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            raw(`solana_${SOL_MINT}`, "90000000", "SOL / USDC"),
            raw("solana_WIFmint11111111111111111111111111111111", "20000000", "WIF / SOL"),
            raw(`solana_${SOLANA_USDC}`, "50000000", "USDC / USDT"),
            raw("solana_USDGmint1111111111111111111111111111111", "40000000", "USDG / USDC"),
            raw("solana_JUNKmint1111111111111111111111111111111", "99000000", "XT / SOL", "900"),
            raw("solana_WIFmint11111111111111111111111111111111", "5000000", "WIF / USDC"),
            raw("solana_BONKmint1111111111111111111111111111111", "30000000", "BONK / SOL"),
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const m = new Market("https://x", 0);
    const top = await m.topTokens("solana", 5, isCash);
    expect(top.map((p) => p.baseSymbol)).toEqual(["BONK", "WIF"]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/networks/solana/pools?page=1&sort=h24_volume_usd_desc");
    const calls = fetchMock.mock.calls.length;
    await m.topTokens("solana", 5, isCash);
    expect(fetchMock.mock.calls.length).toBe(calls); // cached
  });

  it("keeps only tokens launched in the window when asked", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T22:00:00Z"), toFake: ["Date"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              raw("solana_OLDmint11111111111111111111111111111111", "90000000", "OLD / SOL", "900000", "2026-09-01T00:00:00Z"),
              raw("solana_NEWmint11111111111111111111111111111111", "3000000", "NEW / SOL", "120000", "2026-11-05T15:00:00Z"),
            ],
          }),
        ),
      ),
    );
    const top = await new Market("https://x", 0).topTokens("solana", 5, isCash, { maxAgeHours: 24 });
    expect(top.map((p) => p.baseSymbol)).toEqual(["NEW"]);
  });

  it("recognises stablecoins by ticker", () => {
    for (const s of ["USDG", "USDC", "USD1", "PYUSD", "FDUSD", "USDe", "EURC", "DAI"]) expect(isStableSymbol(s)).toBe(true);
    for (const s of ["WIF", "BONK", "SUI", "USUAL", "SCOOP"]) expect(isStableSymbol(s)).toBe(false);
  });

  it("formats a list for /top", () => {
    const text = topList("sui", [pool({ baseSymbol: "SCOOP" })]);
    expect(text).toContain("top on sui by 24h volume");
    expect(text).toContain("1. <b>SCOOP</b>");
  });

  it("gives the model the live lists when asked what's leading", async () => {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const asked: string[] = [];
    const market = {
      quote: async () => null,
      search: async () => [],
      tokenPools: async () => [],
      topTokens: async (chain: string) => (asked.push(chain), [pool({ chain: chain as never, baseSymbol: chain === "sui" ? "SCOOP" : "WIF" })]),
    } as unknown as Market;
    const llm = new Llm({ groqKey: "k" });
    let system = "";
    llm.chat = async (msgs) => ((system = msgs[0]!.content), "ok");
    const c = new Companion(llm, store, memory, market, { sizingFor: () => null }, "jack");

    await c.reply(1, "Pascal", "get me top 5 leading tokens on solana and top 5 on sui right now");
    expect(asked).toEqual(["sui", "solana"]);
    expect(system).toContain("Top tokens right now by 24h volume");
    expect(system).toContain("1. WIF");
    expect(system).toContain("1. SCOOP");

    asked.length = 0;
    await c.reply(1, "Pascal", "what's trending on sol");
    expect(asked).toEqual(["solana"]);

    asked.length = 0;
    await c.reply(1, "Pascal", "give me their mc and try fetching data");
    expect(asked).toEqual([]);
    expect(system).toContain("The list you showed them a moment ago");
    expect(system).toContain("1. WIF");

    asked.length = 0;
    await c.reply(1, "Pascal", "list top 5 tokens on solana released in the past 24 hours");
    expect(asked).toEqual(["solana"]);
    expect(system).toContain("launched in the last 24 hours");
  });
});
