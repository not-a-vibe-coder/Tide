import { Bot, InlineKeyboard, type Context } from "grammy";
import { toTelegramHtml } from "../ai/clean.js";
import type { Companion } from "../ai/companion.js";
import { parseSuiAddress } from "../chain/sui.js";
import type { CheckResult } from "../checks.js";
import { log } from "../log.js";
import type { AlertAction, Button, Notifier, Tide } from "../tide.js";
import { esc, shortAddress, usd } from "./format.js";

const HELP = [
  "i'm <b>tide</b>. i watch sui for tokens that start moving, keep track of what you buy and why, and get stricter with you when your calls go bad. you can just talk to me too.",
  "",
  "/holdings · your bags, how they're doing, and why you bought",
  "/scan · look for anything moving on sui right now",
  "/check · look for new buys in your wallet",
  "/budget <code>30</code> · how much you're happy to risk a week, in usd",
  "/share <code>25</code> · what % of what's left i size each alert from",
  "/alerts on, off or reset · pause me, or unmute token types",
  "/wallet <code>0x…</code> · change the wallet i watch",
  "/memory · everything i remember about you",
  "",
  "what you tell me lives on walrus memory. nothing i say is financial advice.",
].join("\n");

/** Looks like a question to the bot, not an answer to "why did you buy". */
const QUESTION = /\?\s*$|^(what|how|why|should|is|are|can|could|do|does|did|when|which|who|where|tell me|show me|abeg|wetin|how far)\b/i;

function keyboard(buttons?: Button[][]): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export interface BotOptions {
  adminIds: number[];
  runDoctor?: (wallet?: string) => Promise<CheckResult[]>;
  companion?: Companion;
}

