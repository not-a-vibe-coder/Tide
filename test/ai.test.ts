import { MemWalMock } from "@mysten-incubation/memwal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanReply, replaceDashPauses, toTelegramHtml } from "../src/ai/clean.js";
import { Companion } from "../src/ai/companion.js";
import { Llm, reasoningSettings } from "../src/ai/llm.js";
import { systemPrompt } from "../src/ai/persona.js";
import { normaliseCoinType } from "../src/core/buys.js";
import type { Market } from "../src/market/gecko.js";
import { Store } from "../src/memory/store.js";
import { Memory } from "../src/memory/walrus.js";
import { SCOOP } from "./fixtures.js";

describe("reply cleanup (same rules as Jasmine)", () => {
  it("replaces em and en dashes with commas", () => {
    expect(replaceDashPauses("i missed you — how was the trip")).toBe("i missed you, how was the trip");
    expect(replaceDashPauses("release v1 – latest")).toBe("release v1, latest");
  });

  it("replaces a spaced hyphen pause but keeps maths and words", () => {
    expect(replaceDashPauses("it pumped - then dumped")).toBe("it pumped, then dumped");
    expect(replaceDashPauses("5 - 3 is 2")).toBe("5 - 3 is 2");
    expect(replaceDashPauses("brand-new pool")).toBe("brand-new pool");
  });

  it("leaves code blocks alone", () => {
    expect(replaceDashPauses("run ```a — b``` now — ok")).toBe("run ```a — b``` now, ok");
  });

  it("strips thinking blocks and speaker labels", () => {
    expect(cleanReply("<think>they seem sad</think>\nTide: oof, that one stings")).toBe("oof, that one stings");
    expect(cleanReply("ok so <think>unfinished reasoning")).toBe("ok so");
  });

  it("escapes HTML but keeps simple bold, italic and code", () => {
    expect(toTelegramHtml("**SCOOP** is <up> 5% and `0x2`")).toBe("<b>SCOOP</b> is &lt;up&gt; 5% and <code>0x2</code>");
  });
});

describe("model chain", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off without keys", () => {
    expect(new Llm({}).enabled).toBe(false);
  });

  it("puts Groq before Gemini, like Jasmine", () => {
    const llm = new Llm({ groqKey: "g", geminiKey: "m" });
    expect(llm.providers.map((p) => p.name)).toEqual(["groq", "groq", "gemini", "gemini"]);
  });

  it("falls through to the next model when one fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hey pascal" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await new Llm({ groqKey: "g", geminiKey: "m" }).chat([{ role: "user", content: "hi" }]);
    expect(out).toBe("hey pascal");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.reasoning_format).toBe("hidden");
  });

  it("hides reasoning per provider", () => {
    expect(reasoningSettings({ name: "groq", url: "", key: "", model: "openai/gpt-oss-20b" })).toEqual({
      reasoning_effort: "low",
      include_reasoning: false,
    });
    expect(reasoningSettings({ name: "gemini", url: "", key: "", model: "gemini-3.5-flash-lite" })).toEqual({ reasoning_effort: "low" });
  });
});

describe("persona", () => {
  it("carries Jasmine's voice rules and Tide's money rules", () => {
    const p = systemPrompt("jack (@jackdotsol)", "CTX");
    expect(p).toContain("made by jack (@jackdotsol)");
    expect(p).toContain("lowercase");
    expect(p).toContain("NO em dashes");
    expect(p).toContain("pidgin");
    expect(p).toContain("never tell anyone to buy or sell");
    expect(p).toContain("Never invent a price");
    expect(p.endsWith("CTX")).toBe(true);
  });
});

describe("companion", () => {
  function setup(reply: string | null) {
    const store = new Store(":memory:");
    const memory = new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client: MemWalMock.create() as never });
    const market = { quote: async () => ({ priceUsd: 0.012, volumeH24Usd: 50_000, liquidityUsd: 80_000 }) } as unknown as Market;
    const sizer = { sizingFor: (_u: unknown, _c: unknown, r: number) => ({ maxUsd: 10 * r }) };
    const llm = new Llm({ groqKey: "k" });
    const seen: string[] = [];
    llm.chat = async (messages) => {
      seen.push(messages[0]!.content);
      return reply;
    };
    return { store, memory, companion: new Companion(llm, store, memory, market, sizer, "jack"), seen };
  }

  it("gives the model the person's real numbers and the reason they bought", async () => {
    const { store, memory, companion, seen } = setup("scoop is up 20%, and volume still looks alive — nfa");
    memory.record(1, { type: "profile_set", chatId: 1, wallet: "0x" + "1".repeat(64), budgetUsd: 30 });
    memory.record(1, {
      type: "buy_detected",
      holdingId: "h1",
      coinType: normaliseCoinType(SCOOP),
      symbol: "SCOOP",
      units: 500,
      costUsd: 5,
      priceUsd: 0.01,
      volumeH24Usd: 40_000,
    });
    memory.record(1, { type: "buy_reason", holdingId: "h1", symbol: "SCOOP", reason: "dex volume rising" });
    await memory.flush();

    const out = await companion.reply(1, "Pascal", "how's scoop doing?");
    expect(out).toBe("scoop is up 20%, and volume still looks alive, nfa");
    const ctx = seen[0]!;
    expect(ctx).toContain("Their first name: Pascal");
    expect(ctx).toContain("Weekly trading budget: $30");
    expect(ctx).toContain("SCOOP: bought");
    expect(ctx).toContain("+20.0% since their buy");
    expect(ctx).toContain('they bought because "dex volume rising"');
    expect(ctx).toContain("Max size right now: $10 on a lower-risk one, $2.5 on a high-risk one");
    expect(ctx).toContain("Memories from Walrus");
  });

  it("keeps a short chat history", async () => {
    const { companion } = setup("ok");
    for (let i = 0; i < 10; i++) await companion.reply(1, undefined, `msg ${i}`);
    expect((companion as any).history.get(1)).toHaveLength(12);
  });

  it("returns null when no model answers, so the bot can fall back", async () => {
    const { companion } = setup(null);
    expect(await companion.reply(1, undefined, "hi")).toBeNull();
  });
});
