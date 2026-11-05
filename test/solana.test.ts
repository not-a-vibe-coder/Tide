import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaReader } from "../src/chain/solana.js";
import type { CoinInfo } from "../src/chain/sui.js";
import { isCash } from "../src/core/buys.js";
import { SOLANA_USDC, SOL_MINT, chainOf, parseSolanaAddress } from "../src/core/chains.js";
import type { Pool } from "../src/core/types.js";
import { coinTypeFromTokenId, normalisePool, type Market, type TokenQuote } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";
import { pool, rawGeckoPool } from "./fixtures.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("chains", () => {
  it("tells Sui coin types from Solana mints", () => {
    expect(chainOf("0x2::sui::SUI")).toBe("sui");
    expect(chainOf(BONK)).toBe("solana");
  });

  it("parses Solana addresses and rejects junk", () => {
    expect(parseSolanaAddress(WALLET)).toBe(WALLET);
    expect(parseSolanaAddress("0x2")).toBeNull();
    expect(parseSolanaAddress("not a wallet at all")).toBeNull();
    expect(parseSolanaAddress("I0OlI0OlI0OlI0OlI0OlI0OlI0OlI0Ol")).toBeNull(); // not base58
  });

  it("treats SOL and Solana stablecoins as cash", () => {
    expect(isCash(SOL_MINT)).toBe(true);
    expect(isCash(SOLANA_USDC)).toBe(true);
    expect(isCash(BONK)).toBe(false);
  });

  it("reads Solana pools from GeckoTerminal", () => {
    const raw = structuredClone(rawGeckoPool);
    raw.relationships.base_token.data.id = `solana_${BONK}`;
    const p = normalisePool(raw as never);
    expect(p.chain).toBe("solana");
    expect(p.baseCoinType).toBe(BONK);
    expect(coinTypeFromTokenId(`solana_${BONK}`)).toBe(BONK);
  });
});

describe("SolanaReader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads SOL plus SPL and Token-2022 balances through Tatum, summing per mint", async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ method: body.method, headers: init.headers as Record<string, string> });
        const acct = (mint: string, amount: string, decimals: number) => ({
          account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
        });
        const result =
          body.method === "getBalance"
            ? { value: 2_500_000_000 }
            : body.params[1].programId.startsWith("Tokenkeg")
              ? { value: [acct(BONK, "100000", 5), acct(BONK, "50000", 5), acct(SOLANA_USDC, "0", 6)] }
              : { value: [] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }),
    );
    const reader = new SolanaReader("https://solana-mainnet.gateway.tatum.io", "key", async (m) => (m === BONK ? "BONK" : null));
    const b = await reader.balances(WALLET);
    expect(b).toEqual([
      { coinType: SOL_MINT, raw: "2500000000" },
      { coinType: BONK, raw: "150000" },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["getBalance", "getTokenAccountsByOwner", "getTokenAccountsByOwner"]);
    expect(calls[0]!.headers["x-api-key"]).toBe("key");
    expect(await reader.coinInfo(BONK)).toEqual({ symbol: "BONK", decimals: 5 });
    expect(await reader.coinInfo(SOL_MINT)).toEqual({ symbol: "SOL", decimals: 9 });
  });
});

