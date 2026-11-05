import { Bot } from "grammy";
import { SuiReader } from "./chain/sui.js";
import type { Config } from "./config.js";
import { SUI_COIN_TYPE } from "./core/buys.js";
import { detectSpike } from "./core/spike.js";
import { Market } from "./market/gecko.js";
import { Store } from "./memory/store.js";
import { Memory } from "./memory/walrus.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const SAMPLE_WALLET = "0x0000000000000000000000000000000000000000000000000000000000000005";

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Tests every outside connection with the configured keys, including one real Walrus write. */
export async function runChecks(cfg: Config, wallet: string = SAMPLE_WALLET): Promise<CheckResult[]> {
  return [
    await check("Telegram", async () => {
      const me = await new Bot(cfg.TELEGRAM_BOT_TOKEN).api.getMe();
      return `@${me.username}`;
    }),
    await check("Tatum Sui gRPC", async () => {
      if (!cfg.TATUM_API_KEY) throw new Error("TATUM_API_KEY is empty");
      const b = await new SuiReader(cfg.TATUM_SUI_GRPC_URL, cfg.TATUM_API_KEY).balances(wallet);
      return `${b.length} balances read for ${wallet.slice(0, 10)}…`;
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
      const row = store.db.prepare("SELECT status, error FROM memory_log").get() as { status: string; error: string | null };
      if (row.status !== "confirmed") throw new Error(`test write ${row.status}: ${row.error ?? "unknown error"}`);
      return "test write confirmed on Mainnet";
    }),
  ];
}
