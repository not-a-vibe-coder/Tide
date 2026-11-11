import { MemWalMock } from "@mysten-incubation/memwal";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOL_MINT } from "../src/core/chains.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { TradeDesk, type TraderLike } from "../src/trade/desk.js";
import { DEFAULT_RULES, describeRules, exitHit, launchMiss, readRules, type Launch } from "../src/trade/rules.js";
import { parseStreamMessage, PumpStream } from "../src/trade/stream.js";
import { SolanaTrader } from "../src/trade/trader.js";
import { deriveTradingKeypair, exportSecret, isSolanaAddress } from "../src/trade/wallet.js";

const SEED = "a-very-long-master-seed-for-tests-only-0123456789";
const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("trading wallets", () => {
  it("derive the same wallet every time, different per user and per wallet number", () => {
    const a = deriveTradingKeypair(SEED, 42).publicKey.toBase58();
    expect(deriveTradingKeypair(SEED, 42).publicKey.toBase58()).toBe(a);
    expect(deriveTradingKeypair(SEED, 43).publicKey.toBase58()).not.toBe(a);
    expect(deriveTradingKeypair(SEED, 42, 1).publicKey.toBase58()).not.toBe(a);
    expect(deriveTradingKeypair(SEED + "x", 42).publicKey.toBase58()).not.toBe(a);
  });

  it("refuse a short master seed", () => {
    expect(() => deriveTradingKeypair("short", 1)).toThrow(/32 characters/);
  });

  it("export a key Phantom can import, and check addresses", () => {
    const kp = deriveTradingKeypair(SEED, 1);
    const back = Keypair.fromSecretKey(Uint8Array.from(require("bs58").default.decode(exportSecret(kp))));
    expect(back.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(isSolanaAddress(kp.publicKey.toBase58())).toBe(true);
    expect(isSolanaAddress("0x2::sui::SUI")).toBe(false);
  });
});

describe("sniper rules", () => {
  const launch = (o: Partial<Launch> = {}): Launch => ({ mint: MINT, name: "Test", symbol: "TST", creator: "c", creatorBuyTokens: 30_000_000, marketCapSol: 30, at: 0, ...o });

  it("check market cap, creator share and early buyers", () => {
    const r = { ...DEFAULT_RULES, mcapMaxUsd: 30_000, devMaxPct: 10, minBuyers: 5 };
    expect(launchMiss(launch(), null, r, 150)).toBe("waiting for buyers");
    expect(launchMiss(launch(), { buyers: 6, buys: 9, sells: 2, marketCapSol: 40 }, r, 150)).toBeNull();
    expect(launchMiss(launch(), { buyers: 3, buys: 3, sells: 0, marketCapSol: 40 }, r, 150)).toBe("not enough buyers yet");
    expect(launchMiss(launch(), { buyers: 6, buys: 4, sells: 9, marketCapSol: 40 }, r, 150)).toBe("more sells than buys");
    expect(launchMiss(launch({ marketCapSol: 400 }), null, r, 150)).toBe("market cap over your limit");
    expect(launchMiss(launch({ creatorBuyTokens: 200_000_000 }), null, r, 150)).toBe("creator holds too much");
    expect(launchMiss(launch(), null, { ...r, minBuyers: 0 }, 150)).toBeNull();
  });

  it("read stored rules over the defaults", () => {
    const prefs: Record<string, string> = { snipe_auto: "true", snipe_sol: "0.2", snipe_mcap_max: "off", snipe_tp: "250" };
    const r = readRules((k) => prefs[k] ?? null);
    expect(r).toMatchObject({ auto: true, sol: 0.2, mcapMaxUsd: null, tpPct: 250, slPct: 40 });
    expect(describeRules(r, (n) => `$${n}`)).toContain("0.2 sol a snipe");
  });

  it("know when to take profit or stop out", () => {
    expect(exitHit(120, 100, 40)).toBe("take_profit");
    expect(exitHit(-45, 100, 40)).toBe("stop_loss");
    expect(exitHit(20, 100, 40)).toBeNull();
    expect(exitHit(500, null, null)).toBeNull();
  });
});

describe("pump.fun stream", () => {
  it("parses launches and trades", () => {
    const l = parseStreamMessage(JSON.stringify({ txType: "create", mint: MINT, name: "Dog", symbol: "DOG", traderPublicKey: "dev", initialBuy: 50_000_000, marketCapSol: 28.5 }));
    expect(l).toMatchObject({ kind: "launch", launch: { symbol: "DOG", creatorBuyTokens: 50_000_000, marketCapSol: 28.5 } });
    expect(parseStreamMessage(JSON.stringify({ txType: "buy", mint: MINT, traderPublicKey: "w1", solAmount: 0.5, marketCapSol: 31 }))).toMatchObject({ kind: "trade", trade: { side: "buy" } });
    expect(parseStreamMessage("not json")).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ message: "Successfully subscribed" }))).toBeNull();
  });

  it("subscribes, counts early buyers, and resubscribes on reconnect", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const handlers: Record<string, (x?: unknown) => void> = {};
    const sock = { readyState: 1, send: (m: string) => sent.push(m), close: () => {}, on: (ev: string, fn: (x?: unknown) => void) => (handlers[ev] = fn) };
    const launches: Launch[] = [];
    const s = new PumpStream("wss://x", (l) => launches.push(l), () => sock as never);
    s.start();
    handlers.open!();
    expect(sent[0]).toContain("subscribeNewToken");
    s.handle(JSON.stringify({ txType: "create", mint: MINT, symbol: "A", marketCapSol: 30 }));
    expect(launches).toHaveLength(1);
    const p = s.collect(MINT, 10_000, 30);
    expect(sent.at(-1)).toContain("subscribeTokenTrade");
    for (const w of ["a", "b", "a", "c"]) s.handle(JSON.stringify({ txType: "buy", mint: MINT, traderPublicKey: w, marketCapSol: 35 }));
    s.handle(JSON.stringify({ txType: "sell", mint: MINT, traderPublicKey: "a", marketCapSol: 34 }));
    vi.advanceTimersByTime(10_000);
    expect(await p).toEqual({ buyers: 3, buys: 4, sells: 1, marketCapSol: 34 });
    expect(sent.at(-1)).toContain("unsubscribeTokenTrade");
    vi.useRealTimers();
  });
});

