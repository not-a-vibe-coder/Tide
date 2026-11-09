import type { Chain } from "../core/chains.js";

/** DefiLlama's chain names for its DEX volume overview. */
const LLAMA_CHAIN: Record<Chain, string> = { sui: "Sui", solana: "Solana" };

export interface ChainVolume {
  chain: Chain;
  /** DEX volume in the last 24h, usd. */
  total24h: number;
  /** % change against the 24h before. */
  change1d: number | null;
  total7d: number | null;
  topDexes: { name: string; total24h: number }[];
}

interface RawOverview {
  total24h?: number | null;
  total7d?: number | null;
  change_1d?: number | null;
  protocols?: { name?: string; displayName?: string; total24h?: number | null }[];
}

export function parseOverview(chain: Chain, raw: RawOverview): ChainVolume {
  if (typeof raw.total24h !== "number") throw new Error("no volume in the answer");
  const topDexes = (raw.protocols ?? [])
    .filter((p) => typeof p.total24h === "number" && p.total24h > 0)
    .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
    .slice(0, 3)
    .map((p) => ({ name: p.displayName ?? p.name ?? "unknown", total24h: p.total24h ?? 0 }));
  return {
    chain,
    total24h: raw.total24h,
    change1d: typeof raw.change_1d === "number" ? raw.change_1d : null,
    total7d: typeof raw.total7d === "number" ? raw.total7d : null,
    topDexes,
  };
}

/** Whole-chain DEX volume from DefiLlama (free, no key), cached 10 minutes. */
export class ChainVolumes {
  private cache = new Map<Chain, { at: number; value: ChainVolume }>();

  constructor(private readonly baseUrl = "https://api.llama.fi") {}

  async get(chain: Chain): Promise<ChainVolume> {
    const hit = this.cache.get(chain);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const url = `${this.baseUrl}/overview/dexs/${LLAMA_CHAIN[chain]}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyVolume`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
    const value = parseOverview(chain, (await res.json()) as RawOverview);
    this.cache.set(chain, { at: Date.now(), value });
    return value;
  }
}
