import { CHAIN_LABEL, parseSolanaAddress } from "../core/chains.js";
import { assessRisk, classifyToken, detectSpike } from "../core/spike.js";
import type { Pool } from "../core/types.js";
import { pct, usd } from "../bot/format.js";

export type Mention = { kind: "token"; token: string; label: string } | { kind: "query"; query: string };

const SUI_TYPE = /0x[0-9a-fA-F]{1,64}::\w+::\w+/g;
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const DOLLAR = /\$([A-Za-z][A-Za-z0-9]{1,14})\b/g;
/** "should i buy pepe", "thoughts on wif", "is scoop a rug" */
const VERB_TICKER =
  /\b(?:buy|buying|ape|aping|sell|selling|about|into|on|check|rate|think of|thoughts on|is|bag|hold|holding)\s+\$?([A-Za-z][A-Za-z0-9]{1,14})\b/gi;

/** Words that follow those verbs but aren't tickers. */
const NOT_TICKERS = new Set(
  (
    "a an the it this that these those my your our more some any now today tomorrow here there what which who how why when " +
    "me you him her them us i we they all one two dip top bottom chain market sui solana sol token tokens coin coins memes meme " +
    "something anything everything nothing time money budget wallet track trading trade trades risk fire hand board right next " +
    "just also really still even only maybe probably good bad high low new old up down out off in over well fine strong"
  ).split(" "),
);

/**
 * Finds the tokens a message talks about: pasted Sui coin types and Solana
 * mints, $TICKERS, tickers after words like "buy" or "thoughts on", and the
 * symbols of tokens Tide already knows this person holds or was alerted on.
 */
export function extractMentions(text: string, known: { symbol: string; token: string }[] = [], max = 2): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (m: Mention) => {
    const key = m.kind === "token" ? m.token : m.query.toUpperCase();
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(m);
  };

  for (const m of text.match(SUI_TYPE) ?? []) add({ kind: "token", token: m, label: m.split("::").at(-1)! });
  for (const m of text.match(BASE58) ?? []) if (parseSolanaAddress(m)) add({ kind: "token", token: m, label: `${m.slice(0, 4)}…` });

  for (const k of known) {
    if (k.symbol.length < 3) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9$])\\$?${escapeRe(k.symbol)}(?![A-Za-z0-9])`, "i");
    if (re.test(text)) add({ kind: "token", token: k.token, label: k.symbol });
  }

  for (const m of text.matchAll(DOLLAR)) add({ kind: "query", query: m[1]! });
  for (const m of text.matchAll(VERB_TICKER)) {
    const word = m[1]!;
    if (!NOT_TICKERS.has(word.toLowerCase()) && !known.some((k) => k.symbol.toLowerCase() === word.toLowerCase())) {
      add({ kind: "query", query: word });
    }
  }
  return out;
}

/** Best pool for a ticker search: exact symbol matches first, then the most liquid. */
export function pickPool(query: string, pools: Pool[]): { best: Pool | null; others: number } {
  const exact = pools.filter((p) => p.baseSymbol.toUpperCase() === query.toUpperCase());
  const ranked = (exact.length ? exact : pools).slice().sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const best = ranked[0] ?? null;
  const others = best ? new Set(exact.filter((p) => p.baseCoinType !== best.baseCoinType).map((p) => p.baseCoinType)).size : 0;
  return { best, others };
}

/** The facts the model gets about one token. Every number here is real. */
export function describeToken(p: Pool, extra: string[] = [], now = new Date()): string {
  const risk = assessRisk(p, now);
  const spike = detectSpike(p, undefined, now);
  const cls = classifyToken(p, now);
  const ageDays = p.createdAt ? Math.floor((now.getTime() - p.createdAt.getTime()) / 86_400_000) : null;
  const lines = [
    `${p.baseSymbol} on ${CHAIN_LABEL[p.chain]} (${p.dex}, pool ${p.name}, token ${p.baseCoinType})`,
    `  price ${usd(p.priceUsd)}, market cap ${usd(p.marketCapUsd)}, fdv ${usd(p.fdvUsd)}, liquidity ${usd(p.liquidityUsd)}`,
    `  volume ${usd(p.volumeUsd.h1)} last hour, ${usd(p.volumeUsd.h24)} last 24h`,
    `  price change ${pct(p.priceChangePct.h1)} 1h, ${pct(p.priceChangePct.h6)} 6h, ${pct(p.priceChangePct.h24)} 24h`,
    `  last hour ${p.txH1.buys} buys vs ${p.txH1.sells} sells`,
    `  pool age ${ageDays === null ? "unknown" : `${ageDays} days`}, so it counts as ${cls === "new" ? "a brand-new pool" : "established"}`,
    `  my risk check: ${risk.label} risk, multiplier ${risk.multiplier}${risk.flags.length ? `, red flags: ${risk.flags.join("; ")}` : ", no red flags from liquidity, age or sell pressure"}`,
    `  spiking right now: ${spike ? spike.reasons.join(" and ") : "no"}`,
    ...extra.map((e) => `  ${e}`),
  ];
  return lines.join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
