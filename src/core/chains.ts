import { fromBase58 } from "@mysten/sui/utils";

export type Chain = "sui" | "solana";
export const CHAINS: Chain[] = ["sui", "solana"];

/** Wrapped SOL mint. Native SOL balances are stored under this ID so they can be priced. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/**
 * Token IDs carry their chain: Sui coin types always contain "::"
 * (0x2::sui::SUI), Solana mint addresses never do.
 */
export function chainOf(token: string): Chain {
  return token.includes("::") ? "sui" : "solana";
}

export const GECKO_NETWORK: Record<Chain, string> = { sui: "sui-network", solana: "solana" };

export const CHAIN_LABEL: Record<Chain, string> = { sui: "sui", solana: "solana" };

export function parseSolanaAddress(input: string): string | null {
  const t = input.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return null;
  try {
    return fromBase58(t).length === 32 ? t : null;
  } catch {
    return null;
  }
}