export function createBot(token: string, tide: Tide, opts: BotOptions): Bot {
  const { adminIds, runDoctor, companion } = opts;
  const bot = new Bot(token);
  const awaitingBudget = new Set<number>();

  const notifier: Notifier = {
    async send(chatId, html, buttons) {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        reply_markup: keyboard(buttons),
        link_preview_options: { is_disabled: true },
      });
    },
  };
  tide.attach(notifier);

  const reply = (ctx: Context, html: string, buttons?: Button[][]) =>
    ctx.reply(html, { parse_mode: "HTML", reply_markup: keyboard(buttons), link_preview_options: { is_disabled: true } });

  const ensureUser = (ctx: Context) => {
    tide.setName(ctx.from!.id, ctx.from!.first_name);
    return tide.start(ctx.from!.id, ctx.chat!.id);
  };
  const hey = (ctx: Context) => (ctx.from?.first_name ? `${esc(ctx.from.first_name.toLowerCase())}, ` : "");

  async function saveWallet(ctx: Context, address: string) {
    const userId = ctx.from!.id;
    await reply(ctx, `one sec, reading <code>${shortAddress(address)}</code>…`);
    try {
      const { liquidUsd, proposedBudget } = await tide.setWallet(userId, address);
      await reply(
        ctx,
        [
          `got it, i'll remember this wallet so you never have to send it again.`,
          `you've got about <b>${usd(liquidUsd)}</b> in sui and usdc.`,
          "",
          `how about a weekly trading budget of <b>${usd(proposedBudget)}</b>? i'll never suggest more than that in a week, even when something's flying.`,
        ].join("\n"),
        [
          [
            { text: `yes, ${usd(proposedBudget)}`, data: `budget:${proposedBudget}` },
            { text: "i'll pick my own", data: "budget:custom" },
          ],
        ],
      );
    } catch (err) {
      log.error("setWallet failed", err);
      await reply(ctx, "saved the address, but i couldn't read its balances just now. i'll try again on my next check.");
    }
  }

  bot.command("start", async (ctx) => {
    const user = ensureUser(ctx);
    if (user.wallet) {
      await reply(ctx, `${hey(ctx) || "hey, "}welcome back. still watching <code>${shortAddress(user.wallet)}</code> for you.\n\n${HELP}`);
      return;
    }
    await reply(
      ctx,
      [
        `hey${ctx.from?.first_name ? ` ${esc(ctx.from.first_name.toLowerCase())}` : ""}, i'm <b>tide</b>.`,
        "i watch sui for tokens that start picking up volume, keep track of what you buy and why, and tell you how much i'd risk based on your own budget and record.",
        "",
        "paste your <b>sui wallet address</b> and we'll start. i only read public data, i'll never ask for keys or signatures.",
      ].join("\n"),
    );
  });

  bot.command("help", (ctx) => reply(ctx, HELP));

  bot.command("wallet", async (ctx) => {
    ensureUser(ctx);
    const address = parseSuiAddress(ctx.match ?? "");
    if (!address) return reply(ctx, "send it like this: /wallet <code>0x…</code>");
    await saveWallet(ctx, address);
  });

  bot.command("budget", async (ctx) => {
    ensureUser(ctx);
    const amount = Number((ctx.match ?? "").replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0 || !(ctx.match ?? "").trim()) {
      awaitingBudget.add(ctx.from!.id);
      return reply(ctx, "how much are you happy to risk a week, in usd? just the number, like <code>30</code>.");
    }
    tide.setBudget(ctx.from!.id, amount);
    await reply(ctx, `done, your weekly budget is <b>${usd(amount)}</b>.`);
  });

  bot.command("share", async (ctx) => {
    ensureUser(ctx);
    const p = Number((ctx.match ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(p) || p < 5 || p > 50) return reply(ctx, "pick something between 5 and 50, like /share <code>25</code>.");
    tide.setBaseShare(ctx.from!.id, p / 100);
    await reply(ctx, `okay, each alert now starts from <b>${p}%</b> of what's left in your week.`);
  });

  bot.command("holdings", async (ctx) => {
    ensureUser(ctx);
    await reply(ctx, await tide.holdingsReport(ctx.from!.id));
  });

  bot.command("check", async (ctx) => {
    const user = ensureUser(ctx);
    if (!user.wallet) return reply(ctx, "i need your wallet first, paste your sui address here.");
    const found = await tide.checkWallet(user).catch((err) => {
      log.error("check failed", err);
      return -1;
    });
    if (found < 0) return reply(ctx, "couldn't reach sui just now. give it a minute and try again.");
    if (found === 0) await reply(ctx, "nothing new since i last looked.");
  });

  bot.command("scan", async (ctx) => {
    ensureUser(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});
    const n = await tide.scan().catch((err) => {
      log.error("scan failed", err);
      return -1;
    });
    if (n < 0) await reply(ctx, "the market data is being slow right now. try me again in a bit.");
    else if (n === 0) await reply(ctx, "nothing's really moving on sui right now. i'll keep an eye out.");
  });

  bot.command("alerts", async (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off") (tide.setAlerts(ctx.from!.id, false), await reply(ctx, "okay, i'll stay quiet. /alerts on when you want me back."));
    else if (arg === "on") (tide.setAlerts(ctx.from!.id, true), await reply(ctx, "alerts are back on."));
    else if (arg === "reset") (tide.unmuteAll(ctx.from!.id), await reply(ctx, "unmuted everything, you'll hear about all token types again."));
    else await reply(ctx, "use /alerts on, /alerts off or /alerts reset.");
  });

  bot.command("memory", async (ctx) => {
    ensureUser(ctx);
    await reply(ctx, tide.memoryReport(ctx.from!.id));
  });

  bot.command("doctor", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) {
      return reply(ctx, `only the admin can run checks. your telegram id is <code>${ctx.from!.id}</code>.`);
    }
    if (!runDoctor) return reply(ctx, "checks aren't available in this build.");
    await reply(ctx, "checking telegram, tatum, geckoterminal and a real walrus memory write…");
    const user = tide.store.getUser(ctx.from!.id);
    const results = await runDoctor(user?.wallet ?? undefined);
    const lines = results.map((r) => `${r.ok ? "✅" : "❌"} <b>${esc(r.name)}</b>: ${esc(r.detail)}`);
    if (companion) {
      const ai = await companion.ping().then(
        (d) => `✅ <b>AI chat</b>: ${esc(d)}`,
        (e) => `${companion.enabled ? "❌" : "⚪"} <b>AI chat</b>: ${esc(e instanceof Error ? e.message : String(e))}`,
      );
      lines.push(ai);
    }
    await reply(ctx, lines.join("\n"));
  });

  bot.command("rebuild", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) return reply(ctx, "only the admin can run a rebuild.");
    await reply(ctx, "wiping my local memory and rebuilding it from walrus…");
    try {
      const ids = tide.store.usersWithWallets().map((u) => u.id);
      if (!ids.includes(ctx.from!.id)) ids.push(ctx.from!.id);
      const counts = await tide.memory.rebuild(ids);
      const lines = Object.entries(counts).map(([ns, n]) => `<code>${esc(ns)}</code>: ${n} events`);
      await reply(ctx, ["<b>rebuilt everything from walrus memory</b>", ...lines].join("\n"));
    } catch (err) {
      await reply(ctx, `rebuild failed: ${esc(err instanceof Error ? err.message : String(err))}`);
    }
  });

  bot.callbackQuery(/^act:(bought|skipped|not_for_me):(.+)$/, async (ctx) => {
    const [, action, alertId] = ctx.match!;
    const msg = tide.handleAlertAction(ctx.from.id, alertId!, action as AlertAction);
    await ctx.answerCallbackQuery({ text: msg.slice(0, 190) });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await reply(ctx, esc(msg));
  });

  bot.callbackQuery(/^budget:(custom|\d+(?:\.\d+)?)$/, async (ctx) => {
    const v = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (v === "custom") {
      awaitingBudget.add(ctx.from.id);
      return reply(ctx, "how much are you happy to risk a week, in usd? just the number, like <code>30</code>.");
    }
    tide.setBudget(ctx.from.id, Number(v));
    await reply(ctx, `done, <b>${usd(Number(v))}</b> a week. i'll ping you when something on sui starts moving.`);
  });

  bot.callbackQuery(/^skipreason:(.+)$/, async (ctx) => {
    tide.skipReason(ctx.from.id, ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "skipped" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    const user = tide.store.getUser(ctx.from.id);
    if (user) await tide.askNextReason(user);
  });

  bot.on("message:text", async (ctx) => {
    const user = ensureUser(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (awaitingBudget.has(user.id)) {
      const amount = Number(text.replace(/[$,\s]/g, ""));
      if (Number.isFinite(amount) && amount > 0) {
        awaitingBudget.delete(user.id);
        tide.setBudget(user.id, amount);
        return reply(ctx, `done, your weekly budget is <b>${usd(amount)}</b>.`);
      }
      if (!QUESTION.test(text)) return reply(ctx, "just the number is fine, like <code>30</code>.");
      awaitingBudget.delete(user.id);
    }

    const address = parseSuiAddress(text);
    if (address) return saveWallet(ctx, address);

    // An unanswered "why did you buy" takes this message, unless it's clearly a question.
    if (!QUESTION.test(text)) {
      const symbol = tide.answerReason(user.id, text);
      if (symbol) {
        await reply(ctx, `got it. i'll check <b>${esc(symbol)}</b> against that every morning, and tell you if it stops being true.`);
        await tide.askNextReason(user);
        return;
      }
    }

    if (companion?.enabled) {
      await ctx.replyWithChatAction("typing").catch(() => {});
      const answer = await companion.reply(user.id, ctx.from.first_name, text).catch((err) => {
        log.warn("chat failed", err);
        return null;
      });
      if (answer) return reply(ctx, toTelegramHtml(answer));
    }

    await reply(
      ctx,
      user.wallet
        ? `${hey(ctx)}i'm better with commands right now. try /holdings, /scan or /help.`
        : "paste your sui wallet address and we'll get started.",
    );
  });

  bot.catch((err) => log.error("bot error", err.error));
  return bot;
}
