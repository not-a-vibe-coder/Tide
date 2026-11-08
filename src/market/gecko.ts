import { normaliseCoinType } from "../core/buys.js";
import { CHAINS, GECKO_NETWORK, chainOf, type Chain } from "../core/chains.js";
import { parseOhlcv, type Candle } from "../core/history.js";
import type { Pool } from "../core/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TopOptions {
  minLiquidityUsd?: number;
  /** Only tokens whose pool launched within this many hours. */
  maxAgeHours?: number;
}

/** Below this, volume and price moves on a pool are mostly noise or wash trading. */
export const TOP_MIN_LIQUIDITY: Record<Chain, number> = { sui: 10_000, solana: 50_000 };

/** Stablecoins by ticker, so new ones (USDG, USD1, PYUSD...) never show up as "top tokens". */
export function isStableSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^(USD|EUR)[A-Z0-9]{0,4}$|^[A-Z]{0,3}USD$|^(DAI|USDE|FRAX|LUSD|GHO|EURC|EUROC|XSGD|BUIDL)$/.test(s);
}

interface RawPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    quote_token_price_usd?: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    volume_usd: Record<string, string | null>;
    price_change_percentage: Record<string, string | null>;
    transactions: Record<string, { buys: number; sells: number; buyers?: number; sellers?: number } | undefined>;
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    quote_token?: { data?: { id: string } };
    dex?: { data?: { id: string } };
    network?: { data?: { id: string } };
  };
}

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : num(v));

const PREFIX = new RegExp(`^(${Object.values(GECKO_NETWORK).join("|")})_`);

/** GeckoTerminal ids look like "sui-network_0xabc::mod::SYM" or "solana_<mint>". */
export function coinTypeFromTokenId(id: string): string {
  const bare = id.replace(PREFIX, "");
  return bare.includes("::") ? normaliseCoinType(bare) : bare;
}

export function normaliseToken(token: string): string {
  return token.includes("::") ? normaliseCoinType(token) : token.trim();
}

export function normalisePool(raw: RawPool): Pool {
  const a = raw.attributes;
  const coinType = coinTypeFromTokenId(raw.relationships?.base_token?.data?.id ?? "");
  return {
    chain: chainOf(coinType),
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
    txH1: {
      buys: num(a.transactions?.h1?.buys),
      sells: num(a.transactions?.h1?.sells),
      ...(a.transactions?.h1?.buyers !== undefined ? { buyers: num(a.transactions.h1.buyers) } : {}),
      ...(a.transactions?.h1?.sellers !== undefined ? { sellers: num(a.transactions.h1.sellers) } : {}),
    },
  };
}

export interface TokenQuote {
  priceUsd: number;
  volumeH24Usd: number;
  liquidityUsd: number;
}

