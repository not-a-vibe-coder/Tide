import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SOL_MINT } from "../core/chains.js";

/** The part of SolanaReader the trader needs: one JSON-RPC call with Tatum first. */
export interface RpcClient {
  rpc<T>(method: string, params: unknown[]): Promise<T>;
}

export interface TraderOptions {
  jupiterUrl?: string;
  pumpportalUrl?: string;
  /** Max priority fee per trade, in lamports. */
  priorityLamports?: number;
  confirmTimeoutMs?: number;
  pollMs?: number;
}

export interface SwapResult {
  signature: string;
  route: "jupiter" | "pumpportal";
}

export class NoRouteError extends Error {}

/**
 * Buys and sells Solana tokens from a user's trading wallet. Jupiter routes anything with
 * liquidity; tokens still on a pump.fun bonding curve go through PumpPortal. Both return an
 * unsigned transaction that is signed here and sent through Tatum's Solana RPC.
 */
export class SolanaTrader {
  private readonly jup: string;
  private readonly pp: string;
  private readonly priority: number;

  constructor(
    private readonly chain: RpcClient,
    private readonly opts: TraderOptions = {},
  ) {
    this.jup = opts.jupiterUrl ?? "https://lite-api.jup.ag/swap/v1";
    this.pp = opts.pumpportalUrl ?? "https://pumpportal.fun/api";
    this.priority = opts.priorityLamports ?? 300_000;
  }

  async lamports(owner: string): Promise<bigint> {
    const res = await this.chain.rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
    return BigInt(res.value);
  }

  /** Raw token balance and decimals for one mint (0 if the wallet holds none). */
  async tokenBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number }> {
    const res = await this.chain.rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }[] }>(
      "getTokenAccountsByOwner",
      [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    );
    let raw = 0n;
    let decimals = 6;
    for (const a of res.value) {
      raw += BigInt(a.account.data.parsed.info.tokenAmount.amount);
      decimals = a.account.data.parsed.info.tokenAmount.decimals;
    }
    return { raw, decimals };
  }

  /** Spend `lamports` of SOL on `mint`. `pumpFirst` skips Jupiter for brand-new pump.fun tokens. */
  async buy(kp: Keypair, mint: string, lamports: bigint, slippageBps: number, pumpFirst = false): Promise<SwapResult> {
    if (!pumpFirst) {
      try {
        return await this.jupiter(kp, SOL_MINT, mint, lamports, slippageBps);
      } catch (err) {
        if (!(err instanceof NoRouteError)) throw err;
      }
    }
    return this.pumpportal(kp, "buy", mint, Number(lamports) / 1e9, true, slippageBps);
  }

  /** Sell `raw` units of `mint` for SOL. */
  async sell(kp: Keypair, mint: string, raw: bigint, decimals: number, slippageBps: number): Promise<SwapResult> {
    try {
      return await this.jupiter(kp, mint, SOL_MINT, raw, slippageBps);
    } catch (err) {
      if (!(err instanceof NoRouteError)) throw err;
    }
    return this.pumpportal(kp, "sell", mint, Number(raw) / 10 ** decimals, false, slippageBps);
  }

  /** Send SOL to another wallet. */
  async transfer(kp: Keypair, to: string, lamports: bigint): Promise<string> {
    const { value } = await this.chain.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: value.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    return this.signAndSend(kp, tx.serialize());
  }

  private async jupiter(kp: Keypair, inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<SwapResult> {
    const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
    const qr = await fetch(`${this.jup}/quote?${q}`, { signal: AbortSignal.timeout(10_000) });
    const quote = (await qr.json().catch(() => ({}))) as Record<string, unknown>;
    if (!qr.ok || quote.error || !quote.outAmount) throw new NoRouteError(String(quote.error ?? `quote failed (${qr.status})`));
    const sr = await fetch(`${this.jup}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: this.priority, priorityLevel: "veryHigh" } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const swap = (await sr.json().catch(() => ({}))) as { swapTransaction?: string; error?: string };
    if (!sr.ok || !swap.swapTransaction) throw new Error(`jupiter swap failed: ${swap.error ?? sr.status}`);
    const signature = await this.signAndSend(kp, Buffer.from(swap.swapTransaction, "base64"));
    return { signature, route: "jupiter" };
  }

  private async pumpportal(kp: Keypair, action: "buy" | "sell", mint: string, amount: number, inSol: boolean, slippageBps: number): Promise<SwapResult> {
    const res = await fetch(`${this.pp}/trade-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: kp.publicKey.toBase58(),
        action,
        mint,
        amount,
        denominatedInSol: inSol ? "true" : "false",
        slippage: Math.round(slippageBps / 100),
        priorityFee: this.priority / 1e9,
        pool: "auto",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`no route for this token right now (${(await res.text().catch(() => "")).slice(0, 120) || res.status})`);
    const signature = await this.signAndSend(kp, new Uint8Array(await res.arrayBuffer()));
    return { signature, route: "pumpportal" };
  }

  private async signAndSend(kp: Keypair, bytes: Uint8Array): Promise<string> {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([kp]);
    const signature = await this.chain.rpc<string>("sendTransaction", [
      Buffer.from(tx.serialize()).toString("base64"),
      { encoding: "base64", skipPreflight: true, maxRetries: 3 },
    ]);
    await this.confirm(signature);
    return signature;
  }

  /** Wait until the network confirms, or fail if the transaction errored on-chain. */
  async confirm(signature: string): Promise<void> {
    const deadline = Date.now() + (this.opts.confirmTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const res = await this.chain
        .rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }])
        .catch(() => ({ value: [null] }));
      const s = res.value[0];
      if (s?.err) throw new Error("the trade failed on-chain (usually slippage or the price moved). nothing was spent except the network fee.");
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1500));
    }
    throw new Error(`not confirmed yet, it may still land. check solscan.io/tx/${signature}`);
  }
}
