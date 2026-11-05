import { createServer } from "node:http";
import cron from "node-cron";
import { Companion } from "./ai/companion.js";
import { Llm } from "./ai/llm.js";
import { createBot } from "./bot/bot.js";
import { runChecks } from "./checks.js";
import { SuiReader } from "./chain/sui.js";
import { loadConfig } from "./config.js";
import { DEFAULT_SPIKE_RULES } from "./core/spike.js";
import { log } from "./log.js";
import { Market } from "./market/gecko.js";
import { Store } from "./memory/store.js";
import { Memory } from "./memory/walrus.js";
import { Tide } from "./tide.js";

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.DATABASE_PATH);
  const memory = new Memory(store, {
    privateKey: cfg.MEMWAL_PRIVATE_KEY,
    accountId: cfg.MEMWAL_ACCOUNT_ID,
    serverUrl: cfg.MEMWAL_SERVER_URL,
    dryRun: cfg.MEMWAL_DRY_RUN,
  });
  const sui = new SuiReader(cfg.TATUM_SUI_GRPC_URL, cfg.TATUM_API_KEY, cfg.TATUM_SUI_RPC_URL);
  const market = new Market(cfg.GECKOTERMINAL_BASE_URL);
  const tide = new Tide(store, memory, sui, market, {
    ...DEFAULT_SPIKE_RULES,
    minLiquidityUsd: cfg.MIN_LIQUIDITY_USD,
    minHourlyVolumeUsd: cfg.MIN_HOURLY_VOLUME_USD,
  });

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
    runDoctor: (wallet) => runChecks(cfg, wallet, { market }),
    companion,
  });
  await bot.api.setMyCommands([
    { command: "start", description: "Start or see your status" },
    { command: "holdings", description: "Your positions and P&L" },
    { command: "scan", description: "Scan Sui for spikes now" },
    { command: "check", description: "Check your wallet for new buys" },
    { command: "budget", description: "Set your weekly budget" },
    { command: "memory", description: "What Tide remembers about you" },
    { command: "help", description: "All commands" },
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
  cron.schedule(`0 ${cfg.DIGEST_HOUR_LAGOS} * * *`, guard("digest", () => tide.sendDigests()), tz);

  const stop = async () => {
    log.info("shutting down, finishing Walrus writes…");
    await bot.stop();
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
  }

  log.info("Tide is running");
  await bot.start({ drop_pending_updates: true });
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
