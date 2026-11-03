/**
 * npm run doctor — checks every outside connection with your real keys.
 * Run it once after filling in .env, before starting the bot.
 */
import { Bot } from "grammy";
import { SuiReader } from "./chain/sui.js";
import { loadConfig } from "./config.js";
import { SUI_COIN_TYPE } from "./core/buys.js";
import { detectSpike } from "./core/spike.js";
import { Market } from "./market/gecko.js";
import { Store } from "./memory/store.js";
import { Memory } from "./memory/walrus.js";

const SAMPLE_WALLET = process.argv[2] ?? "0x0000000000000000000000000000000000000000000000000000000000000005";

async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`✔ ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    console.log(`✘ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const cfg = loadConfig();
  const results = [
    await check("Telegram", async () => {
      const me = await new Bot(cfg.TELEGRAM_BOT_TOKEN).api.getMe();
      return `@${me.username}`;
    }),
    await check("Tatum Sui gRPC", async () => {
      if (!cfg.TATUM_API_KEY) throw new Error("TATUM_API_KEY is empty");
      const b = await new SuiReader(cfg.TATUM_SUI_GRPC_URL, cfg.TATUM_API_KEY).balances(SAMPLE_WALLET);
      return `${b.length} balances read for ${SAMPLE_WALLET.slice(0, 10)}…`;
    }),
    await check("GeckoTerminal", async () => {
      const m = new Market(cfg.GECKOTERMINAL_BASE_URL);
      const pools = await m.candidatePools();
      const spikes = pools.filter((p) => detectSpike(p)).length;
      const sui = await m.quote(SUI_COIN_TYPE);
      return `${pools.length} Sui pools, ${spikes} spiking now, SUI at $${sui?.priceUsd.toFixed(3) ?? "?"}`;
    }),
    await check("Walrus Memory", async () => {
      const store = new Store(":memory:");
      const memory = new Memory(store, {
        privateKey: cfg.MEMWAL_PRIVATE_KEY,
        accountId: cfg.MEMWAL_ACCOUNT_ID,
        serverUrl: cfg.MEMWAL_SERVER_URL,
        dryRun: cfg.MEMWAL_DRY_RUN,
      });
      const health = await memory.health();
      if (memory.isDryRun) return health;
      memory.record(null, { type: "preference", key: "doctor_check", value: new Date().toISOString() });
      await memory.flush();
      const s = store.memoryStats();
      if (s.failed) throw new Error("test write failed, see the warning above");
      return `${health}; test write confirmed on Mainnet`;
    }),
  ];
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