describe("swap engine", () => {
  afterEach(() => vi.unstubAllGlobals());
  const kp = deriveTradingKeypair(SEED, 9);
  const unsigned = () =>
    new VersionedTransaction(
      new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message(),
    ).serialize();
  const rpc = () => {
    const calls: string[] = [];
    return {
      calls,
      async rpc<T>(method: string, params: unknown[]): Promise<T> {
        calls.push(method);
        if (method === "sendTransaction") {
          const tx = VersionedTransaction.deserialize(Buffer.from(params[0] as string, "base64"));
          expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true); // signed by the user's wallet
          return "SIG123" as T;
        }
        if (method === "getSignatureStatuses") return { value: [{ err: null, confirmationStatus: "confirmed" }] } as T;
        if (method === "getLatestBlockhash") return { value: { blockhash: Keypair.generate().publicKey.toBase58() } } as T;
        throw new Error("unexpected " + method);
      },
    };
  };

  it("buys through Jupiter, signs, sends and waits for confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ outAmount: "1000", inAmount: "100" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ swapTransaction: Buffer.from(unsigned()).toString("base64") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = rpc();
    const res = await new SolanaTrader(r, { pollMs: 1 }).buy(kp, MINT, 100_000_000n, 1500);
    expect(res).toEqual({ signature: "SIG123", route: "jupiter" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`inputMint=${SOL_MINT}`);
    expect(r.calls).toEqual(["sendTransaction", "getSignatureStatuses"]);
  });

  it("falls back to PumpPortal for tokens Jupiter can't route yet", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "No routes found" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(unsigned(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new SolanaTrader(rpc(), { pollMs: 1 }).buy(kp, MINT, 50_000_000n, 1500);
    expect(res.route).toBe("pumpportal");
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(body).toMatchObject({ action: "buy", mint: MINT, amount: 0.05, denominatedInSol: "true", pool: "auto" });
  });

  it("reports a trade that failed on-chain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(unsigned(), { status: 200 })));
    const bad = { async rpc<T>(m: string): Promise<T> { return (m === "sendTransaction" ? "S" : { value: [{ err: { InstructionError: [] } }] }) as T; } };
    await expect(new SolanaTrader(bad, { pollMs: 1 }).buy(kp, MINT, 1n, 1500, true)).rejects.toThrow(/failed on-chain/);
  });
});

