import type { Keypair } from "@solana/web3.js";
import { SOL_MINT } from "../core/chains.js";
import { log } from "../log.js";
import type { Market } from "../market/gecko.js";
import type { PositionRow, Store } from "../memory/store.js";
import type { Memory } from "../memory/walrus.js";
import type { Button } from "../tide.js";
import { creatorPct, exitHit, launchMiss, readRules, RULE_KEYS, type Launch, type LaunchStats, type SnipeRules } from "./rules.js";
import type { PumpStream } from "./stream.js";
import type { SwapResult } from "./trader.js";
import { deriveTradingKeypair, exportSecret } from "./wallet.js";

/** What the desk needs from SolanaTrader (a fake in tests). */
export interface TraderLike {
  lamports(owner: string): Promise<bigint>;
  tokenBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number }>;
  buy(kp: Keypair, mint: string, lamports: bigint, slippageBps: number, pumpFirst?: boolean): Promise<SwapResult>;
  sell(kp: Keypair, mint: string, raw: bigint, decimals: number, slippageBps: number): Promise<SwapResult>;
  transfer(kp: Keypair, to: string, lamports: bigint): Promise<string>;
}

export interface DeskOptions {
  /** Master secret every trading wallet is derived from; trading is off without it. */
  masterSeed: string | null;
  /** Largest single trade, in SOL. */
  maxTradeSol: number;
  /** Most a user can spend in 24 hours unless they raise it, in SOL. */
  dailySolCap: number;
  slippageBps: number;
  /** Wait between balance checks after a trade (lower in tests). */
  pollMs?: number;
}

export interface TradeOutcome {
  ok: boolean;
  text: string;
  buttons?: Button[][];
}

type Notify = (chatId: number, html: string, buttons?: Button[][]) => Promise<void>;

const LAMPORTS = 1_000_000_000;
/** SOL kept back on every buy for fees and the new token account. */
const FEE_BUFFER = 0.004;
const DAY = 24 * 3_600_000;
const sol = (lamports: bigint | number) => Number(lamports) / LAMPORTS;
const fmtSol = (n: number) => (n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/\.?0+$/, "");
const usd = (n: number) => (Math.abs(n) >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
const short = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2));
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const txLink = (sig: string) => `<a href="https://solscan.io/tx/${sig}">view tx</a>`;

/**
 * The trading side of Tide: each user's Solana trading wallet, buys and sells, take-profit and
 * stop-loss, and the sniper. Every trade is recorded on Walrus Memory (never any key).
 */
export class TradeDesk {
  private readonly busy = new Set<string>();
  private readonly livePrice = new Map<string, { mcapSol: number; at: number }>();
  private readonly liveStops = new Map<string, () => void>();
  private readonly launchAlerts = new Map<number, number[]>();
  private solUsdCache = { value: 0, at: 0 };
  stream: PumpStream | null = null;
  snipesSeen = 0;

  constructor(
    readonly store: Store,
    readonly memory: Memory,
    private readonly trader: TraderLike,
    private readonly market: Pick<Market, "quote" | "symbol">,
    private readonly notify: Notify,
    private readonly opts: DeskOptions,
  ) {}

  get enabled(): boolean {
    return !!this.opts.masterSeed;
  }

  // ---- wallet -------------------------------------------------------------

  keypair(userId: number): Keypair {
    if (!this.opts.masterSeed) throw new Error("trading is not switched on");
    return deriveTradingKeypair(this.opts.masterSeed, userId, Number(this.store.getPref(userId, "trade_wallet_index") ?? 0));
  }

  address(userId: number): string {
    return this.keypair(userId).publicKey.toBase58();
  }

  acknowledged(userId: number): boolean {
    return this.store.getPref(userId, "trade_ack") === "true";
  }

  acknowledge(userId: number) {
    this.memory.record(userId, { type: "preference", key: "trade_ack", value: "true" });
  }

  exportKey(userId: number): string {
    return exportSecret(this.keypair(userId));
  }

  async balanceSol(userId: number): Promise<number> {
    return sol(await this.trader.lamports(this.address(userId)));
  }

  /** One-tap buy sizes in SOL. */
  buyAmounts(userId: number): number[] {
    const v = this.store.getPref(userId, "trade_amounts");
    const list = (v ?? "0.05,0.1,0.25").split(",").map(Number).filter((n) => n > 0);
    return list.length ? list.slice(0, 3) : [0.05, 0.1, 0.25];
  }

