import { MemWalMock } from "@mysten-incubation/memwal";
import { describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { Tide, type ChainReader } from "../src/tide.js";

/** Runs real Telegram updates through the bot with Telegram's API faked out. */
function harness() {
  const store = new Store(":memory:");
  const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
  const reader: ChainReader = { balances: async () => [], coinInfo: async () => ({ symbol: "X", decimals: 9 }) };
  const market = { candidatePools: async () => [], quote: async () => null, topTokens: async () => [] } as unknown as Market;
  const tide = new Tide(store, memory, { sui: reader, solana: reader }, market);
  const bot = createBot("123:test", tide, { adminIds: [] });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Tide", username: "usetidebot" } as never;
  const sent: string[] = [];
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === "sendMessage") sent.push(payload.text);
    return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 0, chat: { id: 7, type: "private" } } : true } as never;
  });
  let id = 0;
  const say = (text: string) =>
    bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 7, type: "private", first_name: "Pascal" },
        from: { id: 7, is_bot: false, first_name: "Pascal" },
        text,
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
      },
    } as never);
  return { store, sent, say };
}

describe("bot understands plain language", () => {
  it("turns launch alerts on and off without slash commands", async () => {
    const { store, sent, say } = harness();
    await say("turn on alert for launches");
    expect(store.getPref(7, "launches")).toBe("true");
    expect(sent.at(-1)).toContain("launch alerts are on");
    await say("stop the launch alerts");
    expect(store.getPref(7, "launches")).toBe("false");
  });

  it("sets the budget, the share and the chains from plain words", async () => {
    const { store, say } = harness();
    await say("set my budget to $40");
    expect(store.getUser(7)!.budgetUsd).toBe(40);
    await say("use 20% per alert");
    expect(store.getUser(7)!.baseShare).toBe(0.2);
    await say("only solana alerts");
    expect(store.getPref(7, "mute_chain_sui")).toBe("true");
    await say("alerts for both chains");
    expect(store.getPref(7, "mute_chain_sui")).toBe("false");
    await say("pause alerts");
    expect(store.getUser(7)!.alertsOn).toBe(false);
  });

  it("slash commands still work and do the same thing", async () => {
    const { store, say } = harness();
    await say("/launches on");
    expect(store.getPref(7, "launches")).toBe("true");
    await say("/budget 25");
    expect(store.getUser(7)!.budgetUsd).toBe(25);
  });

  it("takes a plain-language budget while waiting for a number", async () => {
    const { store, sent, say } = harness();
    await say("/budget");
    expect(sent.at(-1)).toContain("how much");
    await say("50 dollars");
    expect(store.getUser(7)!.budgetUsd).toBe(50);
  });

  it("leaves ordinary chat to the AI (or the fallback without a key)", async () => {
    const { store, sent, say } = harness();
    await say("hey whats up");
    expect(store.getPref(7, "launches")).toBeNull();
    expect(sent.at(-1)).toContain("paste your sui or solana wallet");
  });
});
