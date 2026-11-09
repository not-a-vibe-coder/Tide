import type { Chain } from "../core/chains.js";

/**
 * Things people ask Tide to do in plain words instead of slash commands.
 * Only clear requests to change a setting or run an action are caught here;
 * everything else goes to the AI chat.
 */
export type Intent =
  | { action: "launches"; on: boolean }
  | { action: "alerts"; on: boolean }
  | { action: "alertChains"; chains: Chain[] }
  | { action: "unmute" }
  | { action: "budget"; amount: number }
  | { action: "share"; percent: number }
  | { action: "holdings" }
  | { action: "check" }
  | { action: "scan" }
  | { action: "top"; chains?: Chain[] }
  | { action: "memory" }
  | { action: "help" }
  /** undefined = leave that side as it is, null = remove the limit. */
  | { action: "mcap"; min?: number | null; max?: number | null }
  | { action: "pump"; pct: number | null }
  | { action: "lowCaps"; chains?: Chain[]; maxCap?: number }
  | { action: "chainVolume"; chains?: Chain[] };

const ON = /\b(turn|switch|put|flip)\b[\w\s]{0,24}?\bon\b|\bback\s+on\b|\b(enable|activate|start|resume|unpause|unmute)\b|\bon\s+am\b|\b(alert|notify|ping|tell|let)\s+me\b|\bi\s+(want|need)\b|\bsend\s+me\b|\bkeep\s+me\s+posted\b|\bbring\s+back\b/i;
const OFF = /\b(turn|switch|put|flip)\b[\w\s]{0,24}?\boff\b|\b(disable|deactivate|stop|pause|mute|silence|quiet|shut)\b|\boff\s+am\b|\bno\s+more\b|\bdon'?t\s+(send|alert|ping|notify)\b|\bleave\s+me\s+alone\b|\btoo\s+many\b|\benough\b/i;

const LAUNCH = /\b(launch(es|ed|ing)?|new\s+tokens?|new\s+coins?|fresh\s+(tokens?|coins?|launch(es)?|pools?)|just\s+launched|new\s+listings?|brand[\s-]new\s+(tokens?|coins?))\b/i;
const ALERTS = /\b(alerts?|notifications?|pings?|messages?|updates?)\b/i;