describe("Tide with Sui and Solana wallets", () => {
  class FakeReader implements ChainReader {
    constructor(
      public balancesNow: { coinType: string; raw: string }[],
      private readonly info: Record<string, CoinInfo>,
    ) {}
    fail = false;
    async balances() {
      if (this.fail) throw new Error("rpc down");
      return this.balancesNow;
    }
    async coinInfo(t: string) {
      return this.info[t] ?? { symbol: "X", decimals: 9 };
    }
  }

  function setup() {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const sui = new FakeReader([{ coinType: "0x2::sui::SUI", raw: String(100e9) }], { "0x2::sui::SUI": { symbol: "SUI", decimals: 9 } });
    const sol = new FakeReader([{ coinType: SOL_MINT, raw: String(2e9) }, { coinType: SOLANA_USDC, raw: String(50e6) }], {
      [SOL_MINT]: { symbol: "SOL", decimals: 9 },
      [SOLANA_USDC]: { symbol: "USDC", decimals: 6 },
      [BONK]: { symbol: "BONK", decimals: 5 },
    });
    const prices = new Map<string, number>([
      ["0x2::sui::SUI", 1],
      [SOL_MINT, 150],
      [BONK, 0.00002],
    ]);
    const pools: Record<string, Pool[]> = { sui: [], solana: [] };
    const market = {
      candidatePools: async (chain: "sui" | "solana") => pools[chain],
      quote: async (t: string): Promise<TokenQuote | null> => (prices.has(t) ? { priceUsd: prices.get(t)!, volumeH24Usd: 1, liquidityUsd: 1 } : null),
    } as unknown as Market;
    const tide = new Tide(store, memory, { sui, solana: sol }, market, {
      sui: { minLiquidityUsd: 0, minHourlyVolumeUsd: 0, minVolumeMultiple: 3, minPriceChangeH1Pct: 20 },
      solana: { minLiquidityUsd: 0, minHourlyVolumeUsd: 0, minVolumeMultiple: 3, minPriceChangeH1Pct: 20 },
    });
    const sent: string[] = [];
    tide.attach({ send: async (_c, html) => void sent.push(html) });
    return { store, tide, sui, sol, pools, sent };
  }

  it("adds a Solana wallet next to Sui and prices cash across both", async () => {
    const { tide, store } = setup();
    tide.start(1, 1);
    const a = await tide.setWallet(1, "0x" + "1".repeat(64), "sui");
    expect(a.liquidUsd).toBe(100);
    const b = await tide.setWallet(1, WALLET, "solana");
    expect(b.liquidUsd).toBe(100 + 300 + 50); // 100 SUI@$1 + 2 SOL@$150 + 50 USDC
    expect(b.proposedBudget).toBe(45);
    expect(store.getUser(1)!.solWallet).toBe(WALLET);
  });

  it("detects a Solana buy, and a failed Sui read doesn't close Sui positions", async () => {
    const { tide, store, sui, sol, sent } = setup();
    tide.start(1, 1);
    await tide.setWallet(1, "0x" + "1".repeat(64), "sui");
    await tide.setWallet(1, WALLET, "solana");

    sol.balancesNow = [...sol.balancesNow, { coinType: BONK, raw: String(1_000_000 * 1e5) }];
    sui.fail = true;
    expect(await tide.checkWallet(store.getUser(1)!)).toBe(1);
    const h = store.openHoldings(1);
    expect(h).toHaveLength(1);
    expect(h[0]!.symbol).toBe("BONK");
    expect(h[0]!.costUsd).toBeCloseTo(20);
    expect(sent.at(-1)).toContain("BONK");
    expect(store.getSnapshot(1)!.some((b) => b.coinType === "0x2::sui::SUI")).toBe(true);
  });

  it("scans both chains and respects a per-chain mute", async () => {
    const { tide, pools, sent } = setup();
    tide.start(1, 1);
    pools.sui = [pool({ address: "0xs1" })];
    pools.solana = [pool({ chain: "solana", address: "sol1", baseCoinType: BONK, baseSymbol: "BONK" })];
    expect(await tide.scan()).toBe(2);
    expect(sent.some((m) => m.includes("moving on solana"))).toBe(true);
    expect(sent.some((m) => m.includes("geckoterminal.com/solana/pools/sol1"))).toBe(true);

    tide.setAlertChains(1, ["sui"]);
    pools.sui = [pool({ address: "0xs2" })];
    pools.solana = [pool({ chain: "solana", address: "sol2", baseCoinType: BONK, baseSymbol: "BONK" })];
    expect(await tide.scan()).toBe(1);
  });
});
