import type { Bot, Context } from "grammy";
import { KNOWN_TOKENS, pickPool } from "../ai/lookup.js";
import type { Market } from "../market/gecko.js";
import type { Button } from "../tide.js";
import type { TradeDesk } from "../trade/desk.js";
import { describeRules, type SnipeRules } from "../trade/rules.js";
import { isSolanaAddress } from "../trade/wallet.js";

/** Trading said in plain words. */
export type TradeIntent =
  | { action: "home" }
  | { action: "positions" }
  | { action: "buy"; token: string; sol: number }
  | { action: "sell"; token: string; pct: number }
  | { action: "withdraw"; amount: number | "all"; to: string | null }
  | { action: "export" }
  | { action: "sniper" }
  | { action: "snipeSet"; set: Partial<SnipeRules> }
  | { action: "exit"; which: "tp" | "sl"; value: number | null }
  | { action: "dailyCap"; sol: number }
  | { action: "amounts"; sol: number[] };

const num = (s: string) => {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(k|m)?\b/i);
  if (!m) return NaN;
  return Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1);
};

export function parseTradeIntent(text: string): TradeIntent | null {
  const raw = text.trim();
  const t = raw.toLowerCase().replace(/\s+/g, " ");

  // buy 0.1 sol of $WIF · ape 0.2 sol into <mint> · buy $WIF with 0.1 sol
  let m = raw.match(/^(?:buy|ape|get me)\s+(\d+(?:\.\d+)?)\s*(?:sol|◎)\s+(?:of\s+|worth of\s+|into\s+|in\s+)?(\$?[A-Za-z0-9]{2,44})\b/i);
  if (m) return { action: "buy", sol: Number(m[1]), token: m[2]! };
  m = raw.match(/^(?:buy|ape)\s+(?:into\s+)?(\$?[A-Za-z0-9]{2,44})\s+(?:with|for)\s+(\d+(?:\.\d+)?)\s*(?:sol|◎)/i);
  if (m) return { action: "buy", sol: Number(m[2]), token: m[1]! };

  // sell all $WIF · sell 50% of BONK · sell half my WIF · sell $WIF
  m = raw.match(/^(?:sell|dump|close)\s+(all|everything|half|\d{1,3}\s*%)?\s*(?:of\s+)?(?:my\s+)?(\$?[A-Za-z0-9]{2,44})\s*$/i);
  if (m && !/^(all|everything|half)$/i.test(m[2]!)) {
    const p = !m[1] || /all|everything/i.test(m[1]) ? 100 : /half/i.test(m[1]) ? 50 : Number(m[1].replace("%", ""));
    return { action: "sell", token: m[2]!, pct: p };
  }

  // withdraw 0.5 sol to <address> · withdraw all to <address>
  m = raw.match(/^(?:withdraw|send|cash out)\s+(all|everything|\d+(?:\.\d+)?)\s*(?:sol)?\s*(?:to\s+)?([1-9A-HJ-NP-Za-km-z]{32,44})?\s*$/i);
  if (m) return { action: "withdraw", amount: /all|everything/i.test(m[1]!) ? "all" : Number(m[1]), to: m[2] ?? null };

  if (/\b(export|show|give me|reveal)\b.*\b(private key|secret key|seed|my key)\b|^export( key)?$/.test(t)) return { action: "export" };
  if (/\b(my positions|open positions|positions|my trades|what (am i|i dey) holding in tide)\b/.test(t) && !/\bsnipe/.test(t)) return { action: "positions" };
  if (/\b(trading wallet|trade wallet|tide wallet|deposit|fund (my )?wallet|my sol balance)\b/.test(t)) return { action: "home" };

  // take profit at 100% · stop loss at 40% · stop loss off
  m = t.match(/\btake[ -]?profit\b.*?(\d{1,4})\s*%/);
  if (m) return { action: "exit", which: "tp", value: Number(m[1]) };
  m = t.match(/\bstop[ -]?loss\b.*?(\d{1,3})\s*%/);
  if (m) return { action: "exit", which: "sl", value: Number(m[1]) };
  if (/\b(take[ -]?profit|stop[ -]?loss)\b.*\b(off|none|disable|remove)\b/.test(t)) return { action: "exit", which: /take/.test(t) ? "tp" : "sl", value: null };

  m = t.match(/\bdaily (?:limit|cap)\b.*?(\d+(?:\.\d+)?)\s*sol/);
  if (m) return { action: "dailyCap", sol: Number(m[1]) };
  if (/\bbuy buttons?\b/.test(t)) {
    const list = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1])).filter((n) => n > 0);
    if (list.length) return { action: "amounts", sol: list.slice(0, 3) };
  }

  // sniper settings
  if (/\bsnip(e|er|ing|es)\b/.test(t)) {
    if (/\b(show|my|what are|settings|rules)\b/.test(t) && !/\d/.test(t) && !/\b(on|off|start|stop)\b/.test(t)) return { action: "sniper" };
    const set: Partial<SnipeRules> = {};
    if (/\b(stop|turn off|disable|pause|no more)\b.*\bsnip|\bauto[ -]?snip\w*\s+off\b|\bsniper off\b/.test(t)) set.auto = false;
    else if (/\b(start|turn on|enable|switch on)\b.*\bsnip|\bauto[ -]?snip\w*\s+on\b|\bsniper on\b/.test(t)) set.auto = true;
    if (/\b(launch|snipe) alerts? off\b|\bstop (sending )?(launch|snipe) alerts\b/.test(t)) set.alerts = false;
    else if (/\b(launch|snipe) alerts? on\b|\balert me (on|for) (launches|snipes)\b/.test(t)) set.alerts = true;
    m = t.match(/(\d+(?:\.\d+)?)\s*sol\b/);
    if (m) set.sol = Number(m[1]);
    // A market cap needs a "k" or the word mcap, so "max 3 snipes a day" isn't read as $3.
    const cap = t.match(/\b(?:under|below|max|up to|less than)\s+\$?(\d+(?:\.\d+)?\s*k)\b/) ?? t.match(/\b(?:under|below|max|up to|less than)\s+\$?(\d+(?:\.\d+)?)\s*(?:mcap|market cap|mc)\b/);
    if (cap) set.mcapMaxUsd = num(cap[1]!);
    const floor = t.match(/\b(over|above|at least|min)\s+\$?(\d+(?:\.\d+)?\s*k?)\s*(mcap|market cap|mc)/);
    if (floor) set.mcapMinUsd = num(floor[2]!);
    const between = t.match(/\bbetween\s+\$?(\d+(?:\.\d+)?\s*k?)\s+(?:and|to)\s+\$?(\d+(?:\.\d+)?\s*k?)/);
    if (between) (set.mcapMinUsd = num(between[1]!), set.mcapMaxUsd = num(between[2]!));
    if (/\bany (mcap|market cap)\b/.test(t)) (set.mcapMaxUsd = null, set.mcapMinUsd = null);
    m = t.match(/(\d+)\s*buyers?\b/);
    if (m) set.minBuyers = Number(m[1]);
    if (/\b(no waiting|buy on launch|instantly|don'?t wait)\b/.test(t)) set.minBuyers = 0;
    m = t.match(/(\d+)\s*(?:snipes?\s*)?(?:a|per)\s*day\b/);
    if (m) set.maxPerDay = Number(m[1]);
    m = t.match(/\b(?:dev|creator)\b[^\d]*(\d{1,2})\s*%/);
    if (m) set.devMaxPct = Number(m[1]);
    m = t.match(/(\d{1,3})\s*(?:s|sec|seconds)\b/);
    if (m) set.windowSec = Number(m[1]);
    if (Object.keys(set).length) return { action: "snipeSet", set };
    return { action: "sniper" };
  }
  return null;
}

interface Deps {
  desk: TradeDesk;
  market: Market;
  reply: (ctx: Context, html: string, buttons?: Button[][]) => Promise<unknown>;
  background: (ctx: Context, name: string, work: () => Promise<unknown>) => void;
  ensureUser: (ctx: Context) => unknown;
  inGroup: (ctx: Context) => boolean;
  toPrivate: (ctx: Context) => Promise<unknown>;
}

const fmt = (n: number) => (n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/\.?0+$/, "") || "0";
const usd = (n: number) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : Math.abs(n) >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

const RISK = [
  "<b>before i trade for you</b>",
  "",
  "• i'll make you a <b>separate solana trading wallet</b>. i hold its key so i can buy in seconds and snipe launches while you sleep.",
  "• only put in what you're ready to lose. most new tokens go to zero, and any bot that holds keys is a target.",
  "• you can withdraw or export the key any time with /trade.",
  "• your wallet you track with /wallet stays read-only. i never touch it.",
  "• nothing i do is financial advice. you set the rules, i follow them.",
].join("\n");

/** /trade, /buy, /sell, /positions, /snipe, /withdraw, /export, and the buy/sell buttons. */
export function registerTrading(bot: Bot, d: Deps) {
  const { desk, reply } = d;
  const off = (ctx: Context) => reply(ctx, "trading isn't switched on for this bot yet.");

  /** Turn "$WIF", "wif", a position's symbol or a mint into a Solana mint. */
  async function resolveMint(userId: number, token: string): Promise<{ mint: string; symbol: string } | null> {
    const q = token.replace(/^\$/, "");
    if (isSolanaAddress(q)) return { mint: q, symbol: (await d.market.symbol(q).catch(() => null)) ?? q.slice(0, 4) };
    const held = desk.store.positions(userId).find((p) => p.symbol.toUpperCase() === q.toUpperCase());
    if (held) return { mint: held.mint, symbol: held.symbol };
    const known = KNOWN_TOKENS[q.toUpperCase()];
    if (known && !known.includes("::")) return { mint: known, symbol: q.toUpperCase() };
    const { best } = pickPool(q, await d.market.search(q, ["solana"]).catch(() => []));
    return best ? { mint: best.baseCoinType, symbol: best.baseSymbol } : null;
  }

  async function home(ctx: Context) {
    const id = ctx.from!.id;
    if (!desk.enabled) return off(ctx);
    if (!desk.acknowledged(id)) return reply(ctx, RISK, [[{ text: "i understand, make my trading wallet", data: "tw:ack" }]]);
    const [bal, solUsd] = await Promise.all([desk.balanceSol(id).catch(() => null), desk.solUsd()]);
    const r = desk.rules(id);
    return reply(
      ctx,
      [
        "<b>your tide trading wallet</b> · solana",
        `<code>${desk.address(id)}</code>`,
        `balance: <b>${bal === null ? "couldn't read" : `${fmt(bal)} sol`}</b>${bal !== null && solUsd ? ` (${usd(bal * solUsd)})` : ""}`,
        `open positions: ${desk.store.positions(id).length} · sniper: ${r.auto ? "auto-buy on" : r.alerts ? "alerts only" : "off"}`,
        "",
        "send sol to this address to fund it. buy with the buttons on solana alerts, or just say <code>buy 0.1 sol of $WIF</code>.",
      ].join("\n"),
      [
        [{ text: "positions", data: "tw:pos" }, { text: "sniper", data: "tw:snipe" }],
        [{ text: "withdraw", data: "tw:wd" }, { text: "export key", data: "tw:exp" }],
        [{ text: "refresh", data: "tw:home" }],
      ],
    );
  }

  async function positions(ctx: Context) {
    const id = ctx.from!.id;
    const list = await desk.valued(id);
    if (!list.length) return reply(ctx, "no open positions in your trading wallet.");
    const lines = list.slice(0, 8).map(({ pos, valueUsd, changePct }) => {
      const exits = [pos.tp_pct !== null ? `tp +${pos.tp_pct}%` : null, pos.sl_pct !== null ? `sl -${pos.sl_pct}%` : null].filter(Boolean).join(" · ");
      return `<b>${esc(pos.symbol)}</b>: in ${usd(pos.cost_usd)}${valueUsd !== null ? `, now ${usd(valueUsd)} (${changePct! >= 0 ? "+" : ""}${changePct!.toFixed(0)}%)` : ", price not available yet"}${exits ? ` · ${exits}` : ""}`;
    });
    const buttons = list.slice(0, 8).map(({ pos }) => [
      { text: `sell 50% ${pos.symbol}`.slice(0, 30), data: `s:${pos.mint}:50` },
      { text: `sell all ${pos.symbol}`.slice(0, 30), data: `s:${pos.mint}:100` },
    ]);
    return reply(ctx, ["<b>open positions</b>", ...lines].join("\n"), buttons);
  }

  function sniper(ctx: Context) {
    const id = ctx.from!.id;
    const r = desk.rules(id);
    return reply(
      ctx,
      [
        `<b>your sniper</b> · auto-buy <b>${r.auto ? "on" : "off"}</b> · launch alerts <b>${r.alerts ? "on" : "off"}</b>`,
        "",
        describeRules(r, usd),
        "",
        "it watches every new pump.fun launch live. change anything in plain words: <code>snipe 0.1 sol</code>, <code>snipe under 20k mcap</code>, <code>wait for 8 buyers</code>, <code>creator under 5%</code>, <code>max 3 snipes a day</code>, <code>take profit at 150%</code>, <code>stop loss at 30%</code>.",
      ].join("\n"),
      [
        [{ text: r.auto ? "turn auto-buy off" : "turn auto-buy on", data: `sn:auto:${r.auto ? "off" : "on"}` }],
        [{ text: r.alerts ? "launch alerts off" : "launch alerts on", data: `sn:alerts:${r.alerts ? "off" : "on"}` }],
      ],
    );
  }

  async function exportKey(ctx: Context) {
    const id = ctx.from!.id;
    if (d.inGroup(ctx)) return d.toPrivate(ctx);
    if (!desk.enabled) return off(ctx);
    if (!desk.acknowledged(id)) return home(ctx);
    const sent = await ctx.reply(
      `<b>your trading wallet's private key</b>. anyone with this can take everything in the wallet. import it into phantom or solflare, then this message deletes itself in 60 seconds.\n\n<tg-spoiler><code>${desk.exportKey(id)}</code></tg-spoiler>`,
      { parse_mode: "HTML" },
    );
    setTimeout(() => void ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => {}), 60_000);
  }

  const doBuy = (ctx: Context, mint: string, sol: number) =>
    d.background(ctx, "buy", async () => {
      const res = await desk.buy(ctx.from!.id, mint, sol);
      await reply(ctx, res.text, res.buttons);
    });
  const doSell = (ctx: Context, mint: string, pct: number) =>
    d.background(ctx, "sell", async () => {
      const res = await desk.sell(ctx.from!.id, mint, pct);
      await reply(ctx, res.text, res.buttons);
    });

  function applySnipe(ctx: Context, set: Partial<SnipeRules>) {
    const id = ctx.from!.id;
    if (set.sol !== undefined && set.sol > 0 && !desk.acknowledged(id)) return home(ctx);
    for (const [k, v] of Object.entries(set) as [keyof SnipeRules, never][]) desk.setRule(id, k, v);
    if (set.auto && !desk.acknowledged(id)) return home(ctx);
    return sniper(ctx);
  }

  /** Run a plain-language trading request. */
  async function run(ctx: Context, i: TradeIntent) {
    d.ensureUser(ctx);
    if (d.inGroup(ctx)) return d.toPrivate(ctx);
    if (!desk.enabled) return off(ctx);
    const id = ctx.from!.id;
    switch (i.action) {
      case "home":
        return home(ctx);
      case "positions":
        return positions(ctx);
      case "export":
        return exportKey(ctx);
      case "sniper":
        return sniper(ctx);
      case "snipeSet":
        return applySnipe(ctx, i.set);
      case "exit":
        desk.setExits(id, i.which, i.value);
        return reply(ctx, i.value === null ? `${i.which === "tp" ? "take profit" : "stop loss"} is off now.` : `done. new buys and snipes will ${i.which === "tp" ? `take profit at +${i.value}%` : `stop out at -${i.value}%`}.`);
      case "dailyCap":
        desk.memory.record(id, { type: "preference", key: "daily_sol_cap", value: String(i.sol) });
        return reply(ctx, `daily limit set to ${i.sol} sol.`);
      case "amounts":
        desk.setBuyAmounts(id, i.sol);
        return reply(ctx, `buy buttons are now ${i.sol.map((s) => `${s} sol`).join(", ")}.`);
      case "buy": {
        if (!desk.acknowledged(id)) return home(ctx);
        const tok = await resolveMint(id, i.token);
        if (!tok) return reply(ctx, `couldn't find ${esc(i.token)} on solana. paste its mint address instead.`);
        return reply(ctx, `buy <b>${fmt(i.sol)} sol</b> of <b>${esc(tok.symbol)}</b>?\n<code>${tok.mint}</code>`, [[{ text: `yes, buy ${fmt(i.sol)} sol`, data: `b:${tok.mint}:${i.sol}` }, { text: "cancel", data: "tw:cancel" }]]);
      }
      case "sell": {
        const tok = await resolveMint(id, i.token);
        if (!tok) return reply(ctx, `couldn't find ${esc(i.token)} in your trading wallet.`);
        return reply(ctx, `sell <b>${i.pct === 100 ? "all" : `${i.pct}%`}</b> of <b>${esc(tok.symbol)}</b>?`, [[{ text: "yes, sell", data: `s:${tok.mint}:${i.pct}` }, { text: "cancel", data: "tw:cancel" }]]);
      }
      case "withdraw": {
        if (!i.to) return reply(ctx, "where to? like <code>withdraw 0.5 sol to YOUR_ADDRESS</code> or <code>withdraw all to YOUR_ADDRESS</code>.");
        if (!isSolanaAddress(i.to)) return reply(ctx, "that doesn't look like a solana address.");
        const amt = i.amount === "all" ? "all" : fmt(i.amount);
        return reply(ctx, `send <b>${amt === "all" ? "everything" : `${amt} sol`}</b> to <code>${i.to}</code>?`, [[{ text: "yes, send it", data: `wd:${amt}:${i.to}` }, { text: "cancel", data: "tw:cancel" }]]);
      }
    }
  }

  // commands
  bot.command("trade", (ctx) => (d.ensureUser(ctx), d.inGroup(ctx) ? d.toPrivate(ctx) : home(ctx)));
  bot.command("positions", (ctx) => run(ctx, { action: "positions" }));
  bot.command("export", (ctx) => run(ctx, { action: "export" }));
  bot.command("snipe", (ctx) => {
    const arg = (ctx.match ?? "").trim();
    const i = arg ? parseTradeIntent(`snipe ${arg}`) : null;
    return run(ctx, i ?? { action: "sniper" });
  });
  bot.command("buy", (ctx) => {
    const [token, amount] = (ctx.match ?? "").trim().split(/\s+/);
    if (!token) return reply(ctx, "like <code>/buy WIF 0.1</code> (token, then sol).");
    return run(ctx, { action: "buy", token, sol: Number(amount) || desk.buyAmounts(ctx.from!.id)[0]! });
  });
  bot.command("sell", (ctx) => {
    const [token, p] = (ctx.match ?? "").trim().split(/\s+/);
    if (!token) return reply(ctx, "like <code>/sell WIF 50</code> (token, then percent; leave it out to sell all).");
    return run(ctx, { action: "sell", token, pct: Number((p ?? "100").replace("%", "")) || 100 });
  });
  bot.command("withdraw", (ctx) => {
    const i = parseTradeIntent(`withdraw ${(ctx.match ?? "").trim()}`);
    return run(ctx, i?.action === "withdraw" ? i : { action: "withdraw", amount: "all", to: null });
  });

  // buttons
  bot.callbackQuery(/^tw:(ack|home|pos|snipe|wd|exp|cancel)$/, async (ctx) => {
    const a = ctx.match![1];
    await ctx.answerCallbackQuery();
    if (a === "cancel") return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (a === "ack") {
      desk.acknowledge(ctx.from.id);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return home(ctx);
    }
    if (a === "home") return home(ctx);
    if (a === "pos") return positions(ctx);
    if (a === "snipe") return sniper(ctx);
    if (a === "exp") return exportKey(ctx);
    return reply(ctx, "say <code>withdraw 0.5 sol to YOUR_ADDRESS</code> or <code>withdraw all to YOUR_ADDRESS</code>.");
  });
  bot.callbackQuery(/^b:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+(?:\.\d+)?)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "buying…" });
    if (!desk.acknowledged(ctx.from.id)) return home(ctx);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    doBuy(ctx, ctx.match![1]!, Number(ctx.match![2]));
  });
  bot.callbackQuery(/^s:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "selling…" });
    doSell(ctx, ctx.match![1]!, Number(ctx.match![2]));
  });
  bot.callbackQuery(/^wd:(all|\d+(?:\.\d+)?):([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "sending…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const [, amt, to] = ctx.match!;
    d.background(ctx, "withdraw", async () => {
      const res = await desk.withdraw(ctx.from!.id, to!, amt === "all" ? "all" : Number(amt));
      await reply(ctx, res.text);
    });
  });
  bot.callbackQuery(/^sn:(auto|alerts):(on|off)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return applySnipe(ctx, { [ctx.match![1] === "auto" ? "auto" : "alerts"]: ctx.match![2] === "on" });
  });

  return { run };
}
