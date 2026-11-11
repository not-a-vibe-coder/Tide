import WebSocket from "ws";
import { log } from "../log.js";
import type { Launch, LaunchStats } from "./rules.js";

export interface StreamTrade {
  mint: string;
  side: "buy" | "sell";
  trader: string;
  solAmount: number;
  marketCapSol: number;
}

/** One message from PumpPortal's data stream, or null for anything we don't use. */
export function parseStreamMessage(raw: string): { kind: "launch"; launch: Launch } | { kind: "trade"; trade: StreamTrade } | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m.mint !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  if (m.txType === "create") {
    return {
      kind: "launch",
      launch: {
        mint: m.mint,
        name: String(m.name ?? ""),
        symbol: String(m.symbol ?? ""),
        creator: String(m.traderPublicKey ?? ""),
        creatorBuyTokens: num(m.initialBuy),
        marketCapSol: num(m.marketCapSol),
        at: Date.now(),
      },
    };
  }
  if (m.txType === "buy" || m.txType === "sell") {
    return { kind: "trade", trade: { mint: m.mint, side: m.txType, trader: String(m.traderPublicKey ?? ""), solAmount: num(m.solAmount), marketCapSol: num(m.marketCapSol) } };
  }
  return null;
}

type Socket = Pick<WebSocket, "send" | "close" | "on" | "readyState">;

/**
 * PumpPortal's free live stream: every new pump.fun token the moment it's created, plus
 * trades on tokens we ask about. One connection, reconnects on its own.
 */
export class PumpStream {
  private ws: Socket | null = null;
  private stopped = false;
  private retry = 1000;
  private readonly tradeListeners = new Map<string, Set<(t: StreamTrade) => void>>();
  lastMessageAt = 0;
  launches = 0;

  constructor(
    private readonly url: string,
    private readonly onLaunch: (l: Launch) => void,
    private readonly makeSocket: (url: string) => Socket = (u) => new WebSocket(u),
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private send(msg: object) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    const ws = this.makeSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.retry = 1000;
      this.send({ method: "subscribeNewToken" });
      const keys = [...this.tradeListeners.keys()];
      if (keys.length) this.send({ method: "subscribeTokenTrade", keys });
      log.info("pump.fun stream connected");
    });
    ws.on("message", (data: unknown) => this.handle(String(data)));
    const again = () => {
      if (this.stopped || this.ws !== ws) return;
      this.ws = null;
      setTimeout(() => !this.stopped && this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    };
    ws.on("close", again);
    ws.on("error", (err: unknown) => {
      log.warn("pump.fun stream error:", err instanceof Error ? err.message : err);
      ws.close();
    });
  }

  /** Feed one raw message in (used by the socket, and by tests). */
  handle(raw: string) {
    this.lastMessageAt = Date.now();
    const msg = parseStreamMessage(raw);
    if (!msg) return;
    if (msg.kind === "launch") {
      this.launches++;
      this.onLaunch(msg.launch);
    } else for (const fn of this.tradeListeners.get(msg.trade.mint) ?? []) fn(msg.trade);
  }

  /** Follow trades on a token until the returned function is called. */
  watch(mint: string, fn: (t: StreamTrade) => void): () => void {
    let set = this.tradeListeners.get(mint);
    if (!set) {
      set = new Set();
      this.tradeListeners.set(mint, set);
      this.send({ method: "subscribeTokenTrade", keys: [mint] });
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) {
        this.tradeListeners.delete(mint);
        this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
      }
    };
  }

  /** Who bought and sold a fresh launch in its first `ms` milliseconds. */
  collect(mint: string, ms: number, startMcapSol = 0): Promise<LaunchStats> {
    const buyers = new Set<string>();
    const stats: LaunchStats = { buyers: 0, buys: 0, sells: 0, marketCapSol: startMcapSol };
    const stop = this.watch(mint, (t) => {
      if (t.side === "buy") (stats.buys++, buyers.add(t.trader));
      else stats.sells++;
      if (t.marketCapSol) stats.marketCapSol = t.marketCapSol;
    });
    return new Promise((resolve) =>
      setTimeout(() => {
        stop();
        resolve({ ...stats, buyers: buyers.size });
      }, ms),
    );
  }

  get watching(): number {
    return this.tradeListeners.size;
  }
}
