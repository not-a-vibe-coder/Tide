import { SOL_MINT } from "../core/chains.js";
import type { TokenSafety } from "../core/safety.js";
import type { Balance } from "../core/types.js";
import type { CoinInfo } from "./sui.js";

export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
];

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
}

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/** Errors that mean "this endpoint won't serve this method", so the next one should try. */
const TRY_NEXT = /paid plan|upgrade|not available|not allowed|forbidden|unauthori[sz]ed|HTTP (401|402|403|429)|rate limit|fetch failed|timeout|aborted/i;

/**
 * Reads a Solana wallet: native SOL plus every SPL and Token-2022 balance.
 * Read-only, like the Sui reader.
 *
 * Tatum is tried first for every call. Tatum's free plan blocks some Solana
 * methods (getBalance is paid-only), so any call Tatum refuses goes to the
 * fallback RPC instead, call by call. `lastSource` says who answered.
 */
export class SolanaReader {
  private readonly decimals = new Map<string, number>([[SOL_MINT, 9]]);
  /** Methods Tatum refused, skipped for 6 hours so we don't burn requests on them. */
  private readonly tatumBlocked = new Map<string, number>();
  /** Which endpoint answered each method on the last read. */
  readonly lastSource = new Map<string, "tatum" | "fallback">();

  constructor(
    private readonly rpcUrl: string,
    private readonly apiKey: string,
    /** Looks a token's symbol up elsewhere (GeckoTerminal), since Solana RPC doesn't return it. */
    private readonly symbolOf: (mint: string) => Promise<string | null> = async () => null,
    private readonly fallbackUrl: string | null = PUBLIC_SOLANA_RPC,
  ) {}

  /** "getBalance via fallback, getTokenAccountsByOwner via tatum" */
  describeSources(): string {
    return [...this.lastSource].map(([m, s]) => `${m} via ${s === "tatum" ? "tatum" : "public rpc"}`).join(", ");
  }

  async balances(owner: string): Promise<Balance[]> {
    const totals = new Map<string, bigint>();
    totals.set(SOL_MINT, await this.solLamports(owner));

    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.rpc<{ value: ParsedTokenAccount[] }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      for (const acc of res.value) {
        const info = acc.account.data.parsed.info;
        this.decimals.set(info.mint, info.tokenAmount.decimals);
        totals.set(info.mint, (totals.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
    }
    return [...totals].filter(([mint, raw]) => raw > 0n || mint === SOL_MINT).map(([coinType, raw]) => ({ coinType, raw: raw.toString() }));
  }

  /** True if this address is a token mint rather than a wallet. */
  async isMint(address: string): Promise<boolean> {
    if (address === SOL_MINT) return true;
    const res = await this.rpc<{ value: { owner: string; data: { parsed?: { type?: string } } } | null }>("getAccountInfo", [
      address,
      { encoding: "jsonParsed" },
    ]);
    return !!res.value && TOKEN_PROGRAMS.includes(res.value.owner) && res.value.data.parsed?.type === "mint";
  }

  private readonly safetyCache = new Map<string, { at: number; value: TokenSafety | null }>();

  /** Mint and freeze authority, Token-2022 features and holder concentration. Cached for an hour. */
  async tokenSafety(mint: string): Promise<TokenSafety | null> {
    const hit = this.safetyCache.get(mint);
    if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value;
    let value: TokenSafety | null = null;
    try {
      const acc = await this.rpc<{
        value: {
          owner: string;
          data: {
            parsed?: {
              type?: string;
              info?: {
                mintAuthority: string | null;
                freezeAuthority: string | null;
                supply: string;
                extensions?: { extension: string; state?: { newerTransferFee?: { transferFeeBasisPoints?: number } } }[];
              };
            };
          };
        } | null;
      }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
      const info = acc.value?.data.parsed?.info;
      if (info && acc.value?.data.parsed?.type === "mint") {
        const extensions = (info.extensions ?? []).map((e) => e.extension).filter((e) => e !== "metadataPointer" && e !== "tokenMetadata");
        const fee = info.extensions?.find((e) => e.extension === "transferFeeConfig")?.state?.newerTransferFee?.transferFeeBasisPoints ?? null;
        let topHolderPct: number | null = null;
        let next10Pct: number | null = null;
        try {
          const largest = await this.rpc<{ value: { amount: string }[] }>("getTokenLargestAccounts", [mint]);
          const supply = Number(info.supply);
          if (supply > 0 && largest.value.length) {
            const amounts = largest.value.map((a) => Number(a.amount)).sort((a, b) => b - a);
            topHolderPct = (amounts[0]! / supply) * 100;
            next10Pct = (amounts.slice(1, 11).reduce((x, y) => x + y, 0) / supply) * 100;
          }
        } catch {
          /* holder data is a bonus; authorities alone are still worth reporting */
        }
        value = { mintable: !!info.mintAuthority, freezable: !!info.freezeAuthority, extensions, transferFeeBps: fee, topHolderPct, next10Pct };
      }
    } catch {
      value = null;
    }
    this.safetyCache.set(mint, { at: Date.now(), value });
    return value;
  }

  async coinInfo(mint: string): Promise<CoinInfo> {
    if (mint === SOL_MINT) return { symbol: "SOL", decimals: 9 };
    let decimals = this.decimals.get(mint);
    if (decimals === undefined) {
      const res = await this.rpc<{ value: { data: { parsed?: { info?: { decimals?: number } } } } | null }>("getAccountInfo", [
        mint,
        { encoding: "jsonParsed" },
      ]).catch(() => null);
      decimals = res?.value?.data?.parsed?.info?.decimals ?? 9;
      this.decimals.set(mint, decimals);
    }
    const symbol = (await this.symbolOf(mint).catch(() => null)) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    return { symbol, decimals };
  }

  /**
   * SOL balance. getAccountInfo also carries lamports and may be allowed where
   * getBalance isn't, so it's tried first. A wallet with no account yet has 0.
   */
  private async solLamports(owner: string): Promise<bigint> {
    try {
      const info = await this.rpc<{ value: { lamports: number } | null }>("getAccountInfo", [owner, { encoding: "base64" }]);
      return BigInt(info.value?.lamports ?? 0);
    } catch {
      const bal = await this.rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
      return BigInt(bal.value);
    }
  }

  /** One JSON-RPC call: Tatum first, the fallback endpoint if Tatum refuses. Also used to send trades. */
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const blockedAt = this.tatumBlocked.get(method);
    const tatumOk = !blockedAt || Date.now() - blockedAt > 6 * 60 * 60 * 1000;
    let tatumError: Error | null = null;
    if (tatumOk) {
      try {
        const out = await call<T>(this.rpcUrl, method, params, this.apiKey);
        this.lastSource.set(method, "tatum");
        return out;
      } catch (err) {
        tatumError = err instanceof Error ? err : new Error(String(err));
        if (!this.fallbackUrl || !TRY_NEXT.test(tatumError.message)) throw tatumError;
        if (/paid plan|upgrade|not available|not allowed/i.test(tatumError.message)) this.tatumBlocked.set(method, Date.now());
      }
    }
    if (!this.fallbackUrl) throw tatumError ?? new Error(`${method} unavailable`);
    try {
      const out = await call<T>(this.fallbackUrl, method, params);
      this.lastSource.set(method, "fallback");
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(tatumError ? `tatum: ${tatumError.message} | fallback: ${msg}` : msg);
    }
  }
}

async function call<T>(url: string, method: string, params: unknown[], apiKey?: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}
