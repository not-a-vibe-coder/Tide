import type { Chain } from "./chains.js";

/** A DEX pool as Tide sees it, normalised from the market data API. */
export interface Pool {
  chain: Chain;
  address: string;
  name: string;
  dex: string;
  /** Base token: a Sui coin type (0xabc::scoop::SCOOP) or a Solana mint address. */
  baseCoinType: string;
  baseSymbol: string;
  priceUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number;
  createdAt: Date | null;
  volumeUsd: { m5: number; h1: number; h6: number; h24: number };
  priceChangePct: { m5: number; h1: number; h6: number; h24: number };
  /** Last hour's trades; buyers and sellers are unique wallets when the data source reports them. */
  txH1: { buys: number; sells: number; buyers?: number; sellers?: number };
}

/** "new" = pool younger than 7 days. Track record and preferences are kept per class. */
export type TokenClass = "new" | "established";

export interface Spike {
  /** "spike" = an existing pool suddenly moving; "launch" = a pool created minutes ago. */
  kind?: "spike" | "launch";
  pool: Pool;
  tokenClass: TokenClass;
  /** Last-hour volume divided by the average hourly volume over 24h. */
  volumeMultiple: number;
  reasons: string[];
}

export interface RiskCheck {
  /** Token risk multiplier r in the sizing formula, 0.25 to 1.0. Lower = riskier. */
  multiplier: number;
  label: "lower" | "medium" | "high";
  flags: string[];
  /** Things genuinely in the token's favour, for a balanced read. */
  strengths: string[];
}

export interface Balance {
  coinType: string;
  /** Raw integer amount as a string, in the coin's smallest unit. */
  raw: string;
}

export interface DetectedBuy {
  coinType: string;
  /** Raw amount gained since the last snapshot. */
  rawDelta: bigint;
}

export interface SizingInputs {
  budgetLeftUsd: number;
  baseShare: number;
  trackRecord: number;
  riskMultiplier: number;
}

export interface SizingResult extends SizingInputs {
  maxUsd: number;
  /** Where the track record came from: your own results, market history, or neutral. */
  trackRecordFrom?: "you" | "market" | "default";
}