  setBuyAmounts(userId: number, amounts: number[]) {
    this.memory.record(userId, { type: "preference", key: "trade_amounts", value: amounts.slice(0, 3).join(",") });
  }

  /** Take-profit / stop-loss for manual buys (null = off). */
  manualExits(userId: number): { tp: number | null; sl: number | null } {
    const n = (k: string) => {
      const v = this.store.getPref(userId, k);
      return v === null || v === "off" ? null : Number(v);
    };
    return { tp: n("tp_pct"), sl: n("sl_pct") };
  }

  setExits(userId: number, which: "tp" | "sl", value: number | null) {
    const v = value === null ? "off" : String(value);
    this.memory.record(userId, { type: "preference", key: `${which}_pct`, value: v });
    this.memory.record(userId, { type: "preference", key: which === "tp" ? RULE_KEYS.tpPct : RULE_KEYS.slPct, value: v });
  }

  rules(userId: number): SnipeRules {
    return readRules((k) => this.store.getPref(userId, k));
  }

  setRule<K extends keyof SnipeRules>(userId: number, field: K, value: SnipeRules[K]) {
    this.memory.record(userId, { type: "preference", key: RULE_KEYS[field], value: value === null ? "off" : String(value) });
  }

  async solUsd(): Promise<number> {
    if (Date.now() - this.solUsdCache.at < 60_000 && this.solUsdCache.value) return this.solUsdCache.value;
    const q = await this.market.quote(SOL_MINT).catch(() => null);
    if (q?.priceUsd) this.solUsdCache = { value: q.priceUsd, at: Date.now() };
    return this.solUsdCache.value;
  }

  // ---- trading ------------------------------------------------------------

  private ready(userId: number): string | null {
    if (!this.enabled) return "trading isn't switched on for this bot yet.";
    if (!this.acknowledged(userId)) return "open /trade first to set up your trading wallet.";
    return null;
  }

