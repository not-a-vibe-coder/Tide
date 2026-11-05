import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/bot/intents.js";

const cases: [string, ReturnType<typeof parseIntent>][] = [
  // launch alerts
  ["turn on alert for launches", { action: "launches", on: true }],
  ["turn on launch alerts", { action: "launches", on: true }],
  ["alert me when a new token launches on sui or solana", { action: "launches", on: true }],
  ["can you alert me when a new token is launched?", { action: "launches", on: true }],
  ["i want alerts for new tokens", { action: "launches", on: true }],
  ["abeg on am for new tokens", { action: "launches", on: true }],
  ["turn off launch alerts", { action: "launches", on: false }],
  ["stop sending me new token launches", { action: "launches", on: false }],
  ["no more launches pls", { action: "launches", on: false }],
  // chains
  ["only solana alerts", { action: "alertChains", chains: ["solana"] }],
  ["just send me sui alerts", { action: "alertChains", chains: ["sui"] }],
  ["alerts for both chains", { action: "alertChains", chains: ["sui", "solana"] }],
  ["stop sui alerts", { action: "alertChains", chains: ["solana"] }],
  // all alerts
  ["pause alerts", { action: "alerts", on: false }],
  ["stop alerting me", { action: "alerts", on: false }],
  ["too many notifications", { action: "alerts", on: false }],
  ["turn alerts back on", { action: "alerts", on: true }],
  ["unmute everything", { action: "unmute" }],
  // budget and share
  ["set my budget to $50", { action: "budget", amount: 50 }],
  ["my weekly budget is 40 dollars", { action: "budget", amount: 40 }],
  ["change budget to 1.5k", { action: "budget", amount: 1500 }],
  ["use 20% per alert", { action: "share", percent: 20 }],
  ["set share to 15 percent", { action: "share", percent: 15 }],
  // actions
  ["show me my bags", { action: "holdings" }],
  ["how are my positions doing", { action: "holdings" }],
  ["check my wallet", { action: "check" }],
  ["did i buy anything new", { action: "check" }],
  ["scan the market", { action: "scan" }],
  ["what's pumping", { action: "scan" }],
  ["what do you remember about me", { action: "memory" }],
  ["what can you do", { action: "help" }],
];

const notIntents = [
  "how much budget do i have left?",
  "what is my budget?",
  "should i buy $WIF",
  "why shouldn't i buy pepe",
  "get me top 5 leading tokens on solana",
  "hey whats up",
  "i bought it because the volume was rising",
  "is solana better than sui",
  "lol i'm cooked today",
];

describe("plain-language requests", () => {
  it.each(cases)("%s", (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });

  it.each(notIntents)("leaves '%s' to the chat", (text) => {
    expect(parseIntent(text)).toBeNull();
  });
});
