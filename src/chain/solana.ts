import { SOL_MINT } from "../core/chains.js";
import type { Balance } from "../core/types.js";
import type { CoinInfo } from "./sui.js";

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PNnBqCXEiPxN6m", // Token-2022
];

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } };
}

/**
 * Reads a Solana wallet through Tatum's Solana RPC: native SOL plus every
 * SPL and Token-2022 balance. Read-only, like the Sui reader.
 */
export class SolanaReader {
  private readonly decimals = new Map<string, number>([[SOL_MINT, 9]]);

  constructor(
    private readonly rpcUrl: string,
    private readonly apiKey: string,
    /** Looks a token's symbol up elsewhere (GeckoTerminal), since Solana RPC doesn't return it. */
    private readonly symbolOf: (mint: string) => Promise<string | null> = async () => null,
  ) {}

  async balances(owner: string): Promise<Balance[]> {
    const totals = new Map<string, bigint>();
    const lamports = await this.rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
    totals.set(SOL_MINT, BigInt(lamports.value));

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

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`Solana RPC: ${body.error.message}`);
    return body.result as T;
  }
}