  /** Buy `amountSol` of a token. Checks the per-trade cap, the 24h cap and the balance first. */
  async buy(
    userId: number,
    mint: string,
    amountSol: number,
    source: "manual" | "snipe" = "manual",
    extra: { symbol?: string; pumpFirst?: boolean; marketCapSol?: number; tp?: number | null; sl?: number | null } = {},
  ): Promise<TradeOutcome> {
    const notReady = this.ready(userId);
    if (notReady) return { ok: false, text: notReady };
    if (!(amountSol > 0)) return { ok: false, text: "how much sol? like <code>buy 0.1 sol of BONK</code>." };
    if (amountSol > this.opts.maxTradeSol) return { ok: false, text: `that's over the ${this.opts.maxTradeSol} sol limit per trade.` };
    const lamports = BigInt(Math.round(amountSol * LAMPORTS));
    const cap = Number(this.store.getPref(userId, "daily_sol_cap") ?? this.opts.dailySolCap);
    const spent = this.store.lamportsSpentSince(userId, new Date(Date.now() - DAY));
    if (sol(spent + lamports) > cap) {
      return { ok: false, text: `that would take you past your ${cap} sol daily limit (${fmtSol(sol(spent))} used in the last 24h). say <code>daily limit 2 sol</code> to change it.` };
    }
    const key = `${userId}:${mint}`;
    if (this.busy.has(key)) return { ok: false, text: "already working on a trade for that token, give it a few seconds." };
    this.busy.add(key);
    try {
      const kp = this.keypair(userId);
      const owner = kp.publicKey.toBase58();
      const have = sol(await this.trader.lamports(owner));
      if (have < amountSol + FEE_BUFFER) {
        return { ok: false, text: `not enough sol. you have ${fmtSol(have)}, this needs about ${fmtSol(amountSol + FEE_BUFFER)} with fees. send sol to <code>${owner}</code>.` };
      }
      const symbol = extra.symbol || (await this.market.symbol(mint).catch(() => null)) || mint.slice(0, 4);
      const before = await this.trader.tokenBalance(owner, mint);
      const res = await this.trader.buy(kp, mint, lamports, this.opts.slippageBps, extra.pumpFirst);
      const after = await this.settledBalance(owner, mint, before.raw, "up");
      const got = after.raw - before.raw;
      const solUsd = await this.solUsd();
      const exits = source === "snipe" ? { tp: extra.tp ?? null, sl: extra.sl ?? null } : this.manualExits(userId);
      if (got > 0n) {
        this.memory.record(userId, {
          type: "trade",
          side: "buy",
          mint,
          symbol,
          lamports: lamports.toString(),
          tokensRaw: got.toString(),
          decimals: after.decimals,
          signature: res.signature,
          solUsd,
          source,
          marketCapSol: extra.marketCapSol,
          tpPct: exits.tp,
          slPct: exits.sl,
        });
        if (extra.marketCapSol) this.trackLive(mint);
      }
      const exitNote = [exits.tp !== null ? `take profit at +${exits.tp}%` : null, exits.sl !== null ? `stop loss at -${exits.sl}%` : null].filter(Boolean).join(", ");
      return {
        ok: true,
        text: [
          got > 0n
            ? `bought <b>${short(units(got, after.decimals))} ${esc(symbol)}</b> for ${fmtSol(amountSol)} sol${solUsd ? ` (${usd(amountSol * solUsd)})` : ""}. ${txLink(res.signature)}`
            : `the buy went through but the tokens aren't showing yet. ${txLink(res.signature)}`,
          exitNote ? `i'll ${exitNote}.` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        buttons: [this.sellButtons(mint)],
      };
    } catch (err) {
      return { ok: false, text: `couldn't buy: ${esc(err instanceof Error ? err.message : String(err))}` };
    } finally {
      this.busy.delete(key);
    }
  }

  /** Sell `percent` of what the wallet holds of a token. */
  async sell(userId: number, mint: string, percent: number, source: "manual" | "take_profit" | "stop_loss" = "manual"): Promise<TradeOutcome> {
    const notReady = this.ready(userId);
    if (notReady) return { ok: false, text: notReady };
    const key = `${userId}:${mint}`;
    if (this.busy.has(key)) return { ok: false, text: "already working on a trade for that token." };
    this.busy.add(key);
    try {
      const kp = this.keypair(userId);
      const owner = kp.publicKey.toBase58();
      const held = await this.trader.tokenBalance(owner, mint);
      if (held.raw === 0n) {
        // Nothing left on-chain: drop any stale position so it stops showing.
        const pos = this.store.position(userId, mint);
        if (pos) this.recordSell(userId, pos, BigInt(pos.tokens_raw), 0n, "manual-cleanup", source);
        return { ok: false, text: "you don't hold any of that in your trading wallet." };
      }
      const p = Math.min(100, Math.max(1, percent));
      const amount = p === 100 ? held.raw : (held.raw * BigInt(Math.round(p * 100))) / 10_000n;
      const solBefore = await this.trader.lamports(owner);
      const res = await this.trader.sell(kp, mint, amount, held.decimals, this.opts.slippageBps);
      const solAfter = await this.settledLamports(owner, solBefore);
      const received = solAfter > solBefore ? solAfter - solBefore : 0n;
      const pos = this.store.position(userId, mint);
      const symbol = pos?.symbol ?? (await this.market.symbol(mint).catch(() => null)) ?? mint.slice(0, 4);
      let pnl = "";
      if (pos) {
        const share = Math.min(1, Number(amount) / Number(BigInt(pos.tokens_raw) || 1n));
        const costPart = Number(pos.cost_lamports) * share;
        if (costPart > 0 && received > 0n) pnl = ` that's ${pct((Number(received) / costPart - 1) * 100)} on what you put in.`;
        this.recordSell(userId, pos, amount, received, res.signature, source);
      }
      const solUsd = await this.solUsd();
      const why = source === "take_profit" ? "🎯 take profit hit. " : source === "stop_loss" ? "🛑 stop loss hit. " : "";
      return {
        ok: true,
        text: `${why}sold ${p === 100 ? "all" : `${p}%`} of <b>${esc(symbol)}</b> for ${fmtSol(sol(received))} sol${solUsd ? ` (${usd(sol(received) * solUsd)})` : ""}.${pnl} ${txLink(res.signature)}`,
      };
    } catch (err) {
      return { ok: false, text: `couldn't sell: ${esc(err instanceof Error ? err.message : String(err))}` };
    } finally {
      this.busy.delete(key);
    }
  }

  private recordSell(userId: number, pos: PositionRow, amount: bigint, received: bigint, signature: string, source: "manual" | "take_profit" | "stop_loss") {
    this.memory.record(userId, {
      type: "trade",
      side: "sell",
      mint: pos.mint,
      symbol: pos.symbol,
      lamports: received.toString(),
      tokensRaw: amount.toString(),
      decimals: pos.decimals,
      signature,
      solUsd: this.solUsdCache.value,
      source,
    });
  }

  /** Send SOL out of the trading wallet. */
  async withdraw(userId: number, to: string, amount: number | "all"): Promise<TradeOutcome> {
    const notReady = this.ready(userId);
    if (notReady) return { ok: false, text: notReady };
    try {
      const kp = this.keypair(userId);
      const have = await this.trader.lamports(kp.publicKey.toBase58());
      const lamports = amount === "all" ? have - 5_000n : BigInt(Math.round(amount * LAMPORTS));
      if (lamports <= 0n || lamports + 5_000n > have) return { ok: false, text: `not enough sol. the wallet has ${fmtSol(sol(have))}.` };
      const sig = await this.trader.transfer(kp, to, lamports);
      return { ok: true, text: `sent ${fmtSol(sol(lamports))} sol to <code>${to}</code>. ${txLink(sig)}` };
    } catch (err) {
      return { ok: false, text: `couldn't send: ${esc(err instanceof Error ? err.message : String(err))}` };
    }
  }

  sellButtons(mint: string): Button[] {
    return [
      { text: "sell 50%", data: `s:${mint}:50` },
      { text: "sell all", data: `s:${mint}:100` },
    ];
  }

  buyButtons(userId: number, mint: string): Button[] {
    return this.buyAmounts(userId).map((a) => ({ text: `buy ${a} sol`, data: `b:${mint}:${a}` }));
  }

  /** Current value and change of each open position. */
  async valued(userId: number): Promise<{ pos: PositionRow; valueUsd: number | null; changePct: number | null }[]> {
    const out = [];
    for (const pos of this.store.positions(userId)) out.push({ pos, ...(await this.valueOf(pos)) });
    return out;
  }

  private async valueOf(pos: PositionRow): Promise<{ valueUsd: number | null; changePct: number | null }> {
    const live = this.livePrice.get(pos.mint);
    if (pos.entry_mcap_sol && live && Date.now() - live.at < 120_000) {
      const change = (live.mcapSol / pos.entry_mcap_sol - 1) * 100;
      return { valueUsd: pos.cost_usd * (1 + change / 100), changePct: change };
    }
    const q = await this.market.quote(pos.mint).catch(() => null);
    if (!q?.priceUsd) return { valueUsd: null, changePct: null };
    const valueUsd = q.priceUsd * units(BigInt(pos.tokens_raw), pos.decimals);
    return { valueUsd, changePct: pos.cost_usd > 0 ? (valueUsd / pos.cost_usd - 1) * 100 : null };
  }

  /** Sell positions that hit their take-profit or stop-loss. Runs every minute and on live trades. */
  async checkExits(onlyMint?: string): Promise<number> {
    let sold = 0;
    for (const pos of this.store.allPositions()) {
      if (onlyMint && pos.mint !== onlyMint) continue;
      if (pos.tp_pct === null && pos.sl_pct === null) continue;
      const { changePct } = await this.valueOf(pos);
      if (changePct === null) continue;
      const hit = exitHit(changePct, pos.tp_pct, pos.sl_pct);
      if (!hit) continue;
      const res = await this.sell(pos.user_id, pos.mint, 100, hit);
      const user = this.store.getUser(pos.user_id);
      if (user) await this.notify(user.chatId, res.ok ? res.text : `tried to ${hit.replace("_", " ")} on ${esc(pos.symbol)} but ${res.text}`);
      if (res.ok) sold++;
    }
    this.pruneLive();
    return sold;
  }

  // ---- sniper -------------------------------------------------------------

  /** Follow live trades on a token so exits react in seconds, not minutes. */
  trackLive(mint: string) {
    if (!this.stream || this.liveStops.has(mint)) return;
    let last = 0;
    this.liveStops.set(
      mint,
      this.stream.watch(mint, (t) => {
        if (t.marketCapSol) this.livePrice.set(mint, { mcapSol: t.marketCapSol, at: Date.now() });
        if (Date.now() - last > 5_000) {
          last = Date.now();
          void this.checkExits(mint).catch((err) => log.warn("live exit check failed:", err));
        }
      }),
    );
  }

  private pruneLive() {
    const open = new Set(this.store.allPositions().map((p) => p.mint));
    for (const [mint, stop] of this.liveStops) if (!open.has(mint)) (stop(), this.liveStops.delete(mint), this.livePrice.delete(mint));
  }

  /** After a restart, keep following the tokens people still hold. */
  resumeLive() {
    for (const p of this.store.allPositions()) if (p.entry_mcap_sol) this.trackLive(p.mint);
  }

  /** A new pump.fun token: check everyone's rules, then snipe or send a one-tap alert. */
  async onLaunch(l: Launch): Promise<number> {
    if (!this.enabled) return 0;
    this.snipesSeen++;
    const ids = new Set([...this.store.usersWithPref(RULE_KEYS.auto, "true"), ...this.store.usersWithPref(RULE_KEYS.alerts, "true")]);
    if (!ids.size) return 0;
    const solUsd = await this.solUsd();
    if (!solUsd) return 0;
    const fits = [...ids]
      .map((id) => ({ id, r: this.rules(id) }))
      .filter(({ r }) => {
        const miss = launchMiss(l, null, r, solUsd);
        return miss === null || miss === "waiting for buyers";
      });
    if (!fits.length) return 0;
    const waitSec = Math.max(0, ...fits.map(({ r }) => (r.minBuyers > 0 ? r.windowSec : 0)));
    let stats: LaunchStats | null = null;
    if (waitSec > 0) {
      if (!this.stream || this.stream.watching > 40) return 0;
      stats = await this.stream.collect(l.mint, waitSec * 1000, l.marketCapSol);
    }
    let acted = 0;
    for (const { id, r } of fits) {
      if (launchMiss(l, stats, r, solUsd)) continue;
      const user = this.store.getUser(id);
      if (!user) continue;
      const mcapUsd = (stats?.marketCapSol ?? l.marketCapSol) * solUsd;
      const facts = `mcap ${usd(mcapUsd)} · creator holds ${creatorPct(l).toFixed(1)}%${stats ? ` · ${stats.buyers} buyers, ${stats.sells} sells in ${r.windowSec}s` : ""}`;
      const today = this.store.countTrades(id, new Date(Date.now() - DAY), "snipe");
      if (r.auto && this.acknowledged(id) && today < r.maxPerDay) {
        const res = await this.buy(id, l.mint, r.sol, "snipe", { symbol: l.symbol, pumpFirst: true, marketCapSol: stats?.marketCapSol ?? l.marketCapSol, tp: r.tpPct, sl: r.slPct });
        await this.notify(user.chatId, `🎯 <b>sniped ${esc(l.name || l.symbol)}</b> (${esc(l.symbol)})\n${facts}\n${res.text}`, res.buttons);
        if (res.ok) acted++;
      } else if (r.alerts || (r.auto && today >= r.maxPerDay)) {
        if (!this.allowAlert(id)) continue;
        await this.notify(
          user.chatId,
          `🎯 <b>new launch that fits your rules: ${esc(l.name || l.symbol)}</b> (${esc(l.symbol)})\n${facts}\n<code>${l.mint}</code>\nmost launches go to zero, size like you'll lose it. nfa.`,
          [this.buyButtons(id, l.mint), [{ text: "open on pump.fun", data: "pf", url: `https://pump.fun/coin/${l.mint}` }]],
        );
        acted++;
      }
    }
    return acted;
  }

  /** At most 6 launch alerts an hour per person. */
  private allowAlert(userId: number): boolean {
    const now = Date.now();
    const recent = (this.launchAlerts.get(userId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= 6) return false;
    recent.push(now);
    this.launchAlerts.set(userId, recent);
    return true;
  }

  // ---- helpers ------------------------------------------------------------

  /** Token balance after a trade, polled briefly because RPC nodes can lag a block or two. */
  private async settledBalance(owner: string, mint: string, before: bigint, dir: "up" | "down") {
    let last = await this.trader.tokenBalance(owner, mint);
    for (let i = 0; i < 4 && (dir === "up" ? last.raw <= before : last.raw >= before); i++) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1500));
      last = await this.trader.tokenBalance(owner, mint);
    }
    return last;
  }

  private async settledLamports(owner: string, before: bigint): Promise<bigint> {
    let last = await this.trader.lamports(owner);
    for (let i = 0; i < 4 && last <= before; i++) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1500));
      last = await this.trader.lamports(owner);
    }
    return last;
  }
}
