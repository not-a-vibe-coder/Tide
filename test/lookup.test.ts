import { MemWalMock } from "@mysten-incubation/memwal";
import { describe, expect, it } from "vitest";
import { enforceVoice } from "../src/ai/clean.js";
import { Companion } from "../src/ai/companion.js";
import { Llm } from "../src/ai/llm.js";
import { describeToken, extractMentions, pickPool } from "../src/ai/lookup.js";
import type { Pool } from "../src/core/types.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { NOW, SCOOP, pool } from "./fixtures.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("finding the token a message is about", () => {
  it("finds $tickers and tickers after verbs, but not ordinary words", () => {
    expect(extractMentions("should i buy pepe?")).toEqual([{ kind: "query", query: "pepe" }]);
    expect(extractMentions("thoughts on $WIF and $BONK")).toEqual([
      { kind: "query", query: "WIF" },
      { kind: "query", query: "BONK" },
    ]);
    expect(extractMentions("should i buy the dip on this?")).toEqual([]);
    expect(extractMentions("how is my wallet doing")).toEqual([]);
  });

  it("finds pasted Sui coin types and Solana mints", () => {
    expect(extractMentions(`is ${SCOOP} a rug`)[0]).toEqual({ kind: "token", token: SCOOP, label: "SCOOP" });
    expect(extractMentions(`check ${BONK}`)[0]).toMatchObject({ kind: "token", token: BONK });
  });

  it("matches tokens it already knows by symbol, without a $", () => {
    const known = [{ symbol: "SCOOP", token: SCOOP }];
    expect(extractMentions("how's scoop holding up", known)).toEqual([{ kind: "token", token: SCOOP, label: "SCOOP" }]);
    expect(extractMentions("scoopy is a dog", known)).toEqual([]);
  });

  it("caps lookups per message", () => {
    expect(extractMentions("$A1 $B2 $C3 $D4")).toHaveLength(2);
  });
});

describe("picking the right pool", () => {
  it("prefers an exact ticker match, then the deepest liquidity, and counts copycats", () => {
    const pools: Pool[] = [
      pool({ baseSymbol: "PEPE2", liquidityUsd: 9_000_000, baseCoinType: "x1" }),
      pool({ baseSymbol: "PEPE", liquidityUsd: 50_000, baseCoinType: "x2" }),
      pool({ baseSymbol: "PEPE", liquidityUsd: 2_000_000, baseCoinType: "x3" }),
    ];
    const { best, others } = pickPool("pepe", pools);
    expect(best!.baseCoinType).toBe("x3");
    expect(others).toBe(1);
  });
});

describe("token facts for the model", () => {
  it("leads with real numbers and the red flags", () => {
    const risky = pool({
      liquidityUsd: 12_000,
      createdAt: new Date("2026-11-05T06:00:00Z"),
      txH1: { buys: 15, sells: 60 },
      priceChangePct: { m5: 5, h1: 85, h6: 120, h24: 140 },
    });
    const text = describeToken(risky, ["their max size: $2"], NOW);
    expect(text).toContain("SCOOP on sui");
    expect(text).toContain("liquidity $12.0k");
    expect(text).toContain("+85.0% 1h");
    expect(text).toContain("15 buys vs 60 sells");
    expect(text).toContain("high risk");
    expect(text).toContain("thin liquidity");
    expect(text).toContain("pool under 1 day old");
    expect(text).toContain("brand-new pool");
    expect(text).toContain("their max size: $2");
  });
});

describe("chatting about a token", () => {
  it("looks the token up and gives the model the facts", async () => {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const searched: string[] = [];
    const market = {
      quote: async () => null,
      tokenPools: async () => [],
      search: async (q: string) => {
        searched.push(q);
        return q.toLowerCase() === "wif" ? [pool({ chain: "solana", baseSymbol: "WIF", baseCoinType: "EKpQ", liquidityUsd: 3_000_000 })] : [];
      },
    } as unknown as Market;
    const llm = new Llm({ groqKey: "k" });
    let system = "";
    llm.chat = async (m) => ((system = m[0]!.content), "ok");
    const companion = new Companion(llm, store, memory, market, { sizingFor: () => ({ maxUsd: 4 }) }, "jack");
    memory.record(1, { type: "profile_set", chatId: 1, budgetUsd: 30 });

    await companion.reply(1, "Pascal", "why shouldn't i buy $WIF? also $NOPE");
    expect(searched).toEqual(["WIF", "NOPE"]);
    expect(system).toContain("Token lookups");
    expect(system).toContain("WIF on solana");
    expect(system).toContain("their max size on this one by their own rules: $4");
    expect(system).toContain('I looked for "NOPE" on sui and solana and found no trading pool');
    expect(system).toContain("Red flags first");
  });
});

describe("voice enforcement", () => {
  it("fixes the capitalised reply from the first test chat", () => {
    expect(enforceVoice("I can absolutely track your trades. But I won't predict prices.")).toBe(
      "i can track your trades. but i won't predict prices.",
    );
  });

  it("keeps tickers and addresses intact", () => {
    expect(enforceVoice("SCOOP is up. WIF on Solana looks thin.")).toBe("SCOOP is up. WIF on solana looks thin.");
  });
});
