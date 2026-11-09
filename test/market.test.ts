import { afterEach, describe, expect, it, vi } from "vitest";
import { Market } from "../src/market/gecko.js";
import { rawGeckoPool } from "./fixtures.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const limited = () => new Response("slow down", { status: 429 });

describe("Market rate limiting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a 429 and succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValue(ok({ data: [rawGeckoPool] }));
    vi.stubGlobal("fetch", fetchMock);
    const pools = await new Market("https://x", 0, [1, 1]).candidatePools();
    expect(pools).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still returns pools when one of the two lists keeps failing", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? ok({ data: [rawGeckoPool] }) : limited())));
    const pools = await new Market("https://x", 0, [1]).candidatePools();
    expect(pools).toHaveLength(1);
  });

  it("gives up after its retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited()));
    await expect(new Market("https://x", 0, [1]).candidatePools()).rejects.toThrow("429");
  });

  it("runs one request at a time", async () => {
    let inflight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        peak = Math.max(peak, ++inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return ok({ data: [] });
      }),
    );
    await new Market("https://x", 0).candidatePools();
    expect(peak).toBe(1);
  });
});

describe("Market search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searches each chain on its own and keeps only that chain's pools", async () => {
    const mk = (id: string, liq: string) => {
      const r = structuredClone(rawGeckoPool) as any;
      r.relationships.base_token.data.id = id;
      r.attributes.reserve_in_usd = liq;
      r.attributes.address = id;
      return r;
    };
    const fetchMock = vi.fn(async () =>
      ok({
        data: [
          mk("eth_0xabc", "9000000"),
          mk("solana_EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", "3000000"),
          mk("sui-network_0x5::wif::WIF", "100000"),
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pools = await new Market("https://x", 0).search("wif");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.includes("network=solana"))).toBe(true);
    expect(urls.some((u) => u.includes("network=sui-network"))).toBe(true);
    expect(pools.map((p) => p.chain)).toEqual(["solana", "sui"]);
  });
});
