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
