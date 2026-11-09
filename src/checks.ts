import { delegateKeyToPublicKey } from "@mysten-incubation/memwal";
import { Bot } from "grammy";
import { SolanaReader } from "./chain/solana.js";
import { SuiReader } from "./chain/sui.js";
import type { Config } from "./config.js";
import { Market } from "./market/gecko.js";
import { Store } from "./memory/store.js";
import { Memory } from "./memory/walrus.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Explains a Walrus 401: which public key the private key maps to, and what the account ID really is on Sui. */
async function describeCredentials(privateKey: string, accountId: string, sui: SuiReader): Promise<string> {
  const lines = [`Account ID in use: ${accountId}`];
  try {
    const type = await sui.objectType(accountId);
    if (type === null) {
      lines.push("On Sui, no object has that ID. It's probably a wallet address, not the account object ID.");
    } else if (/memwal|account/i.test(type)) {
      lines.push(`On Sui it's a ${shortType(type)} object, so the account ID looks right.`);
    } else {
      lines.push(`On Sui it's a ${shortType(type)} object, which doesn't look like a Walrus Memory account.`);
    }
  } catch (err) {
    lines.push(`Couldn't look the account ID up on Sui: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const pub = await delegateKeyToPublicKey(privateKey);
    lines.push(`Public key from your MEMWAL_PRIVATE_KEY: ${Buffer.from(pub).toString("hex")}`);
    lines.push("That public key must appear under Delegate keys for this account on memory.walrus.xyz.");
  } catch (err) {
    lines.push(`MEMWAL_PRIVATE_KEY can't be read as a key: ${err instanceof Error ? err.message : err}`);
  }
  return lines.join("\n");
}

function shortType(type: string): string {
  const [addr, ...rest] = type.split("::");
  return [addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr, ...rest].join("::");
}

const SAMPLE_WALLET = "0x0000000000000000000000000000000000000000000000000000000000000005";
/** A long-lived Solana account (the vote program) to read when the admin has no Solana wallet set. */
const SAMPLE_SOLANA_WALLET = "Vote111111111111111111111111111111111111111";

const CHECK_TIMEOUT_MS = 40_000;

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error(`no answer after ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS)),
    ]);
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface CheckDeps {
  /** Reuse the running bot's market client so checks share its rate limiting. */
  market?: Market;
}

/** Tests every outside connection with the configured keys, including one real Walrus write. */
export async function runChecks(
  cfg: Config,
  wallets: { sui?: string | null; solana?: string | null } = {},
  deps: CheckDeps = {},
): Promise<CheckResult[]> {
  const wallet = wallets.sui ?? SAMPLE_WALLET;
  const solWallet = wallets.solana ?? SAMPLE_SOLANA_WALLET;
  const sui = new SuiReader(cfg.TATUM_SUI_GRPC_URL, cfg.TATUM_API_KEY, cfg.TATUM_SUI_RPC_URL);
  const market = deps.market ?? new Market(cfg.GECKOTERMINAL_BASE_URL);
  return [
    await check("Telegram", async () => {
      const me = await new Bot(cfg.TELEGRAM_BOT_TOKEN).api.getMe();
      return `@${me.username}`;
    }),
    await check("Tatum Sui gRPC", async () => {
      if (!cfg.TATUM_API_KEY) throw new Error("TATUM_API_KEY is empty");
      const b = await sui.balances(wallet);
      return `${b.length} balances read for ${wallet.slice(0, 10)}… via ${sui.lastTransport}`;
    }),
    ...(cfg.CHAINS.includes("solana")
      ? [
          await check("Solana RPC", async () => {
            if (!cfg.TATUM_API_KEY) throw new Error("TATUM_API_KEY is empty");
            const fallback = cfg.SOLANA_FALLBACK_RPC_URL === "none" ? null : cfg.SOLANA_FALLBACK_RPC_URL;
            const reader = new SolanaReader(cfg.TATUM_SOLANA_RPC_URL, cfg.TATUM_API_KEY, undefined, fallback);
            const b = await reader.balances(solWallet);
            return `${b.length} balances read for ${solWallet.slice(0, 8)}… (${reader.describeSources()})`;
          }),
        ]
      : []),
    await check("GeckoTerminal", async () => {
      const n = await market.ping(cfg.CHAINS[0]);
      if (n < 0) return "reachable, rate limited for a moment (tide waits and retries on its own)";
      const busy = market.queued ? `, ${market.queued} calls queued behind a scan or backfill` : "";
      return `${n} trending ${cfg.CHAINS[0]} pools${busy}`;
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
      if (row.status !== "confirmed") {
        // Show only the public half of the key, so it can be compared with the dashboard.
        const ids = await describeCredentials(cfg.MEMWAL_PRIVATE_KEY, cfg.MEMWAL_ACCOUNT_ID, sui);
        throw new Error(`test write ${row.status}: ${row.error ?? "unknown error"}\n${ids}`);
      }
      return "test write confirmed on Mainnet";
    }),
  ];
}
