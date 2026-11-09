import { MemWalMock } from "@mysten-incubation/memwal";
import { describe, expect, it } from "vitest";
import { calledByName, createBot, welcome } from "../src/bot/bot.js";
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
  const payloads: any[] = [];
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === "sendMessage") {
      sent.push(payload.text);
      payloads.push(payload);
    }
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
  const group = (text: string, extra: Record<string, unknown> = {}) =>
    bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: -100500, type: "supergroup", title: "degens" },
        from: { id: 7, is_bot: false, first_name: "Pascal" },
        text,
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
        ...extra,
      },
    } as never);
  const added = () =>
    bot.handleUpdate({
      update_id: ++id,
      my_chat_member: {
        chat: { id: -100500, type: "supergroup", title: "degens" },
        from: { id: 7, is_bot: false, first_name: "Pascal" },
        date: 0,
        old_chat_member: { status: "left", user: { id: 1, is_bot: true, first_name: "Tide" } },
        new_chat_member: { status: "member", user: { id: 1, is_bot: true, first_name: "Tide" } },
      },
    } as never);
  return { store, sent, payloads, say, group, added };
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

describe("no storage plumbing in what users see", () => {
  const PLUMBING = /walrus|namespace|tide-user-|tide-tokens|stored ·|on the way|dry run|saving to/i;

  it("help, memory report and replies stay in plain language", async () => {
    const { sent, say } = harness();
    await say("/start");
    await say("/help");
    await say("set my budget to $30");
    await say("turn on launch alerts");
    await say("what do you remember about me");
    expect(sent.length).toBeGreaterThanOrEqual(5);
    for (const msg of sent) expect(msg).not.toMatch(PLUMBING);
    expect(sent.at(-1)).toContain("here's what i remember about you");
    expect(sent.at(-1)).toContain("$30 left this week");
    expect(sent.at(-1)).toContain("launch alerts on");
  });
});

describe("groups", () => {
  it("says hello when added and explains how to tag it", async () => {
    const { sent, payloads, added } = harness();
    await added();
    expect(sent.at(-1)).toContain("call me by name");
    expect(payloads.at(-1).chat_id).toBe(-100500);
    expect(JSON.stringify(payloads.at(-1).reply_markup)).toContain("t.me/usetidebot");
  });

  it("stays quiet unless tagged or replied to", async () => {
    const { sent, group } = harness();
    await group("anyone buying today?");
    expect(sent).toHaveLength(0);
    await group("@usetidebot hey");
    expect(sent).toHaveLength(1);
    await group("and you?", { reply_to_message: { message_id: 1, date: 0, chat: { id: -100500, type: "supergroup" }, from: { id: 1, is_bot: true, first_name: "Tide" }, text: "hi" } });
    expect(sent).toHaveLength(2);
  });

  it("answers as a reply to the message that tagged it", async () => {
    const { payloads, group } = harness();
    await group("@usetidebot hey");
    expect(payloads.at(-1).reply_parameters.message_id).toBeGreaterThan(0);
  });

  it("keeps wallets, budgets and bags out of the group", async () => {
    const { store, sent, group } = harness();
    await group(`@usetidebot 0x${"1".repeat(64)}`);
    expect(sent.at(-1)).toContain("in private");
    expect(store.getUser(7)?.wallet ?? null).toBeNull();
    await group("@usetidebot set my budget to 40");
    expect(sent.at(-1)).toContain("in private");
    expect(store.getUser(7)?.budgetUsd ?? null).toBeNull();
    await group("/holdings");
    expect(sent.at(-1)).toContain("in private");
  });

  it("never moves someone's private alerts into the group", async () => {
    const { store, say, group } = harness();
    await say("/start");
    await group("@usetidebot hey");
    expect(store.getUser(7)!.chatId).toBe(7);
  });

  it("ignores commands meant for another bot", async () => {
    const { sent, group } = harness();
    await group("/start@otherbot");
    expect(sent).toHaveLength(0);
    await group("/start@usetidebot");
    expect(sent.at(-1)).toContain("call me by name");
  });
});

describe("calling tide by name", () => {
  it("spots the name at the start or after a comma at the end", () => {
    expect(calledByName("hey tide")).toBe("");
    expect(calledByName("Hey Tide, top 5 on solana")).toBe("top 5 on solana");
    expect(calledByName("tide what's moving")).toBe("what's moving");
    expect(calledByName("oya tide check $WIF")).toBe("check $WIF");
    expect(calledByName("thoughts on $WIF, tide?")).toBe("thoughts on $WIF?");
  });

  it("ignores the word in normal chat", () => {
    expect(calledByName("the tide is turning")).toBeNull();
    expect(calledByName("riding the tide today")).toBeNull();
    expect(calledByName("tidepool app is cool")).toBeNull();
  });

  it("answers 'hey tide' in a group", async () => {
    const { sent, group } = harness();
    await group("hey tide");
    expect(sent).toHaveLength(1);
    await group("the tide is turning");
    expect(sent).toHaveLength(1);
  });
});

describe("welcome", () => {
  it("explains what tide does in plain words before asking for a wallet", async () => {
    const { sent, say } = harness();
    await say("/start");
    const msg = sent.at(-1)!;
    expect(msg).toBe(welcome("Pascal"));
    for (const bit of ["find tokens as they start moving", "red flags", "how much i'd risk", "remember why you bought", "low caps", "only send tokens under 100k mcap", "wallet address", "never ask for your keys"]) {
      expect(msg).toContain(bit);
    }
    expect(msg).not.toMatch(/[—–]|walrus|namespace/i);
  });
});
