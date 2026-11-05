import { normaliseCoinType } from "../core/buys.js";
import type { Pool } from "../core/types.js";

const NETWORK = "sui-network";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RawPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    volume_usd: Record<string, string | null>;
    price_change_percentage: Record<string, string | null>;
    transactions: Record<string, { buys: number; sells: number } | undefined>;
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : num(v));

/** GeckoTerminal ids look like "sui-network_0xabc::mod::SYM". */
export function coinTypeFromTokenId(id: string): string {
  const prefix = `${NETWORK}_`;
  return normaliseCoinType(id.startsWith(prefix) ? id.slice(prefix.length) : id);
}

export function normalisePool(raw: RawPool): Pool {
  const a = raw.attributes;
  const baseId = raw.relationships?.base_token?.data?.id ?? "";
  const coinType = coinTypeFromTokenId(baseId);
  return {
    address: a.address,
    name: a.name,
    dex: raw.relationships?.dex?.data?.id ?? "unknown",
    baseCoinType: coinType,
    baseSymbol: a.name.split("/")[0]?.trim() || coinType.split("::").at(-1) || "TOKEN",
    priceUsd: num(a.base_token_price_usd),
    marketCapUsd: numOrNull(a.market_cap_usd),
    fdvUsd: numOrNull(a.fdv_usd),
    liquidityUsd: num(a.reserve_in_usd),
    createdAt: a.pool_created_at ? new Date(a.pool_created_at) : null,
    volumeUsd: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) },
    priceChangePct: {
      m5: num(a.price_change_percentage?.m5),
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    txH1: { buys: num(a.transactions?.h1?.buys), sells: num(a.transactions?.h1?.sells) },
  };
}

export interface TokenQuote {
  priceUsd: number;
  volumeH24Usd: number;
  liquidityUsd: number;
}

/** Free GeckoTerminal API: no key, rate-limited (~30 calls a minute). */
export class Market {
  private lastCall = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly minGapMs = 2_100,
    private readonly backoffMs: number[] = [3_000, 8_000, 20_000],
  ) {}

  /**
   * Calls are queued so only one is in flight, spaced at least minGapMs apart.
   * A 429 (rate limited) is retried with backoff, honouring Retry-After. Free
   * hosts share outbound IPs, so 429s happen even when Tide itself is polite.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private get<T>(path: string): Promise<T> {
    const run = this.queue.then(() => this.fetchWithRetry<T>(path));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchWithRetry<T>(path: string): Promise<T> {
    const backoff = this.backoffMs;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json;version=20230302" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 429 && attempt < backoff.length) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff[attempt]!);
        continue;
      }
      throw new Error(`GeckoTerminal ${res.status} on ${path}`);
    }
  }

  /** Trending plus newly created Sui pools, de-duplicated. Works if either list loads. */
  async candidatePools(): Promise<Pool[]> {
    const [trending, fresh] = await Promise.allSettled([
      this.get<{ data: RawPool[] }>(`/networks/${NETWORK}/trending_pools?page=1&duration=1h`),
      this.get<{ data: RawPool[] }>(`/networks/${NETWORK}/new_pools?page=1`),
    ]);
    if (trending.status === "rejected" && fresh.status === "rejected") throw trending.reason;
    const lists = [trending, fresh].flatMap((r) => (r.status === "fulfilled" ? r.value.data : []));
    const byAddress = new Map<string, Pool>();
    for (const raw of lists) {
      const p = normalisePool(raw);
      if (p.baseCoinType) byAddress.set(p.address, p);
    }
    return [...byAddress.values()];
  }

  private readonly quoteCache = new Map<string, { at: number; value: TokenQuote | null }>();

  /** Price and activity for a coin, cached for a minute to spare the rate limit. */
  async quote(coinType: string): Promise<TokenQuote | null> {
    const key = normaliseCoinType(coinType);
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const value = await this.fetchQuote(key);
    this.quoteCache.set(key, { at: Date.now(), value });
    return value;
  }

  private async fetchQuote(coinType: string): Promise<TokenQuote | null> {
    const id = encodeURIComponent(normaliseCoinType(coinType));
    let res: { data: RawPool[] };
    try {
      res = await this.get<{ data: RawPool[] }>(`/networks/${NETWORK}/tokens/${id}/pools?page=1`);
    } catch (err) {
      if (err instanceof Error && err.message.includes(" 404 ")) return null;
      throw err;
    }
    const pools = res.data.map(normalisePool).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const best = pools[0];
    if (!best) return null;
    const isBase = best.baseCoinType === normaliseCoinType(coinType);
    const raw = res.data.find((r) => r.attributes.address === best.address);
    const priceUsd = isBase ? best.priceUsd : num((raw?.attributes as any)?.quote_token_price_usd);
    return { priceUsd, volumeH24Usd: best.volumeUsd.h24, liquidityUsd: best.liquidityUsd };
  }
}
