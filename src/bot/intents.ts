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
  | { action: "help" };

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
