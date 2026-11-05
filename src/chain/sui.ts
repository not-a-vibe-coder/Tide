import { ChannelCredentials } from "@grpc/grpc-js";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { normaliseCoinType } from "../core/buys.js";
import type { Balance } from "../core/types.js";
import { log } from "../log.js";

export interface CoinInfo {
  symbol: string;
  decimals: number;
}

export type SuiTransport = "grpc" | "json-rpc";

/**
 * Reads the user's wallet through Tatum's Sui gateway. Tide only reads
 * public data: balances and coin metadata. It never signs anything.
 *
 * Tatum's gRPC endpoint speaks native gRPC (HTTP/2), not gRPC-web, so this
 * uses grpc-js. If gRPC fails, it falls back to Tatum's Sui JSON-RPC.
 */
export class SuiReader {
  private readonly grpc: SuiGrpcClient;
  private readonly metaCache = new Map<string, CoinInfo>();
  /** Which transport answered the last call. */
  lastTransport: SuiTransport | null = null;

  constructor(
    grpcUrl: string,
    private readonly apiKey: string,
    private readonly rpcUrl = "https://sui-mainnet.gateway.tatum.io",
  ) {
    const u = new URL(grpcUrl);
    const transport = new GrpcTransport({
      host: `${u.hostname}:${u.port || "443"}`,
      channelCredentials: ChannelCredentials.createSsl(),
      meta: apiKey ? { "x-api-key": apiKey } : {},
      timeout: 20_000,
    });
    this.grpc = new SuiGrpcClient({ network: "mainnet", transport });
  }

  async balances(owner: string): Promise<Balance[]> {
    try {
      const out = await this.balancesGrpc(owner);
      this.lastTransport = "grpc";
      return out;
    } catch (grpcErr) {
      log.debug("Sui gRPC failed, trying JSON-RPC:", grpcErr instanceof Error ? grpcErr.message : grpcErr);
      try {
        const out = await this.balancesJsonRpc(owner);
        this.lastTransport = "json-rpc";
        return out;
      } catch (rpcErr) {
        throw new Error(`gRPC: ${errMsg(grpcErr)} | JSON-RPC: ${errMsg(rpcErr)}`);
      }
    }
  }

  private async balancesGrpc(owner: string): Promise<Balance[]> {
    const out: Balance[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await this.grpc.listBalances({ owner, cursor, limit: 100 });
      for (const b of res.balances) out.push({ coinType: normaliseCoinType(b.coinType), raw: b.balance });
      if (!res.hasNextPage || !res.cursor) break;
      cursor = res.cursor;
    }
    return out;
  }

  private async balancesJsonRpc(owner: string): Promise<Balance[]> {
    const res = await this.rpc<{ coinType: string; totalBalance: string }[]>("suix_getAllBalances", [owner]);
    return res.map((b) => ({ coinType: normaliseCoinType(b.coinType), raw: b.totalBalance }));
  }

  async coinInfo(coinType: string): Promise<CoinInfo> {
    const key = normaliseCoinType(coinType);
    const hit = this.metaCache.get(key);
    if (hit) return hit;
    let info: CoinInfo | null = null;
    try {
      const res = await this.grpc.getCoinMetadata({ coinType: key });
      if (res.coinMetadata) info = { symbol: res.coinMetadata.symbol, decimals: res.coinMetadata.decimals };
    } catch {
      try {
        const m = await this.rpc<{ symbol: string; decimals: number } | null>("suix_getCoinMetadata", [key]);
        if (m) info = { symbol: m.symbol, decimals: m.decimals };
      } catch {
        /* fall through to the fallback below */
      }
    }
    info ??= { symbol: fallbackSymbol(key), decimals: 9 };
    this.metaCache.set(key, info);
    return info;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  }
}

export function parseSuiAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) return null;
  const n = normalizeSuiAddress(trimmed);
  return isValidSuiAddress(n) ? n : null;
}

function fallbackSymbol(coinType: string): string {
  return coinType.split("::").at(-1) ?? "TOKEN";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
