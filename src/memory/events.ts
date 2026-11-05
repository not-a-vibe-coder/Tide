import { randomUUID } from "node:crypto";
import type { TokenClass } from "../core/types.js";

/**
 * Every change to Tide's state is an event. Events are applied to the local
 * cache and written to Walrus Memory. Walrus Memory is append-only, so the
 * latest event wins, and the cache can be rebuilt by replaying events.
 */
export type EventData =
  | {
      type: "profile_set";
      chatId?: number;
      /** Sui wallet. */
      wallet?: string;
      solWallet?: string;
      budgetUsd?: number;
      baseShare?: number;
      alertsOn?: boolean;
    }
  | {
      type: "buy_detected";
      holdingId: string;
      coinType: string;
      symbol: string;
      units: number;
      costUsd: number | null;
      priceUsd: number | null;
      volumeH24Usd: number | null;
    }
  | { type: "buy_reason"; holdingId: string; symbol: string; reason: string }
  | { type: "position_closed"; holdingId: string; symbol: string; priceUsd: number | null; pnlPct: number | null }
  | {
      type: "alert_sent";
      alertId: string;
      poolAddress: string;
      coinType: string;
      symbol: string;
      tokenClass: TokenClass;
      priceUsd: number;
      marketCapUsd: number | null;
      sizeUsd: number | null;
      risk: number;
      trackRecord: number;
      reasons: string[];
      /** "launch" for a fresh-launch alert. Older events have no kind and count as spikes. */
      kind?: "spike" | "launch";
    }
  | { type: "alert_action"; alertId: string; symbol: string; action: "bought" | "skipped" | "not_for_me" }
  | { type: "alert_outcome"; alertId: string; symbol: string; tokenClass: TokenClass; changePct: number }
  | { type: "preference"; key: string; value: string }
  | {
      type: "token_outcome";
      coinType: string;
      symbol: string;
      tokenClass: TokenClass;
      changePct: number;
      /** "history" = replayed from past candles; otherwise a live alert's outcome. */
      source?: "live" | "history";
      /** When the signal fired, for history outcomes. */
      signalAt?: string;
      kind?: "spike" | "launch";
    };

export type EventType = EventData["type"];

export const EVENT_TYPES: EventType[] = [
  "profile_set",
  "buy_detected",
  "buy_reason",
  "position_closed",
  "alert_sent",
  "alert_action",
  "alert_outcome",
  "preference",
  "token_outcome",
];

export interface TideEvent {
  id: string;
  /** Telegram user id, or null for shared token-level events. */
  userId: number | null;
  at: string;
  data: EventData;
}

export const SHARED_NAMESPACE = "tide-tokens";
export const userNamespace = (userId: number) => `tide-user-${userId}`;
export const namespaceFor = (e: Pick<TideEvent, "userId">) =>
  e.userId === null ? SHARED_NAMESPACE : userNamespace(e.userId);

export function newEvent(userId: number | null, data: EventData, at: Date = new Date(), id: string = randomUUID()): TideEvent {
  return { id, userId, at: at.toISOString(), data };
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "unknown" : `$${n < 1 ? n.toPrecision(3) : n.toFixed(2)}`;

/** One readable sentence, so recall's similarity search has words to match on. */
export function describe(e: TideEvent): string {
  const d = e.data;
  const who = e.userId === null ? "Tide" : `User ${e.userId}`;
  switch (d.type) {
    case "profile_set": {
      const parts: string[] = [];
      if (d.wallet) parts.push(`sui wallet ${d.wallet}`);
      if (d.solWallet) parts.push(`solana wallet ${d.solWallet}`);
      if (d.budgetUsd !== undefined) parts.push(`weekly budget ${usd(d.budgetUsd)}`);
      if (d.baseShare !== undefined) parts.push(`base share ${Math.round(d.baseShare * 100)}%`);
      if (d.alertsOn !== undefined) parts.push(`alerts ${d.alertsOn ? "on" : "off"}`);
      return `${who} profile: ${parts.join(", ") || "started the bot"}`;
    }
    case "buy_detected":
      return `${who} bought ${d.units} ${d.symbol} for about ${usd(d.costUsd)} at ${usd(d.priceUsd)}`;
    case "buy_reason":
      return `${who} bought ${d.symbol} because: ${d.reason}`;
    case "position_closed":
      return `${who} closed ${d.symbol}${d.pnlPct === null ? "" : ` at ${d.pnlPct.toFixed(1)}%`}`;
    case "alert_sent":
      return `${d.kind === "launch" ? "Launch alert" : "Alert"} to ${who} on ${d.symbol} (${d.tokenClass} token): ${d.reasons.join("; ")}. Risk ${d.risk}, suggested max ${usd(d.sizeUsd)}`;
    case "alert_action":
      return `${who} ${d.action.replace(/_/g, " ")} the ${d.symbol} alert`;
    case "alert_outcome":
      return `${d.symbol} (${d.tokenClass} token) was ${d.changePct.toFixed(1)}% 24h after the alert to ${who}`;
    case "preference":
      return `${who} preference ${d.key} = ${d.value}`;
    case "token_outcome":
      return d.source === "history"
        ? `Market history: ${d.symbol} (${d.tokenClass} token) moved ${d.changePct.toFixed(1)}% in the 24h after a ${d.kind ?? "spike"} signal at ${d.signalAt ?? "unknown time"}`
        : `${d.symbol} (${d.tokenClass} token) moved ${d.changePct.toFixed(1)}% in the 24h after a spike alert`;
  }
}

const SEP = " ⟨tide⟩ ";

export function encodeEvent(e: TideEvent): string {
  return `[tide:${e.data.type}] ${describe(e)}${SEP}${JSON.stringify(e)}`;
}

export function decodeEvent(text: string): TideEvent | null {
  const i = text.lastIndexOf(SEP);
  if (i < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(i + SEP.length)) as TideEvent;
    if (!parsed.id || !parsed.data?.type || !EVENT_TYPES.includes(parsed.data.type)) return null;
    return parsed;
  } catch {
    return null;
  }
}
