import { SOLANA_USDC, SOLANA_USDT, SOL_MINT } from "./chains.js";
import type { Balance, DetectedBuy } from "./types.js";

export const SUI_COIN_TYPE = "0x2::sui::SUI";

/** Coins treated as cash, not as positions: SUI and native USDC on Sui, SOL, USDC and USDT on Solana. */
export const CASH_COIN_TYPES = new Set([
  SUI_COIN_TYPE,
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  SOL_MINT,
  SOLANA_USDC,
  SOLANA_USDT,
]);

/** Cash coins worth $1 each. */
export const STABLECOINS = new Set([
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  SOLANA_USDC,
  SOLANA_USDT,
]);

export function normaliseCoinType(coinType: string): string {
  const [addr, ...rest] = coinType.split("::");
  if (!addr || rest.length === 0) return coinType;
  const hex = addr.toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  const short = hex.length <= 3 ? `0x${hex}` : `0x${hex.padStart(64, "0")}`;
  return [short, ...rest].join("::");
}

export function isCash(coinType: string): boolean {
  const n = normaliseCoinType(coinType);
  for (const c of CASH_COIN_TYPES) if (normaliseCoinType(c) === n) return true;
  return false;
}

/**
 * Compare two balance snapshots. Any non-cash coin whose balance went up
 * counts as a buy (a swap, or tokens received). The first snapshot for a
 * wallet is a baseline and yields no buys.
 */
export function diffBalances(previous: Balance[] | null, current: Balance[]): DetectedBuy[] {
  if (previous === null) return [];
  const before = new Map(previous.map((b) => [normaliseCoinType(b.coinType), BigInt(b.raw)]));
  const buys: DetectedBuy[] = [];
  for (const b of current) {
    const type = normaliseCoinType(b.coinType);
    if (isCash(type)) continue;
    const delta = BigInt(b.raw) - (before.get(type) ?? 0n);
    if (delta > 0n) buys.push({ coinType: type, rawDelta: delta });
  }
  return buys;
}

export function toUnits(raw: bigint | string, decimals: number): number {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = v % scale;
  return Number(whole) + Number(frac) / Number(scale);
}
