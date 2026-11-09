import { sequentialize } from "@grammyjs/runner";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { toTelegramHtml } from "../ai/clean.js";
import type { Companion } from "../ai/companion.js";
import { parseSuiAddress } from "../chain/sui.js";
import { CHAIN_LABEL, parseSolanaAddress, type Chain } from "../core/chains.js";
import type { CheckResult } from "../checks.js";
import { log } from "../log.js";
import type { AlertAction, Button, Notifier, Tide } from "../tide.js";
import { chainVolumeLine, esc, lowCapList, shortAddress, topList, usd } from "./format.js";
import { assessRisk } from "../core/spike.js";
import { describeCapRange } from "../core/filters.js";
import type { Pool } from "../core/types.js";
import { amounts, parseIntent, type Intent } from "./intents.js";

const HELP = [
  "i'm <b>tide</b>. i watch sui and solana for tokens that start moving, keep track of what you buy and why, and get stricter with you when your calls go bad. you can just talk to me too, or ask me about any token.",
  "",
  "/holdings · your bags, how they're doing, and why you bought",
  "/scan · look for anything moving right now",
  "/top · the top 5 tokens on sui and solana by 24h volume (/top solana, /top new for launched in the last 24h)",
  "/check · look for new buys in your wallet",
  "/budget <code>30</code> · how much you're happy to risk a week, in usd",
  "/share <code>25</code> · what % of what's left i size each alert from",
  "/alerts on, off or reset · pause me, or unmute token types",
  "/alerts sui, solana or both · which chains you hear about",
  "/launches on or off · ping me when a new token launches (riskiest stuff, off by default)",
  "/mcap <code>100k</code> or <code>20k-150k</code> · only send tokens in that market cap range (/mcap off clears it)",
  "/pumped <code>200</code> · skip tokens already up more than that % in 24h (default 100, /pumped off allows them)",
  "/lowcaps <code>solana 50k</code> · small caps with real buyers right now",
  "/volume · how much dex volume sui and solana did in the last 24h",
  "/wallet <code>address</code> · add or change a sui or solana wallet",
  "/memory · everything i remember about you",
  "",
  "no commands needed, you can just say things like \"turn on launch alerts\", \"only send tokens under 100k mcap\", \"find me low caps on solana\", \"how much volume is on sui\", \"show my bags\" or \"why shouldn't i buy $WIF\".",
  "",
  "i remember what you tell me, so you never have to repeat yourself. nothing i say is financial advice.",
].join("\n");

/** First message a new person sees: what tide does for them, in plain words, then the one step to start. */
export function welcome(firstName?: string): string {
  return [
    `hey${firstName ? ` ${esc(firstName.toLowerCase())}` : ""}, i'm <b>tide</b>, your trading friend on sui and solana. here's what i do for you:`,
    "",
    "📈 <b>i find tokens as they start moving.</b> about every 45 minutes i send you the best pick on each chain: something suddenly getting bought hard, or a fresh launch if you want those.",
    "🚩 <b>i tell you what could go wrong.</b> every pick comes with the red flags first, like a tiny exit, a pool that's hours old, or a creator who can still print more tokens.",
    "💵 <b>i tell you how much i'd risk.</b> you set a weekly budget and i size each pick from it, smaller when the token looks risky or when your recent calls went bad.",
    "🧠 <b>i remember why you bought.</b> when a new token lands in your wallet i ask why, then later i tell you if that reason still holds.",
    "🔎 <b>ask me anything.</b> \"why shouldn't i buy $WIF?\", \"top 5 on solana\", \"find me low caps under 50k\", \"how much volume is on sui\". just talk normally, pidgin is fine too.",
    "🎯 <b>you set the rules.</b> say \"only send tokens under 100k mcap\", \"turn on launch alerts\" or \"only solana\" and i'll stick to it.",
    "",
    "to start, paste your <b>sui or solana wallet address</b>. i only read public data, i'll never ask for your keys or to sign anything.",
    "",
    "<i>nothing i say is financial advice. most new tokens go to zero, so only use money you can lose.</i>",
  ].join("\n");
}

