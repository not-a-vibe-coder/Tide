import { Bot, InlineKeyboard, type Context } from "grammy";
import { parseSuiAddress } from "../chain/sui.js";
import { log } from "../log.js";
import type { AlertAction, Button, Notifier, Tide } from "../tide.js";
import { esc, shortAddress, usd } from "./format.js";

const HELP = [
  "<b>Tide</b> watches Sui for tokens gaining momentum, tracks your own trades, and learns how much you should risk.",
  "",
  "/wallet <code>0x…</code> · set the Sui address to track (read-only)",
  "/budget <code>30</code> · weekly trading budget in USD",
  "/share <code>25</code> · % of the remaining budget per alert",
  "/holdings · your positions, P&amp;L, and why you bought",
  "/check · check your wallet for new buys now",
  "/scan · scan Sui for spikes now",
  "/alerts on|off|reset · pause alerts, or unmute token types",
  "/memory · what I remember about you",
  "",
  "Everything you tell me is stored on Walrus Memory. Nothing here is financial advice.",
].join("\n");

function keyboard(buttons?: Button[][]): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    for (const b of row) kb.text(b.text, b.data);
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export function createBot(token: string, tide: Tide, adminIds: number[]): Bot {
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

  const ensureUser = (ctx: Context) => tide.start(ctx.from!.id, ctx.chat!.id);

  async function saveWallet(ctx: Context, address: string) {
    const userId = ctx.from!.id;
    await reply(ctx, `Reading <code>${shortAddress(address)}</code> through Tatum…`);
    try {
      const { liquidUsd, proposedBudget } = await tide.setWallet(userId, address);
      await reply(
        ctx,
        [
          "Wallet saved. You won't need to send it again.",
          `You hold about <b>${usd(liquidUsd)}</b> in SUI and USDC.`,
          "",
          `Set a weekly trading budget of <b>${usd(proposedBudget)}</b>? This caps how much I'll ever suggest per week.`,
        ].join("\n"),
        [
          [
            { text: `Yes, ${usd(proposedBudget)}`, data: `budget:${proposedBudget}` },
            { text: "Pick my own", data: "budget:custom" },
          ],
        ],
      );
    } catch (err) {
      log.error("setWallet failed", err);
      await reply(ctx, "I saved the address but couldn't read its balances right now. I'll try again on the next check.");
    }
  }

  bot.command("start", async (ctx) => {
    const user = ensureUser(ctx);
    if (user.wallet) {
      await reply(ctx, `Welcome back. I'm tracking <code>${shortAddress(user.wallet)}</code>.\n\n${HELP}`);
      return;
    }
    await reply(
      ctx,
      [
        "Hi, I'm <b>Tide</b>.",
        "I spot Sui tokens picking up volume, track how your own trades are doing, and suggest how much to risk based on your budget and record.",
        "",
        "Paste your <b>Sui wallet address</b> to begin. I only read public data. I never ask for keys or signatures.",
      ].join("\n"),
    );
  });

  bot.command("help", (ctx) => reply(ctx, HELP));

  bot.command("wallet", async (ctx) => {
    ensureUser(ctx);
    const address = parseSuiAddress(ctx.match ?? "");
    if (!address) return reply(ctx, "Send it like this: /wallet <code>0x…</code>");
    await saveWallet(ctx, address);
  });

  bot.command("budget", async (ctx) => {
    ensureUser(ctx);
    const amount = Number((ctx.match ?? "").replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount < 0) {
      awaitingBudget.add(ctx.from!.id);
      return reply(ctx, "How much per week, in USD? Send a number, like <code>30</code>.");
    }
    tide.setBudget(ctx.from!.id, amount);
    await reply(ctx, `Weekly budget set to <b>${usd(amount)}</b>.`);
  });

  bot.command("share", async (ctx) => {
    ensureUser(ctx);
    const p = Number((ctx.match ?? "").replace(/[%\s]/g, ""));
    if (!Number.isFinite(p) || p < 5 || p > 50) return reply(ctx, "Pick a share between 5 and 50, like /share <code>25</code>.");
    tide.setBaseShare(ctx.from!.id, p / 100);
    await reply(ctx, `Each alert will now start from <b>${p}%</b> of your remaining weekly budget.`);
  });

  bot.command("holdings", async (ctx) => {
    ensureUser(ctx);
    await reply(ctx, await tide.holdingsReport(ctx.from!.id));
  });

  bot.command("check", async (ctx) => {
    const user = ensureUser(ctx);
    if (!user.wallet) return reply(ctx, "Set your wallet first with /wallet <code>0x…</code>");
    const found = await tide.checkWallet(user).catch((err) => {
      log.error("check failed", err);
      return -1;
    });
    if (found < 0) return reply(ctx, "Couldn't reach the Sui gateway just now. Try again in a minute.");
    if (found === 0) await reply(ctx, "No new buys since my last look.");
  });

  bot.command("scan", async (ctx) => {
    ensureUser(ctx);
    await reply(ctx, "Scanning Sui pools…");
    const n = await tide.scan().catch((err) => {
      log.error("scan failed", err);
      return -1;
    });
    if (n < 0) await reply(ctx, "Market data is unavailable right now. Try again shortly.");
    else if (n === 0) await reply(ctx, "Nothing is spiking right now. I'll keep watching.");
  });

  bot.command("alerts", async (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off") (tide.setAlerts(ctx.from!.id, false), await reply(ctx, "Alerts paused."));
    else if (arg === "on") (tide.setAlerts(ctx.from!.id, true), await reply(ctx, "Alerts on."));
    else if (arg === "reset") (tide.unmuteAll(ctx.from!.id), await reply(ctx, "Unmuted all token types."));
    else await reply(ctx, "Use /alerts on, /alerts off, or /alerts reset.");
  });

  bot.command("memory", async (ctx) => {
    ensureUser(ctx);
    await reply(ctx, tide.memoryReport(ctx.from!.id));
  });

  bot.command("rebuild", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) return reply(ctx, "Only the bot admin can run a rebuild.");
    await reply(ctx, "Wiping the local cache and rebuilding it from Walrus Memory…");
    try {
      const ids = tide.store.usersWithWallets().map((u) => u.id);
      if (!ids.includes(ctx.from!.id)) ids.push(ctx.from!.id);
      const counts = await tide.memory.rebuild(ids);
      const lines = Object.entries(counts).map(([ns, n]) => `<code>${esc(ns)}</code>: ${n} events`);
      await reply(ctx, ["<b>Rebuilt from Walrus Memory</b>", ...lines].join("\n"));
    } catch (err) {
      await reply(ctx, `Rebuild failed: ${esc(err instanceof Error ? err.message : String(err))}`);
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
      return reply(ctx, "How much per week, in USD? Send a number, like <code>30</code>.");
    }
    tide.setBudget(ctx.from.id, Number(v));
    await reply(ctx, `Weekly budget set to <b>${usd(Number(v))}</b>. I'll ping you when something on Sui starts moving.`);
  });

  bot.callbackQuery(/^skipreason:(.+)$/, async (ctx) => {
    tide.skipReason(ctx.from.id, ctx.match![1]!);
    await ctx.answerCallbackQuery({ text: "Skipped" });
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
      if (!Number.isFinite(amount) || amount < 0) return reply(ctx, "Send just a number, like <code>30</code>.");
      awaitingBudget.delete(user.id);
      tide.setBudget(user.id, amount);
      return reply(ctx, `Weekly budget set to <b>${usd(amount)}</b>.`);
    }

    const address = parseSuiAddress(text);
    if (address) return saveWallet(ctx, address);

    const symbol = tide.answerReason(user.id, text);
    if (symbol) {
      await reply(ctx, `Saved. I'll check <b>${esc(symbol)}</b> against that reason in your daily updates.`);
      await tide.askNextReason(user);
      return;
    }

    await reply(ctx, user.wallet ? "Try /holdings, /scan or /help." : "Paste your Sui wallet address to begin.");
  });

  bot.catch((err) => log.error("bot error", err.error));
  return bot;
}
