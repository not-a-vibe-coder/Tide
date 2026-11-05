import "dotenv/config";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ADMIN_TELEGRAM_IDS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),

  MEMWAL_PRIVATE_KEY: z.string().optional().default(""),
  MEMWAL_ACCOUNT_ID: z.string().optional().default(""),
  MEMWAL_SERVER_URL: z.string().url().default("https://relayer.memory.walrus.xyz"),
  MEMWAL_DRY_RUN: bool,

  TATUM_API_KEY: z.string().optional().default(""),
  TATUM_SUI_GRPC_URL: z.string().url().default("https://sui-mainnet-grpc.gateway.tatum.io"),
  TATUM_SUI_RPC_URL: z.string().url().default("https://sui-mainnet.gateway.tatum.io"),
  TATUM_SOLANA_RPC_URL: z.string().url().default("https://solana-mainnet.gateway.tatum.io"),
  /** Used for any Solana call Tatum's plan doesn't allow. Set to "none" to use Tatum only. */
  SOLANA_FALLBACK_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),

  /** Chains to scan and read, comma-separated. */
  CHAINS: z
    .string()
    .default("sui,solana")
    .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter((c): c is "sui" | "solana" => c === "sui" || c === "solana")),

  GROQ_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  GROQ_MODELS: z.string().optional().default(""),
  GEMINI_MODELS: z.string().optional().default(""),
  CREATOR: z.string().default("jack (@jackdotsol)"),

  GECKOTERMINAL_BASE_URL: z.string().url().default("https://api.geckoterminal.com/api/v2"),

  DATABASE_PATH: z.string().default("./data/tide.db"),

  SCAN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  WALLET_CHECK_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(10_000),
  MIN_HOURLY_VOLUME_USD: z.coerce.number().nonnegative().default(5_000),
  SOLANA_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(50_000),
  SOLANA_MIN_HOURLY_VOLUME_USD: z.coerce.number().nonnegative().default(50_000),
  DIGEST_HOUR_LAGOS: z.coerce.number().int().min(0).max(23).default(9),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const hasMemwal = cfg.MEMWAL_PRIVATE_KEY && cfg.MEMWAL_ACCOUNT_ID;
  if (!hasMemwal && !cfg.MEMWAL_DRY_RUN) {
    throw new Error(
      "Walrus Memory credentials missing. Set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID, or MEMWAL_DRY_RUN=true for local dev.",
    );
  }
  return cfg;
}
