import type { Pool } from "../src/core/types.js";

export const NOW = new Date("2026-11-05T12:00:00Z");
export const SCOOP = "0x" + "ab".repeat(32) + "::scoop::SCOOP";

export function pool(over: Partial<Pool> = {}): Pool {
  return {
    address: "0xpool1",
    name: "SCOOP / SUI",
    dex: "cetus",
    baseCoinType: SCOOP,
    baseSymbol: "SCOOP",
    priceUsd: 0.01,
    marketCapUsd: 1_200_000,
    fdvUsd: 1_500_000,
    liquidityUsd: 80_000,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    volumeUsd: { m5: 2_000, h1: 40_000, h6: 90_000, h24: 120_000 },
    priceChangePct: { m5: 2, h1: 12, h6: 20, h24: 30 },
    txH1: { buys: 120, sells: 80 },
    ...over,
  };
}

/** A real GeckoTerminal pool object, trimmed to the fields Tide reads. */
export const rawGeckoPool = {
  id: "sui-network_0xpool1",
  type: "pool",
  attributes: {
    address: "0xpool1",
    name: "SCOOP / SUI",
    base_token_price_usd: "0.0123",
    quote_token_price_usd: "2.10",
    fdv_usd: "1500000",
    market_cap_usd: null,
    reserve_in_usd: "45000.5",
    pool_created_at: "2026-11-04T10:00:00Z",
    volume_usd: { m5: "1000", m15: "3000", m30: "6000", h1: "25000", h6: "60000", h24: "72000" },
    price_change_percentage: { m5: "1.2", m15: "3", m30: "8", h1: "34.5", h6: "50", h24: "80" },
    transactions: {
      m5: { buys: 10, sells: 4, buyers: 8, sellers: 3 },
      h1: { buys: 90, sells: 40, buyers: 60, sellers: 30 },
    },
  },
  relationships: {
    base_token: { data: { id: `sui-network_${SCOOP}`, type: "token" } },
    quote_token: { data: { id: "sui-network_0x2::sui::SUI", type: "token" } },
    dex: { data: { id: "cetus", type: "dex" } },
  },
};
