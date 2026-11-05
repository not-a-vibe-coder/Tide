/**
 * On-chain safety facts for a Solana token, read straight from the mint and
 * its largest holders. These are the classic memecoin rug levers.
 */
export interface TokenSafety {
  /** Someone can still mint new supply. */
  mintable: boolean;
  /** Someone can freeze holders' token accounts, so you can't sell. */
  freezable: boolean;
  /** Token-2022 features that change how transfers work. */
  extensions: string[];
  /** Transfer fee in basis points, if the token charges one. */
  transferFeeBps: number | null;
  /** Share of supply in the single largest account (usually the liquidity pool). */
  topHolderPct: number | null;
  /** Share held by the next 10 largest accounts after that one. */
  next10Pct: number | null;
}

export interface SafetyRead {
  multiplier: number;
  flags: string[];
  strengths: string[];
}

/** Turns safety facts into red flags and a risk multiplier to combine with the market risk check. */
export function readSafety(s: TokenSafety): SafetyRead {
  let r = 1;
  const flags: string[] = [];
  const strengths: string[] = [];

  if (s.mintable) {
    r *= 0.5;
    flags.push("mint authority is still on, so the creator can print more tokens and dilute you");
  }
  if (s.freezable) {
    r *= 0.5;
    flags.push("freeze authority is on, so the creator can freeze your tokens and stop you selling");
  }
  if (s.extensions.includes("permanentDelegate")) {
    r *= 0.25;
    flags.push("it has a permanent delegate, someone can move tokens out of any wallet, including yours");
  }
  if (s.transferFeeBps !== null && s.transferFeeBps > 0) {
    r *= s.transferFeeBps >= 500 ? 0.5 : 0.75;
    flags.push(`every transfer pays a ${(s.transferFeeBps / 100).toFixed(s.transferFeeBps % 100 ? 1 : 0)}% fee`);
  }
  if (s.extensions.includes("transferHook")) {
    r *= 0.75;
    flags.push("transfers run custom code (a transfer hook) that could block sells");
  }
  if (s.extensions.includes("nonTransferable")) {
    r *= 0.25;
    flags.push("the token can't be transferred at all");
  }

  if (s.next10Pct !== null) {
    if (s.next10Pct >= 40) {
      r *= 0.5;
      flags.push(`after the biggest account (usually the pool), the next 10 wallets hold ${Math.round(s.next10Pct)}% of supply`);
    } else if (s.next10Pct >= 25) {
      r *= 0.75;
      flags.push(`the 10 biggest holders after the pool own ${Math.round(s.next10Pct)}% of supply`);
    } else if (s.next10Pct < 15) {
      strengths.push(`holders are spread out, the top 10 after the pool own ${Math.round(s.next10Pct)}%`);
    }
  }

  if (!s.mintable && !s.freezable) strengths.push("mint and freeze authority are both revoked");
  return { multiplier: r, flags, strengths };
}

/** Plain lines for the AI, so it can cite exactly what was checked. */
export function describeSafety(s: TokenSafety): string {
  return [
    `on-chain safety (read from the solana mint): mint authority ${s.mintable ? "ON" : "revoked"}, freeze authority ${s.freezable ? "ON" : "revoked"}`,
    s.extensions.length ? `token-2022 features: ${s.extensions.join(", ")}` : "no token-2022 transfer features",
    s.transferFeeBps ? `transfer fee ${(s.transferFeeBps / 100).toFixed(1)}%` : "",
    s.topHolderPct !== null ? `largest account holds ${s.topHolderPct.toFixed(1)}% (usually the liquidity pool), next 10 hold ${s.next10Pct?.toFixed(1)}%` : "holder data unavailable",
  ]
    .filter(Boolean)
    .join("; ");
}