/** Free GeckoTerminal API: no key, rate-limited (~30 calls a minute). Covers Sui and Solana. */
export class Market {
  private lastCall = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly quoteCache = new Map<string, { at: number; value: TokenQuote | null }>();
  private readonly poolsCache = new Map<string, { at: number; value: Pool[] }>();
  private readonly symbolCache = new Map<string, string | null>();

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
  private waitingCalls = 0;
  private get<T>(path: string): Promise<T> {
    this.waitingCalls++;
    const run = this.queue.then(() => this.fetchWithRetry<T>(path)).finally(() => this.waitingCalls--);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Calls waiting in the queue right now (a backfill or scan can queue dozens). */
  get queued(): number {
    return this.waitingCalls;
  }

  /**
   * One direct call that skips the queue, for health checks: a busy queue
   * (backfill running) shouldn't look like GeckoTerminal being down.
   */
  async ping(chain: Chain = "sui"): Promise<number> {
    const res = await fetch(`${this.baseUrl}/networks/${GECKO_NETWORK[chain]}/trending_pools?page=1&duration=1h`, {
      headers: { accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) throw new Error("rate limited right now (429), tide backs off and retries on its own");
    if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
    const body = (await res.json()) as { data?: unknown[] };
    return body.data?.length ?? 0;
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

  /** Trending plus newly created pools on one chain, de-duplicated. Works if either list loads. */
  async candidatePools(chain: Chain = "sui"): Promise<Pool[]> {
    const net = GECKO_NETWORK[chain];
    const [trending, fresh] = await Promise.allSettled([
      this.get<{ data: RawPool[] }>(`/networks/${net}/trending_pools?page=1&duration=1h`),
      this.get<{ data: RawPool[] }>(`/networks/${net}/new_pools?page=1`),
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

  /**
   * Leading tokens on a chain by 24h volume, one row per token. Pools under a
   * liquidity floor are skipped (they're where the fake +1,000,000% moves
   * live), as are the chain's own coin and stablecoins. With maxAgeHours,
   * only tokens whose pool launched within that window are kept.
   */
  async topTokens(chain: Chain, n = 5, skip: (token: string) => boolean = () => false, opts: TopOptions = {}): Promise<Pool[]> {
    const minLiq = opts.minLiquidityUsd ?? TOP_MIN_LIQUIDITY[chain];
    const fresh = opts.maxAgeHours !== undefined;
    const key = `top:${chain}:${fresh ? "fresh" : "all"}`;
    const hit = this.poolsCache.get(key);
    let pools = hit && Date.now() - hit.at < 120_000 ? hit.value : null;
    if (!pools) {
      const net = GECKO_NETWORK[chain];
      // Fresh tokens need more sources: the volume list is dominated by old pools.
      const paths = fresh
        ? [
            `/networks/${net}/trending_pools?page=1&duration=24h`,
            `/networks/${net}/trending_pools?page=2&duration=24h`,
            `/networks/${net}/new_pools?page=1`,
            `/networks/${net}/new_pools?page=2`,
            `/networks/${net}/pools?page=1&sort=h24_volume_usd_desc`,
          ]
        : [`/networks/${net}/pools?page=1&sort=h24_volume_usd_desc`, `/networks/${net}/trending_pools?page=1&duration=24h`];
      const results = await Promise.allSettled(paths.map((p) => this.get<{ data: RawPool[] }>(p)));
      if (results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
      pools = results.flatMap((r) => (r.status === "fulfilled" ? r.value.data.map(normalisePool) : []));
      this.poolsCache.set(key, { at: Date.now(), value: pools });
    }
    const now = Date.now();
    const maxAgeMs = (opts.maxAgeHours ?? Infinity) * 3_600_000;
    const seen = new Set<string>();
    const out: Pool[] = [];
    for (const p of pools.slice().sort((a, b) => b.volumeUsd.h24 - a.volumeUsd.h24)) {
      if (!p.baseCoinType || seen.has(p.baseCoinType) || skip(p.baseCoinType) || isStableSymbol(p.baseSymbol)) continue;
      if (p.liquidityUsd < minLiq) continue;
      if (fresh && (!p.createdAt || now - p.createdAt.getTime() > maxAgeMs)) continue;
      seen.add(p.baseCoinType);
      out.push(p);
      if (out.length >= n) break;
    }
    return out;
  }

  /** Hourly candles for a pool, oldest first: up to `limit` hours back. */
  async hourlyCandles(chain: Chain, poolAddress: string, limit = 168): Promise<Candle[]> {
    const res = await this.get<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      `/networks/${GECKO_NETWORK[chain]}/pools/${encodeURIComponent(poolAddress)}/ohlcv/hour?aggregate=1&limit=${limit}&currency=usd`,
    );
    return parseOhlcv(res.data?.attributes?.ohlcv_list ?? []);
  }

  /**
   * Pools to learn from: trending, recently launched and top-volume pools,
   * one per token. Recent launches are included on purpose so the history
   * isn't only the survivors.
   */
  async historyCandidates(chain: Chain): Promise<Pool[]> {
    const net = GECKO_NETWORK[chain];
    const paths = [
      `/networks/${net}/trending_pools?page=1&duration=24h`,
      `/networks/${net}/trending_pools?page=2&duration=24h`,
      `/networks/${net}/new_pools?page=1`,
      `/networks/${net}/new_pools?page=2`,
      `/networks/${net}/pools?page=1&sort=h24_volume_usd_desc`,
    ];
    const results = await Promise.allSettled(paths.map((p) => this.get<{ data: RawPool[] }>(p)));
    const byToken = new Map<string, Pool>();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const p of r.value.data.map(normalisePool)) {
        const prev = byToken.get(p.baseCoinType);
        if (p.baseCoinType && (!prev || p.liquidityUsd > prev.liquidityUsd)) byToken.set(p.baseCoinType, p);
      }
    }
    return [...byToken.values()];
  }

  /** Every pool a token trades in, most liquid first. Cached for a minute. */
  async tokenPools(token: string): Promise<Pool[]> {
    const key = normaliseToken(token);
    const hit = this.poolsCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const net = GECKO_NETWORK[chainOf(key)];
    let pools: Pool[] = [];
    let raw: RawPool[] = [];
    try {
      raw = (await this.get<{ data: RawPool[] }>(`/networks/${net}/tokens/${encodeURIComponent(key)}/pools?page=1`)).data;
      pools = raw.map(normalisePool).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes(" 404 "))) throw err;
    }
    this.poolsCache.set(key, { at: Date.now(), value: pools });
    // Remember the quote-side price too, for tokens that are only ever the quote in a pool.
    const best = pools[0];
    if (best) {
      const isBase = best.baseCoinType === key;
      const rawBest = raw.find((r) => r.attributes.address === best.address);
      const priceUsd = isBase ? best.priceUsd : num(rawBest?.attributes.quote_token_price_usd);
      this.quoteCache.set(key, { at: Date.now(), value: { priceUsd, volumeH24Usd: best.volumeUsd.h24, liquidityUsd: best.liquidityUsd } });
      if (isBase) this.symbolCache.set(key, best.baseSymbol);
    } else {
      this.quoteCache.set(key, { at: Date.now(), value: null });
    }
    return pools;
  }

  /** Price and activity for a token from its most liquid pool, cached for a minute. */
  async quote(token: string): Promise<TokenQuote | null> {
    const key = normaliseToken(token);
    const hit = this.quoteCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    await this.tokenPools(key);
    return this.quoteCache.get(key)?.value ?? null;
  }

  /** A token's ticker, from its pools. */
  async symbol(token: string): Promise<string | null> {
    const key = normaliseToken(token);
    if (this.symbolCache.has(key)) return this.symbolCache.get(key)!;
    await this.tokenPools(key).catch(() => []);
    return this.symbolCache.get(key) ?? null;
  }

  /** Search pools by ticker or name on the given chains, most liquid first. */
  async search(query: string, chains: Chain[] = CHAINS): Promise<Pool[]> {
    // One call across every network, then keep only the chains Tide covers.
    const res = await this.get<{ data: RawPool[] }>(`/search/pools?query=${encodeURIComponent(query)}&page=1`);
    const wanted = chains.map((c) => `${GECKO_NETWORK[c]}_`);
    return res.data
      .filter((r) => wanted.some((w) => (r.relationships?.base_token?.data?.id ?? "").startsWith(w)))
      .map(normalisePool)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }
}