/** A number of dollars in the message: "$50", "50 dollars", "50 usd", "50k". */
function dollars(text: string): number | null {
  const m = text.match(/\$\s*(\d+(?:[.,]\d+)?)\s*(k)?|(\d+(?:[.,]\d+)?)\s*(k)?\s*(?:\$|usd|dollars?|bucks)?/i);
  if (!m) return null;
  const n = Number((m[1] ?? m[3] ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return (m[2] ?? m[4]) ? n * 1000 : n;
}

/** Every amount in the message, with k/m suffixes: "20k-150k" → [20000, 150000]. */
export function amounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$?\s*(\d+(?:[.,]\d+)?)\s*(k|m|mil|million|thousand)?\b/gi)) {
    let n = Number(m[1]!.replace(",", "."));
    const u = (m[2] ?? "").toLowerCase();
    if (u === "k" || u === "thousand") n *= 1_000;
    else if (u) n *= 1_000_000;
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

const MCAP = /\bm(arket)?\s?caps?\b|\bmc\b/i;
const LOWCAPS = /\b(low|small|tiny|micro|lower)[\s-]?(caps?|mcaps?|market\s?caps?)\b|\bgems?\b/i;

function chainsIn(text: string): Chain[] {
  const out: Chain[] = [];
  if (/\bsui\b/i.test(text)) out.push("sui");
  if (/\b(solana|sol)\b/i.test(text)) out.push("solana");
  if (/\bboth\b|\ball\s+chains\b|\bevery\s+chain\b/i.test(text)) return ["sui", "solana"];
  return out;
}

export function parseIntent(raw: string): Intent | null {
  const text = raw.trim();
  if (!text || text.length > 200) return null;
  const t = text.toLowerCase();

  // Whole-chain volume: "how much volume is on solana", "sui volume today", "dex volume on both chains"
  if (/\bvolumes?\b/.test(t) && !/\$[a-z]|\btop\b|\btrending\b|\bleading\b/.test(t)) {
    const ch = chainsIn(t);
    if (ch.length || /\b(chains?|network|dex(es)?|overall|whole market|total market)\b/.test(t)) return { action: "chainVolume", chains: ch.length ? ch : undefined };
  }

  // Find small caps now: "find me low caps on solana under 50k", "any gems on sui?", "show me small caps"
  if (LOWCAPS.test(t) && !/\b(only send|alerts?|from now on)\b/.test(t)) {
    const ch = chainsIn(t);
    const cap = amounts(t.replace(/\b(top\s+)?\d+\s+(tokens?|coins?|of them)\b/g, "")).find((n) => n >= 1_000);
    return { action: "lowCaps", chains: ch.length ? ch : undefined, maxCap: cap };
  }

  // Market cap limits for alerts: "only send me tokens under 100k mcap", "mcap between 20k and 150k", "any market cap"
  // "only send tokens under 100k" means a market cap limit even without the word mcap.
  const capWithoutWord = /\b(only|just)\b.*\b(tokens?|coins?|ones?)\b.*\b(under|below|less than|over|above|between)\s+\$?\d/.test(t) && !/%|\b(budget|liquidity|volume)\b/.test(t);
  if (MCAP.test(t) || capWithoutWord) {
    if (/\b(any|no|remove|clear|reset|drop)\b.*\b(m(arket)?\s?cap|mc)\b.*\b(limit|filter|range)?|\b(m(arket)?\s?cap|mc)\b.*\b(off|limit off|any)\b/.test(t) && !/\d/.test(t)) {
      return { action: "mcap", min: null, max: null };
    }
    const n = amounts(t);
    if (n.length >= 2 && /\b(between|from|to|and)\b|\d\s*k?\s*[-–]\s*\$?\d/.test(t)) {
      const [lo, hi] = [Math.min(n[0]!, n[1]!), Math.max(n[0]!, n[1]!)];
      return { action: "mcap", min: lo, max: hi };
    }
    if (n.length === 1 && /\b(nothing|none|no|not)\s+(above|over|bigger|higher|more)\b/.test(t)) return { action: "mcap", max: n[0]!, min: null };
    if (n.length === 1 && /\b(over|above|more than|min(imum)?|at least|bigger than|higher than)\b|>/.test(t)) return { action: "mcap", min: n[0]! };
    if (n.length === 1 && /\b(under|below|less than|max(imum)?|at most|up to|lower than|cheaper than|not more than|only)\b|</.test(t)) return { action: "mcap", max: n[0]!, min: null };
  }

  // Skip tokens that already ran: "skip tokens already up 200%", "don't send pumped tokens", "allow pumped coins"
  if (/\b(pump(ed|s)?|already (up|ran|run|mooned)|ran already|mooned)\b/.test(t) && !/\$[a-z]/.test(t)) {
    const negated = /\b(skip|filter|no|don'?t|avoid|stop|hide|ignore|cut)\b/.test(t) && !/\b(off|remove|disable|turn off)\b/.test(t);
    if (!negated && /\b(allow|let|include|show|send)\b.*\bpump|\bpump(ed)?\b.*\b(filter|limit|check)\s+off\b|\b(remove|turn off|disable)\b.*\bpump/.test(t)) return { action: "pump", pct: null };
    const p = t.match(/(\d{2,5})\s*(%|percent)/);
    if (p) return { action: "pump", pct: Number(p[1]) };
    if (/\b(skip|filter|no|don'?t|avoid|stop|hide|ignore|cut)\b/.test(t)) return { action: "pump", pct: 100 };
  }

  // Launch alerts: "turn on launch alerts", "alert me when new tokens launch", "stop the launch pings", "abeg on am for new tokens"
  if (LAUNCH.test(t) && (ON.test(t) || OFF.test(t) || /\blaunch(es)?\s+(alerts?\s+)?(on|off)\b/.test(t))) {
    const off = OFF.test(t) || /\blaunch(es)?\s+(alerts?\s+)?off\b/.test(t);
    // "can you alert me when a new token launches?" is a request to turn them on.
    return { action: "launches", on: !off };
  }

  // Which chains: "only solana alerts", "just sui", "alerts for both chains", "stop sui alerts"
  const chains = chainsIn(t);
  if (chains.length && (ALERTS.test(t) || /\b(only|just)\b/.test(t)) && !/\b(top|trending|leading|price|buy|sell|scan)\b/.test(t)) {
    if (/\b(only|just)\b/.test(t) || /\bboth\b|\ball\s+chains\b/.test(t)) return { action: "alertChains", chains };
    if (OFF.test(t) && chains.length === 1) return { action: "alertChains", chains: chains[0] === "sui" ? ["solana"] : ["sui"] };
  }

  // Unmute token types: "unmute everything", "reset my alerts", "show me new pools again"
  if (/\b(unmute|reset)\b.*\b(alerts?|everything|all|tokens?|pools?)\b|\bshow me (new pools|established tokens) again\b/.test(t)) return { action: "unmute" };

  // All alerts on or off: "pause alerts", "stop alerting me", "leave me alone", "turn alerts back on"
  if ((ALERTS.test(t) || /\balerting\b|\bpinging\b|\bleave me alone\b/.test(t)) && !LAUNCH.test(t)) {
    if (OFF.test(t)) return { action: "alerts", on: false };
    if (ON.test(t) && /\b(back\s+on|turn|switch|enable|resume|unpause|start)\b/.test(t)) return { action: "alerts", on: true };
  }

  // Budget: "set my budget to $50", "my weekly budget is 40", "change budget to 100 dollars", "budget 30"
  if (/\bbudget\b/.test(t) && !/\?\s*$/.test(t) && !/\b(what|how much|left|remaining)\b/.test(t)) {
    const n = dollars(t.replace(/\b\d+\s*%/g, ""));
    if (n !== null) return { action: "budget", amount: Math.round(n * 100) / 100 };
  }

  // Share: "use 20% per alert", "set share to 15%", "size from 30 percent"
  const share = t.match(/(\d{1,2})\s*(%|percent)/);
  if (share && /\b(share|per alert|each alert|size|sizing|use)\b/.test(t)) return { action: "share", percent: Number(share[1]) };

  // Read-only actions
  if (/\b(show|see|check|how are|how're|list)\b.*\b(my\s+)?(bags?|holdings?|positions?|portfolio)\b|^(my\s+)?(bags?|holdings|positions|portfolio)\??$/.test(t)) {
    return { action: "holdings" };
  }
  if (/\b(check|scan|look at|refresh)\b.*\b(my\s+)?wallets?\b|\bdid i buy\b|\bnew buys?\b|\bany(thing)? new in my wallet\b/.test(t)) return { action: "check" };
  if (/\b(scan|scan the market|anything (moving|pumping|spiking)|what'?s (moving|pumping|spiking))\b/.test(t)) return { action: "scan" };
  if (/\b(what do you|what you)\s+(remember|know)\s+about me\b|\bshow (me )?(my )?memory\b|\bwhat have you (saved|stored)\b/.test(t)) return { action: "memory" };
  if (/^(help|commands|menu)$|\bwhat can you do\b|\bwhat are your commands\b|\bhow do i use you\b/.test(t)) return { action: "help" };

  return null;
}