/** A pasted Sui or Solana wallet address. */
function parseWallet(text: string): { chain: Chain; address: string } | null {
  const sui = parseSuiAddress(text);
  if (sui) return { chain: "sui", address: sui };
  const sol = parseSolanaAddress(text);
  if (sol) return { chain: "solana", address: sol };
  return null;
}

/**
 * "hey tide, top 5 on solana" or "what do you think of $WIF, tide?" call the bot by name.
 * Returns the message without the name, or null when it isn't talking to tide.
 * "the tide is turning" doesn't count: the name has to open the message (after an
 * optional greeting) or close it after a comma.
 */
export function calledByName(text: string): string | null {
  const start = /^\s*(?:(?:hey|hi|hello|yo|ok|okay|oya|abeg|sup|gm|so)[\s,]+)?tide\b[\s,:!.?-]*/i;
  if (start.test(text)) return text.replace(start, "").trim();
  const end = /,\s*tide\s*([?!.]*)\s*$/i;
  if (end.test(text)) return text.replace(end, "$1").trim();
  return null;
}

/** Looks like a question to the bot, not an answer to "why did you buy". */
const QUESTION =
  /\?\s*$|\$[A-Za-z]|::|^(what|how|why|should|is|are|can|could|do|does|did|when|which|who|where|tell me|show me|thoughts|rate|check|abeg|wetin|how far)\b/i;

function keyboard(buttons?: Button[][]): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    for (const b of row) (b.url ? kb.url(b.text, b.url) : kb.text(b.text, b.data));
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export interface BotOptions {
  adminIds: number[];
  runDoctor?: (wallets: { sui?: string | null; solana?: string | null }) => Promise<CheckResult[]>;
  companion?: Companion;
}

