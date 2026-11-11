import { hkdfSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Each user's trading wallet is derived from one master secret, their Telegram id and a
 * wallet number. Nothing secret is ever stored: Render's free plan wipes the disk on
 * every deploy, and a stored key would vanish with the funds. The same inputs always
 * give the same wallet, so it comes back after any restart.
 *
 * Losing TRADE_MASTER_SEED means losing every wallet, and leaking it exposes every wallet.
 */
export function deriveTradingKeypair(masterSeed: string, userId: number, index = 0): Keypair {
  if (masterSeed.length < 32) throw new Error("TRADE_MASTER_SEED must be at least 32 characters");
  const seed = hkdfSync("sha256", Buffer.from(masterSeed, "utf8"), Buffer.from("tide-trading-wallet-v1"), Buffer.from(`solana:${userId}:${index}`), 32);
  return Keypair.fromSeed(new Uint8Array(seed));
}

/** The secret key in the base58 form Phantom and Solflare import. */
export function exportSecret(kp: Keypair): string {
  return bs58.encode(kp.secretKey);
}

export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}
