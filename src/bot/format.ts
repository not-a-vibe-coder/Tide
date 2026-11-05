import { CHAIN_LABEL, GECKO_NETWORK, type Chain } from "../core/chains.js";
import type { Pool, RiskCheck, SizingResult, Spike } from "../core/types.js";
import type { Holding } from "../memory/store.js";

/** Stored as the reason when someone skips the "why did you buy" question. */
export const NO_REASON = "(no reason given)";

export const esc =(s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (abs >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs === 0) return "$0";
  return `$${n.toPrecision(3)}`;
}

export const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function alertMessage(spike: Spike, risk: RiskCheck, sizing: SizingResult | null, sharedNote: string | null): string {
  const p: Pool = spike.pool;
  const kind = spike.tokenClass === "new" ? "a brand-new pool" : "an established pool";
  const riskLine =
    risk.label === "lower"
      ? "risk looks lower than most, nothing jumped out at me."
      : `risk looks ${risk.label}${risk.flags.length ? `: ${esc(risk.flags.join(", "))}` : ""}.`;
  const lines = [
    spike.kind === "launch"
      ? `fresh launch on ${CHAIN_LABEL[p.chain]}: <b>${esc(p.baseSymbol)}</b>`
      : `<b>${esc(p.baseSymbol)}</b> just started moving on ${CHAIN_LABEL[p.chain]}`,
    `${esc(sentence(spike.reasons))}.`,
    "",
    `price ${usd(p.priceUsd)} · mcap ${usd(p.marketCapUsd ?? p.fdvUsd)} · liquidity ${usd(p.liquidityUsd)}`,
    `${usd(p.volumeUsd.h1)} traded in the last hour, ${kind} on ${esc(p.dex)}`,
    "",
    riskLine,
  ];
  if (spike.kind === "launch") lines.push("brand-new launches are the riskiest thing i send. most of them go to zero, so size like you'll lose it.");
  if (sharedNote) lines.push(esc(sharedNote));
  lines.push("");
  if (sizing && sizing.maxUsd > 0) {
    lines.push(
      `if you go in, i'd keep it under <b>${usd(sizing.maxUsd)}</b>. nfa.`,
      `<i>${usd(sizing.budgetLeftUsd)} left this week × ${Math.round(sizing.baseShare * 100)}% × track record ${sizing.trackRecord} × risk ${sizing.riskMultiplier}</i>`,
    );
  } else if (sizing) {
    lines.push("your budget for this week is already used up, so i'm not suggesting a size. nfa.");
  } else {
    lines.push("set a weekly budget with /budget and i'll tell you how much i'd risk on these. nfa.");
  }
  lines.push("", `<a href="https://www.geckoterminal.com/${GECKO_NETWORK[p.chain]}/pools/${encodeURIComponent(p.address)}">chart</a>`);
  return lines.join("\n");
}

/** "a", "a and b", "a, b and c" */
export function sentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export interface HoldingView {
  holding: Holding;
  priceUsd: number | null;
  volumeH24Usd: number | null;
}

export function holdingLine(v: HoldingView): string {
  const h = v.holding;
  let line = `<b>${esc(h.symbol)}</b> `;
  if (v.priceUsd !== null && h.entryPriceUsd) {
    const change = (v.priceUsd / h.entryPriceUsd - 1) * 100;
    line += `${pct(change)} since you bought, worth ${usd(v.priceUsd * h.units)} now`;
  } else if (v.priceUsd !== null) {
    line += `worth ${usd(v.priceUsd * h.units)} now (i missed your entry price)`;
  } else {
    line += "has no live price right now";
  }
  if (h.reason && h.reason !== NO_REASON) {
    line += `\nyou said: <i>${esc(h.reason)}</i>`;
    const check = thesisCheck(h, v.volumeH24Usd);
    if (check) line += `\n${esc(check)}`;
  } else {
    line += "\nyou never told me why you bought this one.";
  }
  return line;
}

/**
 * The thesis check compares live data with the reason the user gave.
 * Only volume is checked automatically; other reasons are shown back to the user.
 */
export function thesisCheck(h: Holding, volumeNow: number | null): string | null {
  if (!h.reason || volumeNow === null || !h.entryVolumeH24Usd) return null;
  if (!/vol|volume|activity|traction|momentum/i.test(h.reason)) return null;
  const change = (volumeNow / h.entryVolumeH24Usd - 1) * 100;
  if (change <= -30) return `heads up, volume is ${pct(change)} since then, so that reason might not hold anymore.`;
  if (change >= 30) return `volume is ${pct(change)} since then, so that reason still holds.`;
  return `volume is about the same as when you bought (${pct(change)}).`;
}

/** One chain's top tokens, for /top. */
export function topList(chain: Chain, pools: Pool[], fresh = false, now = Date.now()): string {
  const title = fresh ? `<b>launched on ${CHAIN_LABEL[chain]} in the last 24h, by volume</b>` : `<b>top on ${CHAIN_LABEL[chain]} by 24h volume</b>`;
  if (!pools.length) return `${title}\nnothing with real liquidity right now.`;
  const lines = pools.map((p, i) => {
    const cap = p.marketCapUsd !== null ? `mcap ${usd(p.marketCapUsd)}` : p.fdvUsd !== null ? `fdv ${usd(p.fdvUsd)}` : "no mcap";
    const age = p.createdAt ? ` · ${shortAge(now - p.createdAt.getTime())} old` : "";
    return `${i + 1}. <b>${esc(p.baseSymbol)}</b> ${usd(p.priceUsd)} (${pct(p.priceChangePct.h24)} 24h) · ${usd(p.volumeUsd.h24)} traded · ${cap}${age}`;
  });
  return [title, ...lines].join("\n");
}

function shortAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
