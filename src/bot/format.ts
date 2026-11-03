import type { Pool, RiskCheck, SizingResult, Spike } from "../core/types.js";
import type { Holding } from "../memory/store.js";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  const lines = [
    `<b>${esc(p.baseSymbol)}</b> is moving on Sui`,
    ...spike.reasons.map((r) => `• ${esc(r)}`),
    "",
    `Price ${usd(p.priceUsd)} · Mcap ${usd(p.marketCapUsd ?? p.fdvUsd)} · Liquidity ${usd(p.liquidityUsd)}`,
    `1h volume ${usd(p.volumeUsd.h1)} · ${spike.tokenClass === "new" ? "new pool" : "established pool"} on ${esc(p.dex)}`,
    "",
    `<b>Risk: ${risk.label}</b>${risk.flags.length ? ` (${esc(risk.flags.join(", "))})` : ""}`,
  ];
  if (sharedNote) lines.push(esc(sharedNote));
  lines.push("");
  if (sizing && sizing.maxUsd > 0) {
    lines.push(
      `If you go in, keep it under <b>${usd(sizing.maxUsd)}</b>. NFA.`,
      `<i>${usd(sizing.budgetLeftUsd)} left this week × ${Math.round(sizing.baseShare * 100)}% × track record ${sizing.trackRecord} × risk ${sizing.riskMultiplier}</i>`,
    );
  } else if (sizing) {
    lines.push("Your weekly budget is used up, so no size this time. NFA.");
  } else {
    lines.push("Set a budget with /budget to get a suggested size. NFA.");
  }
  lines.push("", `<a href="https://www.geckoterminal.com/sui-network/pools/${encodeURIComponent(p.address)}">Chart</a>`);
  return lines.join("\n");
}

export interface HoldingView {
  holding: Holding;
  priceUsd: number | null;
  volumeH24Usd: number | null;
}

export function holdingLine(v: HoldingView): string {
  const h = v.holding;
  const parts = [`<b>${esc(h.symbol)}</b>`];
  if (v.priceUsd !== null && h.entryPriceUsd) {
    const change = (v.priceUsd / h.entryPriceUsd - 1) * 100;
    const value = v.priceUsd * h.units;
    parts.push(`${pct(change)} since your buy · now ${usd(value)}`);
  } else if (v.priceUsd !== null) {
    parts.push(`worth ${usd(v.priceUsd * h.units)} (no entry price)`);
  } else {
    parts.push("no live price");
  }
  let line = parts.join(" ");
  if (h.reason) {
    line += `\n  You bought because: <i>${esc(h.reason)}</i>`;
    const check = thesisCheck(h, v.volumeH24Usd);
    if (check) line += `\n  ${esc(check)}`;
  } else {
    line += "\n  No reason saved yet.";
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
  if (change <= -30) return `Heads up: 24h volume is ${pct(change)} since you bought, so that reason may no longer hold.`;
  if (change >= 30) return `24h volume is ${pct(change)} since you bought, so the reason still holds.`;
  return `24h volume is roughly flat (${pct(change)}) since you bought.`;
}