describe("trade desk", () => {
  class FakeTrader implements TraderLike {
    sol = new Map<string, bigint>();
    tokens = new Map<string, bigint>();
    /** Lamports received per raw token unit on a sell (paid 1e-4; change it to move the price). */
    sellRate = 0.0001;
    async lamports(o: string) { return this.sol.get(o) ?? 0n; }
    async tokenBalance(o: string, m: string) { return { raw: this.tokens.get(`${o}:${m}`) ?? 0n, decimals: 6 }; }
    async buy(kp: Keypair, m: string, lamports: bigint) {
      const o = kp.publicKey.toBase58();
      this.sol.set(o, (this.sol.get(o) ?? 0n) - lamports - 5000n);
      this.tokens.set(`${o}:${m}`, (this.tokens.get(`${o}:${m}`) ?? 0n) + lamports * 10_000n);
      return { signature: "BUYSIG", route: "jupiter" as const };
    }
    async sell(kp: Keypair, m: string, raw: bigint) {
      const o = kp.publicKey.toBase58();
      this.tokens.set(`${o}:${m}`, (this.tokens.get(`${o}:${m}`) ?? 0n) - raw);
      this.sol.set(o, (this.sol.get(o) ?? 0n) + BigInt(Math.round(Number(raw) * this.sellRate)));
      return { signature: "SELLSIG", route: "jupiter" as const };
    }
    async transfer(kp: Keypair, _to: string, lamports: bigint) {
      const o = kp.publicKey.toBase58();
      this.sol.set(o, (this.sol.get(o) ?? 0n) - lamports - 5000n);
      return "SENDSIG";
    }
  }

  function setup(seed: string | null = SEED) {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const trader = new FakeTrader();
    const prices = new Map<string, number>([[SOL_MINT, 150]]);
    const market = { quote: async (m: string) => (prices.has(m) ? { priceUsd: prices.get(m)!, volumeH24Usd: 1, liquidityUsd: 1 } : null), symbol: async () => "WIF" } as unknown as Market;
    const sent: { chat: number; html: string }[] = [];
    const desk = new TradeDesk(store, memory, trader, market, async (chat, html) => void sent.push({ chat, html }), { masterSeed: seed, maxTradeSol: 1, dailySolCap: 2, slippageBps: 1500, pollMs: 1 });
    memory.record(7, { type: "profile_set", chatId: 7 });
    return { store, memory, trader, prices, desk, sent };
  }

  it("is off without a master seed, and needs the risk warning accepted", async () => {
    expect((await setup(null).desk.buy(7, MINT, 0.1)).text).toMatch(/isn't switched on/);
    const { desk } = setup();
    expect((await desk.buy(7, MINT, 0.1)).text).toMatch(/open \/trade first/);
  });

  it("buys, records the trade on Walrus, and sells with profit and loss", async () => {
    const { desk, trader, store, memory } = setup();
    desk.acknowledge(7);
    trader.sol.set(desk.address(7), 1_000_000_000n);
    const b = await desk.buy(7, MINT, 0.1);
    expect(b.ok).toBe(true);
    expect(b.text).toContain("bought <b>1.00M WIF</b> for 0.1 sol ($15.00)");
    expect(b.buttons![0]!.map((x) => x.data)).toEqual([`s:${MINT}:50`, `s:${MINT}:100`]);
    const pos = store.position(7, MINT)!;
    expect(pos.tokens_raw).toBe("1000000000000");
    expect(pos.cost_usd).toBeCloseTo(15);

    trader.sellRate = 0.00015; // tokens now worth 1.5× what was paid
    const s = await desk.sell(7, MINT, 50);
    expect(s.text).toContain("sold 50% of <b>WIF</b> for 0.075 sol");
    expect(s.text).toContain("+50% on what you put in");
    expect(store.position(7, MINT)!.tokens_raw).toBe("500000000000");
    await desk.sell(7, MINT, 100);
    expect(store.position(7, MINT)).toBeNull();

    // the whole history survives a wipe: positions come back from Walrus
    await memory.flush();
    store.wipeDerived();
    await memory.rebuild([7]);
    expect(store.positions(7)).toEqual([]);
    expect(store.lamportsSpentSince(7, new Date(0))).toBe(100_000_000n);
  });

  it("refuses trades over the per-trade cap, the daily cap, or the balance", async () => {
    const { desk, trader } = setup();
    desk.acknowledge(7);
    expect((await desk.buy(7, MINT, 5)).text).toMatch(/1 sol limit per trade/);
    expect((await desk.buy(7, MINT, 0.5)).text).toMatch(/not enough sol/);
    trader.sol.set(desk.address(7), 10_000_000_000n);
    for (let i = 0; i < 4; i++) expect((await desk.buy(7, MINT, 0.5)).ok).toBe(true);
    expect((await desk.buy(7, MINT, 0.5)).text).toMatch(/daily limit/);
  });

  it("counts trading-wallet buys against the weekly budget", async () => {
    const { desk, trader, store } = setup();
    desk.acknowledge(7);
    trader.sol.set(desk.address(7), 1_000_000_000n);
    await desk.buy(7, MINT, 0.2);
    expect(store.spentSince(7, new Date(0))).toBeCloseTo(30);
  });

  it("takes profit and stops losses on its own", async () => {
    const { desk, trader, prices, sent } = setup();
    desk.acknowledge(7);
    desk.setExits(7, "tp", 100);
    desk.setExits(7, "sl", 40);
    trader.sol.set(desk.address(7), 1_000_000_000n);
    prices.set(MINT, 0.000015); // 1M tokens = $15, what was paid
    await desk.buy(7, MINT, 0.1);
    expect(await desk.checkExits()).toBe(0);
    prices.set(MINT, 0.000032); // +113%
    trader.sellRate = 0.0002;
    expect(await desk.checkExits()).toBe(1);
    expect(sent.at(-1)!.html).toContain("take profit hit");
  });

  it("withdraws SOL", async () => {
    const { desk, trader } = setup();
    desk.acknowledge(7);
    trader.sol.set(desk.address(7), 500_000_000n);
    expect((await desk.withdraw(7, "11111111111111111111111111111111", 0.2)).text).toContain("sent 0.2 sol");
    expect((await desk.withdraw(7, "11111111111111111111111111111111", 5)).text).toMatch(/not enough sol/);
  });

  it("snipes a launch that fits the rules, alerts on one when auto is off, and skips the rest", async () => {
    const { desk, trader, sent } = setup();
    desk.acknowledge(7);
    trader.sol.set(desk.address(7), 1_000_000_000n);
    desk.setRule(7, "auto", true);
    desk.setRule(7, "minBuyers", 0);
    desk.setRule(7, "mcapMaxUsd", 10_000);
    const fresh: Launch = { mint: MINT, name: "Dog Coin", symbol: "DOG", creator: "c", creatorBuyTokens: 20_000_000, marketCapSol: 30, at: 0 };
    expect(await desk.onLaunch(fresh)).toBe(1);
    expect(sent.at(-1)!.html).toContain("sniped Dog Coin");
    expect(sent.at(-1)!.html).toContain("creator holds 2.0%");
    expect(await desk.onLaunch({ ...fresh, mint: "So11111111111111111111111111111111111111112", marketCapSol: 900 })).toBe(0); // $135k mcap, over the limit

    desk.setRule(7, "auto", false);
    desk.setRule(7, "alerts", true);
    const before = sent.length;
    expect(await desk.onLaunch({ ...fresh, mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" })).toBe(1);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.html).toContain("fits your rules");
  });
});
