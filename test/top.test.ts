import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Companion } from "../src/ai/companion.js";
import { Llm } from "../src/ai/llm.js";
import { topList } from "../src/bot/format.js";
import { isCash } from "../src/core/buys.js";
import { SOLANA_USDC, SOL_MINT } from "../src/core/chains.js";
import { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { pool, rawGeckoPool } from "./fixtures.js";

function raw(baseId: string, vol24: string, name: string) {
  const r = structuredClone(rawGeckoPool) as any;
  r.relationships.base_token.data.id = baseId;
  r.attributes.volume_usd.h24 = vol24;
  r.attributes.address = `${baseId}-${vol24}`;
  r.attributes.name = name;
  return r;
}

describe("top tokens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ranks by 24h volume, one row per token, skipping SOL and stablecoins", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            raw(`solana_${SOL_MINT}`, "90000000", "SOL / USDC"),
            raw("solana_WIFmint11111111111111111111111111111111", "20000000", "WIF / SOL"),
            raw(`solana_${SOLANA_USDC}`, "50000000", "USDC / USDT"),
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
    await m.topTokens("solana", 5, isCash);
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
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
    await c.reply(1, "Pascal", "how are you today");
    expect(asked).toEqual([]);
  });
});
