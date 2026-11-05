import { CHAIN_LABEL, chainOf } from "../core/chains.js";
import { assessRisk, classifyToken } from "../core/spike.js";
import { startOfWeekLagos, trackRecordMultiplier } from "../core/sizing.js";
import type { TokenClass } from "../core/types.js";
import { pct, shortAddress, usd } from "../bot/format.js";
import type { Market } from "../market/gecko.js";
import type { Store } from "../memory/store.js";
import type { Memory } from "../memory/walrus.js";
import { cleanReply } from "./clean.js";
import { describeToken, extractMentions, pickPool } from "./lookup.js";
import type { ChatMessage, Llm } from "./llm.js";
import { systemPrompt } from "./persona.js";

const HISTORY_TURNS = 12;

export interface Sizer {
  sizingFor(user: NonNullable<ReturnType<Store["getUser"]>>, tokenClass: TokenClass, riskMultiplier: number): { maxUsd: number } | null;
}

/**
 * Free-text chat in Jasmine's voice. The model sees only facts Tide has
 * computed or remembered, so every number it can quote is real.
 */
export class Companion {
  private readonly history = new Map<number, ChatMessage[]>();

  constructor(
    private readonly llm: Llm,
    private readonly store: Store,
    private readonly memory: Memory,
    private readonly market: Market,
    private readonly sizer: Sizer,
    private readonly creator: string,
  ) {}

  get enabled(): boolean {
    return this.llm.enabled;
  }

  /** A tiny real call through the model chain, for /doctor. */
  async ping(): Promise<string> {
    if (!this.llm.enabled) throw new Error("off, set GROQ_API_KEY and/or GEMINI_API_KEY");
    const out = await this.llm.chat([{ role: "user", content: "reply with exactly: ok" }], 20);
    if (!out) throw new Error(`no model answered (${this.llm.providers.map((p) => p.model).join(", ")}), check the logs`);
    return `answering through ${this.llm.providers.map((p) => p.name).filter((n, i, a) => a.indexOf(n) === i).join(" → ")}`;
  }

