import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaReader } from "../src/chain/solana.js";
import { describeSafety, readSafety, type TokenSafety } from "../src/core/safety.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const safe: TokenSafety = { mintable: false, freezable: false, extensions: [], transferFeeBps: null, topHolderPct: 30, next10Pct: 10 };

describe("reading token safety", () => {
  it("rates a clean token well", () => {
    const r = readSafety(safe);
    expect(r.multiplier).toBe(1);
    expect(r.flags).toEqual([]);
    expect(r.strengths).toEqual(["holders are spread out, the top 10 after the pool own 10%", "mint and freeze authority are both revoked"]);
  });

  it("flags the classic rug levers", () => {
    const r = readSafety({ ...safe, mintable: true, freezable: true, next10Pct: 55 });
    expect(r.multiplier).toBe(0.125);
    expect(r.flags.join(" ")).toContain("can print more tokens");
    expect(r.flags.join(" ")).toContain("freeze your tokens");
    expect(r.flags.join(" ")).toContain("next 10 wallets hold 55%");
  });

  it("flags dangerous Token-2022 features", () => {
    const r = readSafety({ ...safe, extensions: ["permanentDelegate", "transferHook"], transferFeeBps: 1000 });
    expect(r.flags.join(" ")).toContain("move tokens out of any wallet");
    expect(r.flags.join(" ")).toContain("10% fee");
    expect(r.flags.join(" ")).toContain("transfer hook");
  });

  it("describes what was checked", () => {
    expect(describeSafety({ ...safe, mintable: true })).toContain("mint authority ON, freeze authority revoked");
  });
});

describe("SolanaReader.tokenSafety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads authorities, extensions and holders from the chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const result =
          body.method === "getAccountInfo"
            ? {
                value: {
                  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                  data: {
                    parsed: {
                      type: "mint",
                      info: {
                        mintAuthority: null,
                        freezeAuthority: "Fr33ze1111111111111111111111111111111111111",
                        supply: "1000000",
                        extensions: [
                          { extension: "tokenMetadata" },
                          { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 250 } } },
                        ],
                      },
                    },
                  },
                },
              }
            : { value: [{ amount: "400000" }, { amount: "100000" }, { amount: "50000" }, { amount: "50000" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }),
    );
    const s = await new SolanaReader("https://tatum", "k", undefined, null).tokenSafety(MINT);
    expect(s).toEqual({ mintable: false, freezable: true, extensions: ["transferFeeConfig"], transferFeeBps: 250, topHolderPct: 40, next10Pct: 20 });
  });

  it("returns null for something that isn't a mint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }))));
    expect(await new SolanaReader("https://tatum", "k", undefined, null).tokenSafety(MINT)).toBeNull();
  });
});
