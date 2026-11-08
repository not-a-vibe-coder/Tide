import { createServer } from "node:http";
import { run, type RunnerHandle } from "@grammyjs/runner";
import cron from "node-cron";
import { Companion } from "./ai/companion.js";
import { Llm } from "./ai/llm.js";
import { createBot } from "./bot/bot.js";
import { runChecks } from "./checks.js";
import { SolanaReader } from "./chain/solana.js";
import { SuiReader } from "./chain/sui.js";
import { loadConfig } from "./config.js";
import { DEFAULT_SPIKE_RULES } from "./core/spike.js";
import { log } from "./log.js";
import { Market } from "./market/gecko.js";
import { Store } from "./memory/store.js";
import { Memory } from "./memory/walrus.js";
import { Tide, type ChainRules, type Readers } from "./tide.js";

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DATABASE_PATH);
  const memory = new Memory(store, {
    privateKey: cfg.MEMWAL_PRIVATE_KEY,
    accountId: cfg.MEMWAL_ACCOUNT_ID,
    serverUrl: cfg.MEMWAL_SERVER_URL,
    dryRun: cfg.MEMWAL_DRY_RUN,
  });
  const market = new Market(cfg.GECKOTERMINAL_BASE_URL);
  const readers: Readers = {};
  const rules: ChainRules = {};
  if (cfg.CHAINS.includes("sui")) {
    readers.sui = new SuiReader(cfg.TATUM_SUI_GRPC_URL, cfg.TATUM_API_KEY, cfg.TATUM_SUI_RPC_URL);
    rules.sui = { ...DEFAULT_SPIKE_RULES, minLiquidityUsd: cfg.MIN_LIQUIDITY_USD, minHourlyVolumeUsd: cfg.MIN_HOURLY_VOLUME_USD };
  }
  if (cfg.CHAINS.includes("solana")) {
    const fallback = cfg.SOLANA_FALLBACK_RPC_URL === "none" ? null : cfg.SOLANA_FALLBACK_RPC_URL;
    readers.solana = new SolanaReader(cfg.TATUM_SOLANA_RPC_URL, cfg.TATUM_API_KEY, (mint) => market.symbol(mint), fallback);
    rules.solana = {
      ...DEFAULT_SPIKE_RULES,
      minLiquidityUsd: cfg.SOLANA_MIN_LIQUIDITY_USD,
      minHourlyVolumeUsd: cfg.SOLANA_MIN_HOURLY_VOLUME_USD,
    };
  }
  const tide = new Tide(store, memory, readers, market, rules);
  tide.alertGapMs = cfg.ALERT_GAP_MINUTES * 60_000;
  log.info(`chains: ${tide.chains.join(", ")}`);

  log.info("Walrus Memory:", await memory.health().catch((e) => `unreachable (${e.message})`));

  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const llm = new Llm({
    groqKey: cfg.GROQ_API_KEY,
    geminiKey: cfg.GEMINI_API_KEY,
    groqModels: list(cfg.GROQ_MODELS),
    geminiModels: list(cfg.GEMINI_MODELS),
  });
  const companion = new Companion(llm, store, memory, market, tide, cfg.CREATOR);
  log.info(`AI chat: ${llm.enabled ? llm.providers.map((p) => `${p.name}/${p.model}`).join(" → ") : "off (templates only)"}`);

  const bot = createBot(cfg.TELEGRAM_BOT_TOKEN, tide, {
    adminIds: cfg.ADMIN_TELEGRAM_IDS,
    runDoctor: (wallets) => runChecks(cfg, wallets, { market }),
    companion,
  });
  await bot.api.setMyCommands([
    { command: "start", description: "start, or see what i'm watching" },
    { command: "holdings", description: "your bags and how they're doing" },
    { command: "scan", description: "anything moving on sui or solana" },
    { command: "top", description: "top 5 on sui and solana by volume" },
    { command: "check", description: "look for new buys in your wallets" },
    { command: "budget", description: "how much you'll risk a week" },
    { command: "alerts", description: "pause me, or pick sui, solana or both" },
    { command: "launches", description: "ping me on brand-new token launches" },
    { command: "memory", description: "what i remember about you" },
    { command: "help", description: "everything i can do" },
  ]);

  const guard = (name: string, fn: () => Promise<unknown>) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        log.warn(`${name} failed:`, err instanceof Error ? err.message : err);
      } finally {
        running = false;
      }
    };
  };

  const tz = { timezone: "Africa/Lagos" };
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, guard("scan", () => tide.scan()), tz);
  cron.schedule(
    `*/${cfg.WALLET_CHECK_INTERVAL_MINUTES} * * * *`,
    guard("wallets", async () => {
      for (const u of store.usersWithWallets()) await tide.checkWallet(u);
    }),
    tz,
  );
  cron.schedule("7 * * * *", guard("outcomes", () => tide.resolveOutcomes()), tz);
  cron.schedule("*/30 * * * *", guard("memory retry", async () => memory.retryFailed()), tz);
  cron.schedule(`0 ${cfg.DIGEST_HOUR_LAGOS} * * *`, guard("digest", () => tide.sendDigests()), tz);

  // Learn from market history: once a day, and a minute after startup if shared memory is thin.
  const backfill = guard("backfill", async () => {
    const summary = await tide.backfill();
    log.info(`backfill: ${summary.map((s) => `${s.chain} ${s.pools} pools → ${s.outcomes} outcomes (${s.up} up)`).join(", ")}`);
  });
  cron.schedule("17 4 * * *", backfill, tz);
  // Render's free plan wipes the disk on every deploy: pull users back from Walrus first,
  // then backfill history only if shared memory is still thin.
  void (async () => {
    try {
      const restored = await tide.restore(cfg.ADMIN_TELEGRAM_IDS);
      if (restored) log.info(`restored ${restored} users from Walrus Memory`);
    } catch (err) {
      log.warn("restore from Walrus failed:", err instanceof Error ? err.message : err);
    }
    const shared = store.outcomeSources();
    if (shared.history + shared.live < 20) setTimeout(backfill, 60_000);
  })();

  let runner: RunnerHandle | undefined;
  const stop = async () => {
    log.info("shutting down, finishing Walrus writes…");
    if (runner?.isRunning()) await runner.stop();
    await memory.flush();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // Hosts like Render's free web service need an open port and incoming traffic
  // to stay awake. Only starts when PORT is set, so local runs are unaffected.
  if (process.env.PORT) {
    const startedAt = new Date().toISOString();
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "tide", startedAt, memory: store.memoryStats() }));
    }).listen(Number(process.env.PORT), "0.0.0.0", () => log.info(`health endpoint on :${process.env.PORT}`));

    // Render's free plan sleeps after 15 minutes without inbound traffic, and
    // Telegram polling is outbound, so the bot pings its own public URL every
    // 10 minutes (the same trick Jasmine uses). Render sets RENDER_EXTERNAL_URL.
    const selfUrl = process.env.KEEP_AWAKE_URL ?? process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) {
      const ping = () =>
        fetch(selfUrl, { signal: AbortSignal.timeout(30_000) })
          .then((r) => log.debug(`keep-awake ping ${r.status}`))
          .catch((e) => log.warn(`keep-awake ping failed: ${e instanceof Error ? e.message : e}`));
      setInterval(ping, 10 * 60_000);
      log.info(`keeping awake by pinging ${selfUrl} every 10 minutes`);
    }
  }

  log.info("Tide is running");
  // Concurrent runner: a slow reply for one person never holds up anyone else.
  // Messages sent while Render restarts are kept and answered on startup.
  await bot.init();
  runner = run(bot);
  log.info(`polling as @${bot.botInfo.username}`);
  await runner.task();
}

// A dropped socket inside a network library shouldn't take the bot down.
const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code && NETWORK_CODES.has(err.code)) {
    log.warn(`network error ignored: ${err.code} ${err.message}`);
    return;
  }
  log.error("fatal", err);
  process.exit(1);
});

main().catch((err) => {
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
