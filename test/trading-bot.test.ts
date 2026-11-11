import { MemWalMock } from "@mysten-incubation/memwal";
import type { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import { parseTradeIntent } from "../src/bot/trading.js";
import { SOL_MINT } from "../src/core/chains.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";
import { TradeDesk, type TraderLike } from "../src/trade/desk.js";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("trading in plain words", () => {
  it("understands buys and sells", () => {
    expect(parseTradeIntent("buy 0.1 sol of $WIF")).toEqual({ action: "buy", sol: 0.1, token: "$WIF" });
    expect(parseTradeIntent("ape 0.25 sol into " + MINT)).toEqual({ action: "buy", sol: 0.25, token: MINT });
    expect(parseTradeIntent("buy BONK with 0.5 sol")).toEqual({ action: "buy", sol: 0.5, token: "BONK" });
    expect(parseTradeIntent("sell all $WIF")).toEqual({ action: "sell", token: "$WIF", pct: 100 });
    expect(parseTradeIntent("sell 50% of bonk")).toEqual({ action: "sell", token: "bonk", pct: 50 });
    expect(parseTradeIntent("sell half my WIF")).toEqual({ action: "sell", token: "WIF", pct: 50 });
    expect(parseTradeIntent("should i buy $wif?")).toBeNull();
    expect(parseTradeIntent("sell wif?")).toBeNull();
  });

  it("understands the wallet, withdrawals and exits", () => {
    expect(parseTradeIntent("my trading wallet")).toEqual({ action: "home" });
    expect(parseTradeIntent("show my positions")).toEqual({ action: "positions" });
    expect(parseTradeIntent("withdraw all to " + MINT)).toEqual({ action: "withdraw", amount: "all", to: MINT });
    expect(parseTradeIntent("withdraw 0.5 sol")).toEqual({ action: "withdraw", amount: 0.5, to: null });
    expect(parseTradeIntent("export my private key")).toEqual({ action: "export" });
    expect(parseTradeIntent("take profit at 150%")).toEqual({ action: "exit", which: "tp", value: 150 });
    expect(parseTradeIntent("stop loss off")).toEqual({ action: "exit", which: "sl", value: null });
    expect(parseTradeIntent("daily limit 3 sol")).toEqual({ action: "dailyCap", sol: 3 });
    expect(parseTradeIntent("buy buttons 0.1 0.2 0.5")).toEqual({ action: "amounts", sol: [0.1, 0.2, 0.5] });
  });

  it("understands sniper rules", () => {
    expect(parseTradeIntent("turn on auto snipe")).toEqual({ action: "snipeSet", set: { auto: true } });
    expect(parseTradeIntent("stop sniping")).toEqual({ action: "snipeSet", set: { auto: false } });
    expect(parseTradeIntent("snipe 0.1 sol under 20k mcap")).toEqual({ action: "snipeSet", set: { sol: 0.1, mcapMaxUsd: 20_000 } });
    expect(parseTradeIntent("snipe only after 8 buyers in 30s")).toEqual({ action: "snipeSet", set: { minBuyers: 8, windowSec: 30 } });
    expect(parseTradeIntent("max 3 snipes a day")).toEqual({ action: "snipeSet", set: { maxPerDay: 3 } });
    expect(parseTradeIntent("snipe when creator holds under 5%")).toEqual({ action: "snipeSet", set: { devMaxPct: 5 } });
    expect(parseTradeIntent("snipe launch alerts on")).toEqual({ action: "snipeSet", set: { alerts: true } });
    expect(parseTradeIntent("show my sniper settings")).toEqual({ action: "sniper" });
  });

  it("leaves everything else to the rest of the bot", () => {
    for (const t of ["turn on launch alerts", "only send tokens under 100k mcap", "top 5 on solana", "show my bags", "how much volume is on sui"]) expect(parseTradeIntent(t)).toBeNull();
  });
});

describe("trading in Telegram", () => {
  function harness(withSeed = true) {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const reader: ChainReader = { balances: async () => [], coinInfo: async () => ({ symbol: "X", decimals: 9 }) };
    const market = { candidatePools: async () => [], quote: async (m: string) => (m === SOL_MINT ? { priceUsd: 150, volumeH24Usd: 1, liquidityUsd: 1 } : null), symbol: async () => "WIF", search: async () => [], topTokens: async () => [] } as unknown as Market;
    const tide = new Tide(store, memory, { sui: reader, solana: reader }, market);
    const bal = new Map<string, bigint>();
    const trader: TraderLike = {
      lamports: async (o) => bal.get(o) ?? 0n,
      tokenBalance: async (o, m) => ({ raw: bal.get(`${o}:${m}`) ?? 0n, decimals: 6 }),
      buy: async (kp: Keypair, m, l) => {
        const o = kp.publicKey.toBase58();
        bal.set(o, (bal.get(o) ?? 0n) - l);
        bal.set(`${o}:${m}`, (bal.get(`${o}:${m}`) ?? 0n) + l * 10_000n);
        return { signature: "SIG", route: "jupiter" };
      },
      sell: async () => ({ signature: "S", route: "jupiter" }),
      transfer: async () => "T",
    };
    const desk = new TradeDesk(store, memory, trader, market, (c, h, b) => tide.notify(c, h, b), { masterSeed: withSeed ? "x".repeat(40) : null, maxTradeSol: 1, dailySolCap: 2, slippageBps: 1500, pollMs: 1 });
    tide.desk = desk;
    const bot = createBot("123:test", tide, { adminIds: [], desk, market });
    bot.botInfo = { id: 1, is_bot: true, first_name: "Tide", username: "usetidebot" } as never;
    const sent: { text: string; markup?: any }[] = [];
    bot.api.config.use(async (_prev, method, payload: any) => {
      if (method === "sendMessage") sent.push({ text: payload.text, markup: payload.reply_markup });
      return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 7, type: "private" } } : true } as never;
    });
    let id = 0;
    const say = (text: string) =>
      bot.handleUpdate({
        update_id: ++id,
        message: { message_id: id, date: 0, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Pascal" }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}) },
      } as never);
    const tap = (data: string) =>
      bot.handleUpdate({
        update_id: ++id,
        callback_query: { id: String(id), chat_instance: "c", data, from: { id: 7, is_bot: false, first_name: "Pascal" }, message: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } },
      } as never);
    return { sent, say, tap, desk, bal, store };
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("shows the risks first, then the wallet", async () => {
    const { sent, say, tap, desk } = harness();
    await say("/trade");
    expect(sent.at(-1)!.text).toContain("before i trade for you");
    expect(sent.at(-1)!.text).toContain("only put in what you're ready to lose");
    await tap("tw:ack");
    expect(sent.at(-1)!.text).toContain(desk.address(7));
    expect(sent.at(-1)!.text).toContain("balance: <b>0 sol</b>");
  });

  it("buys after a confirm tap, from plain words", async () => {
    const { sent, say, tap, desk, bal, store } = harness();
    await say("/trade");
    await tap("tw:ack");
    bal.set(desk.address(7), 500_000_000n);
    await say(`buy 0.1 sol of ${MINT}`);
    expect(sent.at(-1)!.text).toContain("buy <b>0.1 sol</b> of <b>WIF</b>?");
    expect(JSON.stringify(sent.at(-1)!.markup)).toContain(`b:${MINT}:0.1`);
    await tap(`b:${MINT}:0.1`);
    await settle();
    expect(sent.at(-1)!.text).toContain("bought <b>1.00M WIF</b>");
    expect(store.positions(7)).toHaveLength(1);
  });

  it("is off cleanly without a master seed", async () => {
    const { sent, say } = harness(false);
    await say("/trade");
    expect(sent.at(-1)!.text).toContain("trading isn't switched on");
  });

  it("sets sniper rules from plain words", async () => {
    const { sent, say, tap, desk } = harness();
    await say("/trade");
    await tap("tw:ack");
    await say("snipe 0.1 sol under 20k mcap");
    expect(desk.rules(7)).toMatchObject({ sol: 0.1, mcapMaxUsd: 20_000 });
    expect(sent.at(-1)!.text).toContain("your sniper");
    await tap("sn:auto:on");
    expect(desk.rules(7).auto).toBe(true);
  });
});