export function createBot(token: string, tide: Tide, opts: BotOptions): Bot {
  const { adminIds, runDoctor, companion } = opts;
  const bot = new Bot(token);
  const awaitingBudget = new Set<number>();
  // Updates run concurrently across chats; one chat's messages stay in order.
  bot.use(sequentialize((ctx: Context) => ctx.chat?.id.toString()));

  /** Run slow work without holding up this chat's next message. */
  const background = (ctx: Context, name: string, work: () => Promise<unknown>) => {
    void work().catch(async (err) => {
      log.error(`${name} failed`, err);
      await ctx.reply(`${name} broke: ${esc(err instanceof Error ? err.message : String(err))}`, { parse_mode: "HTML" }).catch(() => {});
    });
  };

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

  const inGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // In a group, answer as a reply to the message that asked, so the thread stays readable.
  const reply = (ctx: Context, html: string, buttons?: Button[][]) =>
    ctx.reply(html, {
      parse_mode: "HTML",
      reply_markup: keyboard(buttons),
      link_preview_options: { is_disabled: true },
      ...(inGroup(ctx) && ctx.message ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } } : {}),
    });

  const ensureUser = (ctx: Context) => {
    tide.setName(ctx.from!.id, ctx.from!.first_name);
    // Personal alerts always go to the private chat (its id is the user's id), never to a group.
    const existing = tide.store.getUser(ctx.from!.id);
    if (inGroup(ctx)) return existing ?? tide.start(ctx.from!.id, ctx.from!.id);
    return tide.start(ctx.from!.id, ctx.chat!.id);
  };
  const hey = (ctx: Context) => (ctx.from?.first_name ? `${esc(ctx.from.first_name.toLowerCase())}, ` : "");

  // ---- groups: answer when tagged or replied to; keep anything personal in private ----

  const username = () => bot.botInfo.username;
  const dmButton = (): Button[][] => [[{ text: "message me privately", data: "dm", url: `https://t.me/${username()}?start=hi` }]];
  const toPrivate = (ctx: Context) =>
    reply(ctx, `${hey(ctx)}let's do that in private, your wallet and bags shouldn't be out in a group.`, dmButton());
  const groupHello = (ctx: Context) =>
    reply(
      ctx,
      [
        "hey everyone, i'm <b>tide</b>. i watch sui and solana for tokens that start moving and read the red flags before anyone apes.",
        "",
        `call me by name, like <code>hey tide, thoughts on $WIF?</code> or <code>tide top 5 on solana</code>. tagging me or replying to my messages works too.`,
        "for alerts sized to your own budget and wallet, message me privately. nfa, always.",
      ].join("\n"),
      dmButton(),
    );
  const PERSONAL_COMMANDS = new Set(["wallet", "budget", "share", "holdings", "check", "scan", "alerts", "launches", "mcap", "pumped", "memory", "doctor", "backfill", "rebuild"]);

  bot.on("my_chat_member", async (ctx) => {
    const was = ctx.myChatMember.old_chat_member.status;
    const now = ctx.myChatMember.new_chat_member.status;
    if (inGroup(ctx) && (was === "left" || was === "kicked") && (now === "member" || now === "administrator")) {
      await groupHello(ctx).catch((err) => log.warn("group hello failed", err));
    }
  });

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (!inGroup(ctx) || !text?.startsWith("/")) return next();
    const [, name = "", target] = text.match(/^\/([a-z_]+)(?:@(\w+))?/i) ?? [];
    if (target && target.toLowerCase() !== username().toLowerCase()) return; // meant for another bot
    const cmd = name.toLowerCase();
    if (cmd === "start" || cmd === "help") return groupHello(ctx);
    if (PERSONAL_COMMANDS.has(cmd)) return toPrivate(ctx);
    return next();
  });

  async function groupText(ctx: Context & { message: { text: string } }) {
    const me = new RegExp(`@${username()}\\b`, "gi");
    const tagged = me.test(ctx.message.text);
    const repliedToMe = ctx.message.reply_to_message?.from?.id === bot.botInfo.id;
    const named = calledByName(ctx.message.text);
    if (!tagged && !repliedToMe && named === null) return;
    const text = (named ?? ctx.message.text).replace(me, "").trim();
    if (!text) return reply(ctx, `yes? ask me about any token, like <code>@${username()} thoughts on $WIF</code>, or <code>top 5 on solana</code>.`);

    const wallet = parseWallet(text);
    if (wallet && !(wallet.chain === "solana" && (await tide.isSolanaMint(wallet.address)))) return toPrivate(ctx);
    const intent = wallet ? null : parseIntent(text);
    if (intent?.action === "top") return act.top(ctx, intent.chains);
    if (intent?.action === "lowCaps") return act.lowCaps(ctx, intent.chains, intent.maxCap);
    if (intent?.action === "chainVolume") return act.chainVolume(ctx, intent.chains);
    if (intent?.action === "help") return groupHello(ctx);
    if (intent) return toPrivate(ctx);

    if (companion?.enabled) {
      const typing = () => ctx.replyWithChatAction("typing").catch(() => {});
      void typing();
      const keepTyping = setInterval(typing, 4_500);
      const answer = await companion
        .replyInGroup(ctx.chat!.id, ctx.from?.first_name, text)
        .catch((err) => {
          log.warn("group chat failed", err);
          return null;
        })
        .finally(() => clearInterval(keepTyping));
      if (answer) return reply(ctx, toTelegramHtml(answer));
    }
    return reply(ctx, `i can read any token or list the top ones here, try <code>@${username()} top 5 on solana</code>. for your wallet and alerts, message me privately.`, dmButton());
  }

  async function saveWallet(ctx: Context, address: string, chain: Chain) {
    const userId = ctx.from!.id;
    if (!tide.chains.includes(chain)) return reply(ctx, `i'm not watching ${CHAIN_LABEL[chain]} right now, sorry.`);
    await reply(ctx, `one sec, reading your ${CHAIN_LABEL[chain]} wallet <code>${shortAddress(address)}</code>…`);
    try {
      const { liquidUsd, proposedBudget } = await tide.setWallet(userId, address, chain);
      const other: Chain = chain === "sui" ? "solana" : "sui";
      const user = tide.store.getUser(userId);
      const hasOther = other === "sui" ? !!user?.wallet : !!user?.solWallet;
      const otherHint = !hasOther && tide.chains.includes(other) ? `
you can paste a ${CHAIN_LABEL[other]} wallet too, i'll watch both.` : "";
      await reply(
        ctx,
        [
          `got it, i'll remember this ${CHAIN_LABEL[chain]} wallet so you never have to send it again.${otherHint}`,
          `across your wallets you've got about <b>${usd(liquidUsd)}</b> in cash (sui, sol and stablecoins).`,
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
    const watching = [user.wallet && `sui <code>${shortAddress(user.wallet)}</code>`, user.solWallet && `solana <code>${shortAddress(user.solWallet)}</code>`]
      .filter(Boolean)
      .join(" and ");
    if (watching) {
      await reply(ctx, `${hey(ctx) || "hey, "}welcome back. still watching ${watching} for you.\n\n${HELP}`);
      return;
    }
    await reply(ctx, welcome(ctx.from?.first_name));
  });

  // ---- actions, shared by slash commands and plain-language requests ----

  const act = {
    help: (ctx: Context) => reply(ctx, HELP),

    budget: async (ctx: Context, amount: number | null) => {
      if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        awaitingBudget.add(ctx.from!.id);
        return reply(ctx, "how much are you happy to risk a week, in usd? just the number, like <code>30</code>.");
      }
      tide.setBudget(ctx.from!.id, amount);
      return reply(ctx, `done, your weekly budget is <b>${usd(amount)}</b>.`);
    },

    share: (ctx: Context, p: number) => {
      if (!Number.isFinite(p) || p < 5 || p > 50) return reply(ctx, "pick something between 5 and 50, like /share <code>25</code>.");
      tide.setBaseShare(ctx.from!.id, p / 100);
      return reply(ctx, `okay, each alert now starts from <b>${p}%</b> of what's left in your week.`);
    },

    holdings: async (ctx: Context) => reply(ctx, await tide.holdingsReport(ctx.from!.id)),

    check: async (ctx: Context) => {
      const user = tide.store.getUser(ctx.from!.id)!;
      if (!user.wallet && !user.solWallet) return reply(ctx, "i need a wallet first, paste your sui or solana address here.");
      const found = await tide.checkWallet(user).catch((err) => {
        log.error("check failed", err);
        return -1;
      });
      if (found < 0) return reply(ctx, "couldn't read your wallet just now. give it a minute and try again.");
      if (found === 0) return reply(ctx, "nothing new since i last looked.");
    },

    scan: async (ctx: Context) => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      background(ctx, "scan", async () => {
        const n = await tide.scan().catch((err) => {
          log.error("scan failed", err);
          return -1;
        });
        if (n < 0) await reply(ctx, "the market data is being slow right now. try me again in a bit.");
        else if (n === 0) await reply(ctx, `nothing's really moving on ${tide.chains.map((c) => CHAIN_LABEL[c]).join(" or ")} right now. i'll keep an eye out.`);
      });
    },

    top: async (ctx: Context, chains?: Chain[], fresh = false) => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      background(ctx, "top", async () => {
        const lists = await tide.topTokens(chains?.length ? chains : tide.chains, 5, fresh);
        const body = lists.map((l) => (l.error ? `couldn't load ${CHAIN_LABEL[l.chain]} right now.` : topList(l.chain, l.pools, fresh))).join("\n\n");
        await reply(ctx, `${body}\n\nbig volume isn't the same as safe. ask me about any of these and i'll give you the red flags. nfa.`);
      });
    },

    alerts: (ctx: Context, on: boolean) => {
      tide.setAlerts(ctx.from!.id, on);
      return reply(ctx, on ? "alerts are back on." : "okay, i'll stay quiet. tell me when you want alerts back.");
    },

    alertChains: (ctx: Context, chains: Chain[]) => {
      tide.setAlertChains(ctx.from!.id, chains);
      return reply(
        ctx,
        chains.length >= 2 ? "you'll hear about sui and solana." : `okay, only ${CHAIN_LABEL[chains[0]!]} alerts from now on. say "both chains" any time to hear about everything.`,
      );
    },

    unmute: (ctx: Context) => {
      tide.unmuteAll(ctx.from!.id);
      return reply(ctx, "unmuted everything, you'll hear about all token types again.");
    },

    launches: (ctx: Context, on: boolean) => {
      tide.setLaunches(ctx.from!.id, on);
      return reply(
        ctx,
        on
          ? "done, launch alerts are on. i'll ping you when a new token launches on sui or solana and already has real liquidity and buyers, a few a day at most. these are the riskiest thing i send, most go to zero, so treat every one as money you can lose. say \"stop launch alerts\" any time."
          : "launch alerts are off. you'll still get the usual ones when something starts moving.",
      );
    },

    memory: (ctx: Context) => reply(ctx, tide.memoryReport(ctx.from!.id)),

    mcap: (ctx: Context, range: { min?: number | null; max?: number | null }) => {
      const f = tide.setMcap(ctx.from!.id, range);
      if (f.mcapMin === null && f.mcapMax === null) return reply(ctx, "no market cap limit now, any size can come through.");
      const low = (f.mcapMax ?? Infinity) <= 250_000;
      return reply(
        ctx,
        `got it, i'll only send tokens with a market cap ${describeCapRange(f, usd)}.${low ? " small caps are where most rugs happen, so expect more red flags and smaller sizes from me." : ""} say "any market cap" to clear it.`,
      );
    },

    pump: (ctx: Context, pct: number | null) => {
      tide.setPumpLimit(ctx.from!.id, pct);
      return reply(
        ctx,
        pct === null
          ? "okay, tokens that already ran can come through again."
          : `okay, i'll skip anything already up more than ${pct}% in the last 24h (for a brand-new pool that's since launch). say "allow pumped tokens" to turn it off.`,
      );
    },

    lowCaps: async (ctx: Context, chains?: Chain[], maxCap = 100_000) => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      background(ctx, "lowcaps", async () => {
        const lists = await tide.lowCaps(chains?.length ? chains : tide.chains, maxCap);
        const label = (p: Pool) => assessRisk(p).label;
        const body = lists.map((l) => (l.error ? `couldn't load ${CHAIN_LABEL[l.chain]} right now.` : lowCapList(l.chain, l.pools, maxCap, label))).join("\n\n");
        await reply(ctx, `${body}\n\nmost tokens this small go to zero. ask me about any of these for the red flags before you touch it. nfa.`);
      });
    },

    chainVolume: async (ctx: Context, chains?: Chain[]) => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      background(ctx, "volume", async () => {
        const rows = await tide.chainVolume(chains?.length ? chains : tide.chains);
        await reply(ctx, rows.map(chainVolumeLine).join("\n\n"));
      });
    },
  };

  /** Run a plain-language request. */
  const runIntent = (ctx: Context, i: Intent) => {
    switch (i.action) {
      case "launches":
        return act.launches(ctx, i.on);
      case "alerts":
        return act.alerts(ctx, i.on);
      case "alertChains":
        return act.alertChains(ctx, i.chains);
      case "unmute":
        return act.unmute(ctx);
      case "budget":
        return act.budget(ctx, i.amount);
      case "share":
        return act.share(ctx, i.percent);
      case "holdings":
        return act.holdings(ctx);
      case "check":
        return act.check(ctx);
      case "scan":
        return act.scan(ctx);
      case "top":
        return act.top(ctx, i.chains);
      case "memory":
        return act.memory(ctx);
      case "help":
        return act.help(ctx);
      case "mcap":
        return act.mcap(ctx, { min: i.min, max: i.max });
      case "pump":
        return act.pump(ctx, i.pct);
      case "lowCaps":
        return act.lowCaps(ctx, i.chains, i.maxCap);
      case "chainVolume":
        return act.chainVolume(ctx, i.chains);
    }
  };

  // ---- slash commands ----

  bot.command("help", (ctx) => act.help(ctx));

  bot.command("wallet", async (ctx) => {
    ensureUser(ctx);
    const w = parseWallet(ctx.match ?? "");
    if (!w) return reply(ctx, "send it like this: /wallet followed by your sui (0x…) or solana address.");
    await saveWallet(ctx, w.address, w.chain);
  });

  bot.command("budget", (ctx) => {
    ensureUser(ctx);
    const raw = (ctx.match ?? "").replace(/[$,\s]/g, "");
    return act.budget(ctx, raw ? Number(raw) : null);
  });

  bot.command("share", (ctx) => {
    ensureUser(ctx);
    return act.share(ctx, Number((ctx.match ?? "").replace(/[%\s]/g, "")));
  });

  bot.command("holdings", (ctx) => (ensureUser(ctx), act.holdings(ctx)));
  bot.command("check", (ctx) => (ensureUser(ctx), act.check(ctx)));
  bot.command("scan", (ctx) => (ensureUser(ctx), act.scan(ctx)));
  bot.command("memory", (ctx) => (ensureUser(ctx), act.memory(ctx)));

  bot.command("top", (ctx) => {
    ensureUser(ctx);
    const args = (ctx.match ?? "").trim().toLowerCase().split(/\s+/);
    const chains = args.filter((a): a is Chain => a === "sui" || a === "solana");
    const fresh = args.some((a) => a === "new" || a === "24h" || a === "fresh");
    return act.top(ctx, chains.length ? chains : undefined, fresh);
  });

  bot.command("mcap", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (!arg) {
      const f = tide.filtersFor(ctx.from!.id);
      return reply(ctx, `right now i send tokens with a market cap ${describeCapRange(f, usd)}. set it like <code>/mcap 100k</code>, <code>/mcap 20k-150k</code> or <code>/mcap off</code>.`);
    }
    if (arg === "off" || arg === "any") return act.mcap(ctx, { min: null, max: null });
    const n = amounts(arg);
    if (n.length >= 2) return act.mcap(ctx, { min: Math.min(n[0]!, n[1]!), max: Math.max(n[0]!, n[1]!) });
    if (n.length === 1) return act.mcap(ctx, { min: null, max: n[0]! });
    return reply(ctx, "send it like <code>/mcap 100k</code> or <code>/mcap 20k-150k</code>.");
  });

  bot.command("pumped", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off" || arg === "allow") return act.pump(ctx, null);
    const n = Number(arg.replace("%", ""));
    if (arg && Number.isFinite(n) && n > 0) return act.pump(ctx, n);
    const f = tide.filtersFor(ctx.from!.id);
    return reply(ctx, `${f.maxPumpPct === null ? "i'm not skipping pumped tokens right now." : `i skip anything already up more than ${f.maxPumpPct}% in 24h.`} change it with <code>/pumped 200</code> or <code>/pumped off</code>.`);
  });

  bot.command("lowcaps", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").toLowerCase();
    const chains = (["sui", "solana"] as const).filter((c) => arg.includes(c));
    const cap = amounts(arg).find((n) => n >= 1_000);
    return act.lowCaps(ctx, chains.length ? [...chains] : undefined, cap);
  });

  bot.command("volume", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").toLowerCase();
    const chains = (["sui", "solana"] as const).filter((c) => arg.includes(c));
    return act.chainVolume(ctx, chains.length ? [...chains] : undefined);
  });

  bot.command("alerts", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off" || arg === "on") return act.alerts(ctx, arg === "on");
    if (arg === "reset") return act.unmute(ctx);
    if (arg === "sui" || arg === "solana") return act.alertChains(ctx, [arg]);
    if (arg === "both") return act.alertChains(ctx, ["sui", "solana"]);
    return reply(ctx, "use /alerts on, off, reset, or sui, solana, both.");
  });

  bot.command("launches", (ctx) => {
    ensureUser(ctx);
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "on" || arg === "off") return act.launches(ctx, arg === "on");
    const on = tide.store.getPref(ctx.from!.id, "launches") === "true";
    return reply(ctx, `launch alerts are ${on ? "on" : "off"}. say "turn on launch alerts" or "turn them off".`);
  });

  bot.command("doctor", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) {
      return reply(ctx, `only the admin can run checks. your telegram id is <code>${ctx.from!.id}</code>.`);
    }
    if (!runDoctor) return reply(ctx, "checks aren't available in this build.");
    await reply(ctx, "running checks, takes up to a minute. keep chatting meanwhile.");
    const user = tide.store.getUser(ctx.from!.id);
    background(ctx, "doctor", async () => {
      const [results, ai] = await Promise.all([
        runDoctor({ sui: user?.wallet, solana: user?.solWallet }),
        companion
          ? withTimeout(companion.ping(), 30_000, "ai check").then(
              (d) => `✅ <b>AI chat</b>: ${esc(d)}`,
              (e) => `${companion.enabled ? "❌" : "⚪"} <b>AI chat</b>: ${esc(e instanceof Error ? e.message : String(e))}`,
            )
          : Promise.resolve(null),
      ]);
      const lines = results.map((r) => `${r.ok ? "✅" : "❌"} <b>${esc(r.name)}</b>: ${esc(r.detail)}`);
      if (ai) lines.push(ai);
      lines.push(`📦 <b>Storage</b>: ${esc(tide.storageReport())}`);
      await reply(ctx, lines.join("\n"));
    });
  });

  bot.command("backfill", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) return reply(ctx, "only the admin can run a backfill.");
    await reply(ctx, "going back over the last week of sui and solana prices to see how signals like mine played out. takes a few minutes, i'll report back.");
    background(ctx, "backfill", async () => {
      const summary = await tide.backfill();
      const lines = summary.map((s) =>
        s.outcomes
          ? `${CHAIN_LABEL[s.chain]}: ${s.outcomes} signals across ${s.pools} tokens, ${Math.round((s.up / s.outcomes) * 100)}% were up a day later`
          : `${CHAIN_LABEL[s.chain]}: nothing to learn from right now`,
      );
      await reply(ctx, ["<b>done, here's how last week's signals played out</b>", ...lines, "", "new people now start from this instead of from zero."].join("\n"));
    });
  });

  bot.command("rebuild", async (ctx) => {
    if (!adminIds.includes(ctx.from!.id)) return reply(ctx, "only the admin can run a rebuild.");
    await reply(ctx, "forgetting everything locally and restoring it from my long-term memory…");
    try {
      const ids = tide.store.usersWithWallets().map((u) => u.id);
      if (!ids.includes(ctx.from!.id)) ids.push(ctx.from!.id);
      const counts = await tide.memory.rebuild(ids);
      const mine = counts[`tide-user-${ctx.from!.id}`] ?? 0;
      const market = counts["tide-tokens"] ?? 0;
      const others = Object.entries(counts).filter(([ns]) => ns !== "tide-tokens" && ns !== `tide-user-${ctx.from!.id}`).length;
      await reply(
        ctx,
        `<b>restored.</b> ${mine} things about you, ${market} market results${others ? ` and ${others} other people` : ""} came back. ask me what i remember to check.`,
      );
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
    if (inGroup(ctx)) return groupText(ctx);
    const user = ensureUser(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (awaitingBudget.has(user.id)) {
      const said = parseIntent(text);
      const amount = said?.action === "budget" ? said.amount : Number(text.replace(/[$,\s]|usd|dollars?/gi, ""));
      if (Number.isFinite(amount) && amount > 0) {
        awaitingBudget.delete(user.id);
        tide.setBudget(user.id, amount);
        return reply(ctx, `done, your weekly budget is <b>${usd(amount)}</b>.`);
      }
      if (!QUESTION.test(text)) return reply(ctx, "just the number is fine, like <code>30</code>.");
      awaitingBudget.delete(user.id);
    }

    const wallet = parseWallet(text);
    // A pasted Solana token address is a question about that token, not a wallet.
    if (wallet && !(wallet.chain === "solana" && (await tide.isSolanaMint(wallet.address)))) {
      return saveWallet(ctx, wallet.address, wallet.chain);
    }

    // Plain-language requests ("turn on launch alerts", "set my budget to 50") run for real.
    const intent = wallet ? null : parseIntent(text);
    if (intent) return runIntent(ctx, intent);

    // An unanswered "why did you buy" takes this message, unless it's clearly a question.
    if (!wallet && !QUESTION.test(text)) {
      const symbol = tide.answerReason(user.id, text);
      if (symbol) {
        await reply(ctx, `got it. i'll check <b>${esc(symbol)}</b> against that every morning, and tell you if it stops being true.`);
        await tide.askNextReason(user);
        return;
      }
    }

    if (companion?.enabled) {
      // Telegram's typing indicator lasts ~5s; keep it up while lookups and the model run.
      const typing = () => ctx.replyWithChatAction("typing").catch(() => {});
      void typing();
      const keepTyping = setInterval(typing, 4_500);
      const answer = await companion
        .reply(user.id, ctx.from.first_name, text)
        .catch((err) => {
          log.warn("chat failed", err);
          return null;
        })
        .finally(() => clearInterval(keepTyping));
      if (answer) return reply(ctx, toTelegramHtml(answer));
    }

    await reply(
      ctx,
      user.wallet || user.solWallet
        ? `${hey(ctx)}i'm better with commands right now. try /holdings, /scan or /help.`
        : "paste your sui or solana wallet address and we'll get started.",
    );
  });

  bot.catch((err) => log.error("bot error", err.error));
  return bot;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
}