  /** Reply to a message, or null if no model answered (caller falls back to a template). */
  async reply(userId: number, firstName: string | undefined, text: string): Promise<string | null> {
    if (!this.llm.enabled) return null;
    const context = await this.buildContext(userId, firstName, text);
    const past = this.history.get(userId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(this.creator, context) },
      ...past,
      { role: "user", content: text },
    ];
    const raw = await this.llm.chat(messages);
    if (!raw) return null;
    const reply = cleanReply(raw);
    if (!reply) return null;
    this.remember(userId, text, reply);
    return reply;
  }

  private remember(userId: number, text: string, reply: string) {
    const h = this.history.get(userId) ?? [];
    h.push({ role: "user", content: text }, { role: "assistant", content: reply });
    this.history.set(userId, h.slice(-HISTORY_TURNS));
  }

  /** Looks up tokens the message names and returns the facts, or what couldn't be found. */
  async tokenLookups(userId: number, text: string): Promise<string[]> {
    const known = [
      ...this.store.openHoldings(userId).map((h) => ({ symbol: h.symbol, token: h.coinType })),
      ...this.store.recentAlerts(userId, 10).map((a) => ({ symbol: a.symbol, token: a.coinType })),
    ];
    const mentions = extractMentions(text, known);
    if (!mentions.length) return [];
    const user = this.store.getUser(userId);
    const out: string[] = ["Token lookups for what they asked about (live from geckoterminal):"];
    for (const m of mentions) {
      try {
        let pool, others = 0;
        if (m.kind === "token") {
          pool = (await this.market.tokenPools(m.token))[0] ?? null;
        } else {
          ({ best: pool, others } = pickPool(m.query, await this.market.search(m.query)));
        }
        if (!pool) {
          out.push(`- I looked for "${m.kind === "token" ? m.label : m.query}" on sui and solana and found no trading pool. Say so, don't guess.`);
          continue;
        }
        const cls = classifyToken(pool);
        const extra: string[] = [];
        if (others > 0) extra.push(`${others} other token(s) also use the ticker ${pool.baseSymbol}; this is the most liquid one, mention that in case they meant another`);
        const held = this.store.openHoldings(userId).find((h) => h.coinType === pool.baseCoinType);
        if (held) extra.push(`they hold this, bought ${held.boughtAt.slice(0, 10)}${held.reason ? ` because "${held.reason}"` : ""}`);
        const shared = this.store.sharedWinRate(cls);
        if (shared.total >= 3) extra.push(`across all tide users, ${classLabel(cls)} were up 24h after ${shared.wins} of ${shared.total} alerts`);
        const outcomes = this.store.outcomes(userId, cls);
        if (outcomes.length) extra.push(`their own record on ${classLabel(cls)}: ${outcomes.slice(-10).filter(Boolean).length} of the last ${Math.min(10, outcomes.length)} up after 24h`);
        if (user) {
          const size = this.sizer.sizingFor(user, cls, assessRisk(pool).multiplier);
          extra.push(size ? `their max size on this one by their own rules: ${usd(size.maxUsd)} (nfa)` : "they have no budget set, so no size");
        }
        out.push(describeToken(pool, extra));
      } catch {
        out.push(`- The lookup for "${m.kind === "token" ? m.label : m.query}" failed (market data busy). Say you couldn't check it right now.`);
      }
    }
    return out;
  }

  async buildContext(userId: number, firstName: string | undefined, text: string): Promise<string> {
    const user = this.store.getUser(userId);
    const lines: string[] = [];
    lines.push(`Their first name: ${firstName ?? "unknown"}`);
    lines.push(`Today: ${new Date().toISOString().slice(0, 10)} (they're likely on Lagos time)`);

    if (!user?.wallet && !user?.solWallet) {
      lines.push("They haven't shared a wallet yet. To start, they paste a Sui or Solana address in this chat (read-only, no keys).");
    } else {
      if (user.wallet) lines.push(`Sui wallet: ${shortAddress(user.wallet)}`);
      if (user.solWallet) lines.push(`Solana wallet: ${shortAddress(user.solWallet)}`);
    }

    if (user?.budgetUsd != null) {
      const spent = this.store.spentSince(userId, startOfWeekLagos());
      lines.push(
        `Weekly trading budget: ${usd(user.budgetUsd)}. Spent since Monday: ${usd(spent)}. Left: ${usd(Math.max(0, user.budgetUsd - spent))}. Base share per alert: ${Math.round(user.baseShare * 100)}%.`,
      );
    } else if (user?.wallet || user?.solWallet) {
      lines.push("No weekly budget set yet (/budget).");
    }

    if (user) {
      lines.push(`Alerts: ${user.alertsOn ? "on" : "paused"}. Fresh launch alerts: ${this.store.getPref(userId, "launches") === "true" ? "on" : "off (/launches on)"}.`);
      const chainsMuted = (["sui", "solana"] as const).filter((c) => this.store.getPref(userId, `mute_chain_${c}`) === "true");
      if (chainsMuted.length) lines.push(`They don't get alerts for: ${chainsMuted.join(", ")}.`);
      const muted = (["new", "established"] as const).filter((c) => this.store.getPref(userId, `mute_${c}`) === "true");
      if (muted.length) lines.push(`They muted alerts for: ${muted.map(classLabel).join(", ")}.`);

      for (const cls of ["new", "established"] as const) {
        const outcomes = this.store.outcomes(userId, cls);
        const h = trackRecordMultiplier(outcomes);
        const wins = outcomes.slice(-10).filter(Boolean).length;
        const recent = Math.min(outcomes.length, 10);
        const record = outcomes.length ? `${wins} of the last ${recent} were up 24h later` : "no resolved alerts yet";
        const lower = this.sizer.sizingFor(user, cls, 1);
        const risky = this.sizer.sizingFor(user, cls, 0.25);
        const sizes = lower && risky ? ` Max size right now: ${usd(lower.maxUsd)} on a lower-risk one, ${usd(risky.maxUsd)} on a high-risk one.` : "";
        lines.push(`Track record on ${classLabel(cls)}: ${record}, multiplier ${h}.${sizes}`);
      }
    }

    const holdings = this.store.openHoldings(userId);
    if (holdings.length) {
      lines.push("Open positions:");
      for (const h of holdings.slice(0, 8)) {
        const q = await this.market.quote(h.coinType).catch(() => null);
        const move = q && h.entryPriceUsd ? `${pct((q.priceUsd / h.entryPriceUsd - 1) * 100)} since their buy` : "no live price";
        const value = q ? `, now worth ${usd(q.priceUsd * h.units)}` : "";
        const reason = h.reason ? `, they bought because "${h.reason}"` : ", no reason given yet";
        lines.push(`- ${h.symbol} on ${CHAIN_LABEL[chainOf(h.coinType)]}: bought ${h.boughtAt.slice(0, 10)} for ${usd(h.costUsd)}, ${move}${value}${reason}`);
      }
    } else if (user?.wallet || user?.solWallet) {
      lines.push("No open positions tracked.");
    }

    const alerts = this.store.recentAlerts(userId, 5);
    if (alerts.length) {
      lines.push("Recent alerts I sent them:");
      for (const a of alerts) {
        const did = a.action ? a.action.replace(/_/g, " ") : "no response";
        const outcome = a.changePct === null ? "outcome pending" : `${pct(a.changePct)} after 24h`;
        lines.push(`- ${a.symbol} (${classLabel(a.tokenClass)}) on ${a.sentAt.slice(0, 10)}, suggested max ${usd(a.sizeUsd)}, they ${did}, ${outcome}`);
      }
    }

    for (const cls of ["new", "established"] as const) {
      const s = this.store.sharedWinRate(cls);
      if (s.total >= 3) lines.push(`Across all Tide users, ${classLabel(cls)} were up 24h after ${s.wins} of ${s.total} alerts.`);
    }

    lines.push(...(await this.tokenLookups(userId, text)));

    const recalled = await this.memory.recallFor(userId, text).catch(() => []);
    if (recalled.length) {
      lines.push("Memories from Walrus related to what they just said:");
      for (const m of recalled) lines.push(`- ${m}`);
    }
    return lines.join("\n");
  }
}

function classLabel(c: TokenClass): string {
  return c === "new" ? "brand-new pools (under 7 days)" : "established tokens";
}
