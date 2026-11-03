import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { normaliseCoinType } from "../core/buys.js";
import type { Balance } from "../core/types.js";

export interface CoinInfo {
  symbol: string;
  decimals: number;
}

/**
 * Reads the user's wallet through Tatum's Sui gRPC gateway. Tide only reads
 * public data: balances and coin metadata. It never signs anything.
 */
export class SuiReader {
  private readonly client: SuiGrpcClient;
  private readonly metaCache = new Map<string, CoinInfo>();

  constructor(baseUrl: string, apiKey: string) {
    this.client = new SuiGrpcClient({
      network: "mainnet",
      baseUrl,
      meta: apiKey ? { "x-api-key": apiKey } : undefined,
      timeout: 20_000,
    });
  }

  async balances(owner: string): Promise<Balance[]> {
    const out: Balance[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await this.client.listBalances({ owner, cursor, limit: 100 });
      for (const b of res.balances) out.push({ coinType: normaliseCoinType(b.coinType), raw: b.balance });
      if (!res.hasNextPage || !res.cursor) break;
      cursor = res.cursor;
    }
    return out;
  }

  async coinInfo(coinType: string): Promise<CoinInfo> {
    const key = normaliseCoinType(coinType);
    const hit = this.metaCache.get(key);
    if (hit) return hit;
    let info: CoinInfo;
    try {
      const res = await this.client.getCoinMetadata({ coinType: key });
      info = res.coinMetadata
        ? { symbol: res.coinMetadata.symbol, decimals: res.coinMetadata.decimals }
        : { symbol: fallbackSymbol(key), decimals: 9 };
    } catch {
      info = { symbol: fallbackSymbol(key), decimals: 9 };
    }
    this.metaCache.set(key, info);
    return info;
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
