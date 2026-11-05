import { startOfWeekLagos, trackRecordMultiplier } from "../core/sizing.js";
import type { TokenClass } from "../core/types.js";
import { pct, shortAddress, usd } from "../bot/format.js";
import type { Market } from "../market/gecko.js";
import type { Store } from "../memory/store.js";
import type { Memory } from "../memory/walrus.js";
import { cleanReply } from "./clean.js";
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

  async buildContext(userId: number, firstName: string | undefined, text: string): Promise<string> {
    const user = this.store.getUser(userId);
    const lines: string[] = [];
    lines.push(`Their first name: ${firstName ?? "unknown"}`);
    lines.push(`Today: ${new Date().toISOString().slice(0, 10)} (they're likely on Lagos time)`);

    if (!user?.wallet) {
      lines.push("They haven't shared a Sui wallet yet. To start, they paste their Sui address in this chat (read-only, no keys).");
    } else {
      lines.push(`Wallet: ${shortAddress(user.wallet)}`);
    }

    if (user?.budgetUsd != null) {
      const spent = this.store.spentSince(userId, startOfWeekLagos());
      lines.push(
        `Weekly trading budget: ${usd(user.budgetUsd)}. Spent since Monday: ${usd(spent)}. Left: ${usd(Math.max(0, user.budgetUsd - spent))}. Base share per alert: ${Math.round(user.baseShare * 100)}%.`,
      );
    } else if (user?.wallet) {
      lines.push("No weekly budget set yet (/budget).");
    }

    if (user) {
      lines.push(`Alerts: ${user.alertsOn ? "on" : "paused"}.`);
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
        lines.push(`- ${h.symbol}: bought ${h.boughtAt.slice(0, 10)} for ${usd(h.costUsd)}, ${move}${value}${reason}`);
      }
    } else if (user?.wallet) {
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
