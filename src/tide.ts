import { randomUUID } from "node:crypto";
import { STABLECOINS, SUI_COIN_TYPE, diffBalances, isCash, normaliseCoinType, toUnits } from "./core/buys.js";
import { SOL_MINT, chainOf, type Chain } from "./core/chains.js";
import { proposeBudget, startOfWeekLagos, suggestSize, trackRecordMultiplier } from "./core/sizing.js";
import { DEFAULT_LAUNCH_RULES, DEFAULT_SPIKE_RULES, assessRisk, detectLaunch, detectSpike, type LaunchRules, type SpikeRules } from "./core/spike.js";
import type { SizingResult, Spike, TokenClass } from "./core/types.js";
import { NO_REASON, alertMessage, esc, holdingLine, pct, usd, type HoldingView } from "./bot/format.js";
import type { CoinInfo } from "./chain/sui.js";
import { log } from "./log.js";
import type { Market } from "./market/gecko.js";
import { SHARED_NAMESPACE, userNamespace } from "./memory/events.js";
import type { Store, User } from "./memory/store.js";
import type { Memory } from "./memory/walrus.js";

export type AlertAction = "bought" | "skipped" | "not_for_me";

export interface Button {
  text: string;
  data: string;
}

/** How Tide talks to users. The Telegram bot implements this. */
export interface Notifier {
  send(chatId: number, html: string, buttons?: Button[][]): Promise<void>;
}

const HOUR = 60 * 60 * 1000;
const POOL_COOLDOWN_MS = 6 * HOUR;
const MAX_ALERTS_PER_DAY = 8;

/** Reads one chain's wallet. Sui via Tatum gRPC, Solana via Tatum RPC. */
export interface ChainReader {
  balances(owner: string): Promise<{ coinType: string; raw: string }[]>;
  coinInfo(token: string): Promise<CoinInfo>;
  /** Solana only: tells a token mint from a wallet, since both are plain base58 addresses. */
  isMint?(address: string): Promise<boolean>;
}

export type Readers = Partial<Record<Chain, ChainReader>>;

/** Spike rules per chain. Solana is far busier, so its bar is higher. */
export type ChainRules = Partial<Record<Chain, SpikeRules>>;

/** Alerts per chain per scan, so one busy chain can't crowd out the other. */
const SPIKES_PER_CHAIN = 2;
/** Fresh-launch alerts per chain per scan, and per person per day. Launches are opt-in (/launches on). */
const LAUNCHES_PER_CHAIN = 1;
const MAX_LAUNCHES_PER_DAY = 6;

export type ChainLaunchRules = Partial<Record<Chain, LaunchRules>>;

/** Solana launches far more tokens, most of them empty, so its bar is higher. */
export const DEFAULT_CHAIN_LAUNCH_RULES: ChainLaunchRules = {
  sui: DEFAULT_LAUNCH_RULES,
  solana: { maxAgeMinutes: 60, minLiquidityUsd: 20_000, minBuysH1: 30 },
};

export class Tide {
  private notifier: Notifier | null = null;
  /** First names from Telegram, kept in memory only, used to greet people. */
  private readonly names = new Map<number, string>();

  constructor(
    readonly store: Store,
    readonly memory: Memory,
    private readonly readers: Readers,
    private readonly market: Market,
    private readonly rules: ChainRules = { sui: DEFAULT_SPIKE_RULES },
    private readonly launchRules: ChainLaunchRules = DEFAULT_CHAIN_LAUNCH_RULES,
  ) {}

  /** Chains this instance scans and reads. */
  get chains(): Chain[] {
    return (Object.keys(this.rules) as Chain[]).filter((c) => this.readers[c]);
  }

  /** A pasted Solana address could be a wallet or a token. False if it can't be checked. */
  async isSolanaMint(address: string): Promise<boolean> {
    return (await this.readers.solana?.isMint?.(address).catch(() => false)) ?? false;
  }

  private reader(token: string): ChainReader {
    const r = this.readers[chainOf(token)];
    if (!r) throw new Error(`no reader for ${chainOf(token)}`);
    return r;
  }

  private walletsOf(user: User): [Chain, string][] {
    const out: [Chain, string][] = [];
    if (user.wallet && this.readers.sui) out.push(["sui", user.wallet]);
    if (user.solWallet && this.readers.solana) out.push(["solana", user.solWallet]);
    return out;
  }

  /**
   * Read every wallet the user has and merge them into one snapshot (token IDs
   * say which chain they're on). If a chain can't be read, its last snapshot is
   * kept so its positions don't look closed.
   */
  private async readAll(user: User, previous: { coinType: string; raw: string }[] | null) {
    const merged: { coinType: string; raw: string }[] = [];
    for (const [chain, address] of this.walletsOf(user)) {
      try {
        merged.push(...(await this.readers[chain]!.balances(address)));
      } catch (err) {
        log.warn(`${chain} read failed for ${user.id}: ${err instanceof Error ? err.message : err}`);
        merged.push(...(previous ?? []).filter((b) => chainOf(b.coinType) === chain));
      }
    }
    return merged;
  }

  attach(notifier: Notifier) {
    this.notifier = notifier;
  }

  setName(userId: number, firstName: string | undefined) {
    if (firstName) this.names.set(userId, firstName);
  }

  nameOf(userId: number): string | undefined {
    return this.names.get(userId);
  }

  private async notify(chatId: number, html: string, buttons?: Button[][]) {
    if (!this.notifier) return;
    try {
      await this.notifier.send(chatId, html, buttons);
    } catch (err) {
      log.warn(`send to ${chatId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- onboarding -------------------------------------------------------

  start(userId: number, chatId: number): User {
    const existing = this.store.getUser(userId);
    if (!existing) this.memory.record(userId, { type: "profile_set", chatId, alertsOn: true });
    else if (existing.chatId !== chatId) this.memory.record(userId, { type: "profile_set", chatId });
    return this.store.getUser(userId)!;
  }

  /**
   * Save a Sui or Solana wallet, take a baseline snapshot of it, and propose a
   * weekly budget from the cash across all the user's wallets.
   */
  async setWallet(userId: number, wallet: string, chain: Chain = "sui"): Promise<{ liquidUsd: number; proposedBudget: number }> {
    this.memory.record(userId, chain === "sui" ? { type: "profile_set", wallet } : { type: "profile_set", solWallet: wallet });
    const reader = this.readers[chain];
    if (!reader) throw new Error(`${chain} isn't enabled`);
    const fresh = await reader.balances(wallet);
    const others = (this.store.getSnapshot(userId) ?? []).filter((b) => chainOf(b.coinType) !== chain);
    const balances = [...others, ...fresh];
    this.store.setSnapshot(userId, balances);
    const liquidUsd = await this.liquidUsd(balances);
    return { liquidUsd, proposedBudget: proposeBudget(liquidUsd) };
  }

  setBudget(userId: number, budgetUsd: number) {
    this.memory.record(userId, { type: "profile_set", budgetUsd });
  }

  setBaseShare(userId: number, baseShare: number) {
    this.memory.record(userId, { type: "profile_set", baseShare });
  }

  setAlerts(userId: number, on: boolean) {
    this.memory.record(userId, { type: "profile_set", alertsOn: on });
  }

  private async liquidUsd(balances: { coinType: string; raw: string }[]): Promise<number> {
    let total = 0;
    for (const b of balances) {
      if (!isCash(b.coinType)) continue;
      const info = await this.reader(b.coinType).coinInfo(b.coinType);
      const units = toUnits(b.raw, info.decimals);
      if (STABLECOINS.has(b.coinType)) {
        total += units;
      } else {
        const native = b.coinType === SOL_MINT ? SOL_MINT : SUI_COIN_TYPE;
        const q = await this.market.quote(native).catch(() => null);
        total += units * (q?.priceUsd ?? 0);
      }
    }
    return total;
  }

  // ---- wallet watcher ---------------------------------------------------

  /** Find new buys and closed positions since the last snapshot. */
  async checkWallet(user: User): Promise<number> {
    if (this.walletsOf(user).length === 0) return 0;
    const previous = this.store.getSnapshot(user.id);
    const current = await this.readAll(user, previous);
    const buys = diffBalances(previous, current);
    this.store.setSnapshot(user.id, current);

    let found = 0;
    for (const b of buys) {
      const info = await this.reader(b.coinType).coinInfo(b.coinType);
      const units = toUnits(b.rawDelta, info.decimals);
      const quote = await this.market.quote(b.coinType).catch(() => null);
      const holdingId = randomUUID();
      this.memory.record(user.id, {
        type: "buy_detected",
        holdingId,
        coinType: b.coinType,
        symbol: info.symbol,
        units,
        costUsd: quote ? units * quote.priceUsd : null,
        priceUsd: quote?.priceUsd ?? null,
        volumeH24Usd: quote?.volumeH24Usd ?? null,
      });
      this.store.addPendingReason(holdingId, user.id);
      found++;
    }

    // A holding whose coin is gone from the wallet is closed.
    const held = new Map(current.map((b) => [normaliseCoinType(b.coinType), BigInt(b.raw)]));
    const watched = new Set(this.walletsOf(user).map(([c]) => c));
    for (const h of this.store.openHoldings(user.id)) {
      if (!watched.has(chainOf(h.coinType))) continue;
      if ((held.get(normaliseCoinType(h.coinType)) ?? 0n) > 0n) continue;
      const quote = await this.market.quote(h.coinType).catch(() => null);
      const pnlPct = quote && h.entryPriceUsd ? (quote.priceUsd / h.entryPriceUsd - 1) * 100 : null;
      this.memory.record(user.id, { type: "position_closed", holdingId: h.id, symbol: h.symbol, priceUsd: quote?.priceUsd ?? null, pnlPct });
      await this.notify(user.chatId, pnlPct === null
          ? `you're out of <b>${esc(h.symbol)}</b>. noted.`
          : pnlPct >= 0
            ? `you closed <b>${esc(h.symbol)}</b> at ${pct(pnlPct)} from your entry. nice one.`
            : `you closed <b>${esc(h.symbol)}</b> at ${pct(pnlPct)} from your entry. that one stings, but you got out.`);
    }

    if (found > 0) await this.askNextReason(user);
    return found;
  }

  /** Ask about the oldest buy that has no reason yet. One question at a time. */
  async askNextReason(user: User): Promise<boolean> {
    const h = this.store.nextPendingReason(user.id);
    if (!h) return false;
    const cost = h.costUsd !== null ? ` for about ${usd(h.costUsd)}` : "";
    const name = this.names.get(user.id);
    await this.notify(
      user.chatId,
      `${greet(name)}i saw you picked up <b>${esc(h.symbol)}</b>${cost}.\nwhat made you buy it? one line is enough, i'll hold you to it.`,
      [[{ text: "skip this one", data: `skipreason:${h.id}` }]],
    );
    return true;
  }

  /** Save the user's reply as the reason for their oldest unexplained buy. */
  answerReason(userId: number, reason: string): string | null {
    const h = this.store.nextPendingReason(userId);
    if (!h) return null;
    this.memory.record(userId, { type: "buy_reason", holdingId: h.id, symbol: h.symbol, reason: reason.slice(0, 280) });
    return h.symbol;
  }

  skipReason(userId: number, holdingId: string) {
    const h = this.store.getHolding(holdingId);
    if (!h || h.userId !== userId) return;
    this.memory.record(userId, { type: "buy_reason", holdingId, symbol: h.symbol, reason: NO_REASON });
  }

  // ---- spike scanner ----------------------------------------------------

  async scan(): Promise<number> {
    const spikes: Spike[] = [];
    let failures = 0;
    for (const chain of this.chains) {
      const pools = await this.market.candidatePools(chain).catch((err) => {
        failures++;
        log.warn(`${chain} pools failed: ${err instanceof Error ? err.message : err}`);
        return [];
      });
      const fresh = (s: Spike) => !this.store.poolOnCooldown(s.pool.address, POOL_COOLDOWN_MS);
      const chainSpikes = pools
        .map((p) => detectSpike(p, this.rules[chain]))
        .filter((s): s is Spike => s !== null)
        .filter(fresh)
        .sort((a, b) => b.pool.volumeUsd.h1 - a.pool.volumeUsd.h1)
        .slice(0, SPIKES_PER_CHAIN);
      const spiking = new Set(chainSpikes.map((s) => s.pool.address));
      const launches = pools
        .filter((p) => !spiking.has(p.address))
        .map((p) => detectLaunch(p, this.launchRules[chain] ?? DEFAULT_LAUNCH_RULES))
        .filter((s): s is Spike => s !== null)
        .filter(fresh)
        .sort((a, b) => b.pool.liquidityUsd - a.pool.liquidityUsd)
        .slice(0, LAUNCHES_PER_CHAIN);
      spikes.push(...chainSpikes, ...launches);
    }
    if (failures === this.chains.length && failures > 0) throw new Error("market data unavailable");

    let sent = 0;
    for (const spike of spikes) {
      this.store.markPoolAlerted(spike.pool.address);
      const isLaunch = spike.kind === "launch";
      for (const user of this.store.usersWithAlerts()) {
        if (this.store.getPref(user.id, `mute_chain_${spike.pool.chain}`) === "true") continue;
        const dayAgo = new Date(Date.now() - 24 * HOUR);
        if (isLaunch) {
          if (this.store.getPref(user.id, "launches") !== "true") continue;
          if (this.store.recentAlertCount(user.id, dayAgo, "launch") >= MAX_LAUNCHES_PER_DAY) continue;
        } else {
          if (this.store.getPref(user.id, `mute_${spike.tokenClass}`) === "true") continue;
          if (this.store.recentAlertCount(user.id, dayAgo, "spike") >= MAX_ALERTS_PER_DAY) continue;
        }
        await this.sendAlert(user, spike);
        sent++;
      }
    }
    return sent;
  }

  sizingFor(user: User, tokenClass: TokenClass, riskMultiplier: number): SizingResult | null {
    if (user.budgetUsd === null) return null;
    const spent = this.store.spentSince(user.id, startOfWeekLagos());
    return suggestSize({
      budgetLeftUsd: user.budgetUsd - spent,
      baseShare: user.baseShare,
      trackRecord: trackRecordMultiplier(this.store.outcomes(user.id, tokenClass)),
      riskMultiplier: Math.round(riskMultiplier * 100) / 100,
    });
  }

  private async sendAlert(user: User, spike: Spike) {
    const risk = assessRisk(spike.pool);
    const sizing = this.sizingFor(user, spike.tokenClass, risk.multiplier);
    const shared = this.store.sharedWinRate(spike.tokenClass);
    const sharedNote =
      shared.total >= 5
        ? `across everyone on tide, ${spike.tokenClass === "new" ? "brand-new pools" : "established tokens"} were up 24h later on ${shared.wins} of ${shared.total} alerts.`
        : null;
    const alertId = randomUUID();
    this.memory.record(user.id, {
      type: "alert_sent",
      alertId,
      poolAddress: spike.pool.address,
      coinType: spike.pool.baseCoinType,
      symbol: spike.pool.baseSymbol,
      tokenClass: spike.tokenClass,
      priceUsd: spike.pool.priceUsd,
      marketCapUsd: spike.pool.marketCapUsd ?? spike.pool.fdvUsd,
      sizeUsd: sizing?.maxUsd ?? null,
      risk: Math.round(risk.multiplier * 100) / 100,
      trackRecord: sizing?.trackRecord ?? 1,
      reasons: spike.reasons,
      kind: spike.kind ?? "spike",
    });
    await this.notify(user.chatId, alertMessage(spike, risk, sizing, sharedNote), [
      [
        { text: "bought", data: `act:bought:${alertId}` },
        { text: "skipped", data: `act:skipped:${alertId}` },
        { text: "not for me", data: `act:not_for_me:${alertId}` },
      ],
    ]);
  }

  /** Record what the user did with an alert. "Not for me" mutes that token class. */
  handleAlertAction(userId: number, alertId: string, action: AlertAction): string {
    const alert = this.store.getAlert(alertId);
    if (!alert || alert.userId !== userId) return "that alert is too old now.";
    if (alert.action) return `already got it, you ${alert.action.replace(/_/g, " ")}.`;
    this.memory.record(userId, { type: "alert_action", alertId, symbol: alert.symbol, action });
    if (action === "not_for_me") {
      this.memory.record(userId, { type: "preference", key: `mute_${alert.tokenClass}`, value: "true" });
      return `fair. no more ${alert.tokenClass === "new" ? "brand-new pools" : "established tokens"} from me. /alerts reset brings them back.`;
    }
    return action === "bought"
      ? "noted. i'll check on it in 24 hours and tell you how it went."
      : "skipped. i'll still check how it did, so we both learn.";
  }

  /** Which chains' alerts this user gets. */
  setAlertChains(userId: number, chains: Chain[]) {
    for (const c of this.chains) {
      const muted = chains.includes(c) ? "false" : "true";
      if ((this.store.getPref(userId, `mute_chain_${c}`) ?? "false") !== muted) {
        this.memory.record(userId, { type: "preference", key: `mute_chain_${c}`, value: muted });
      }
    }
  }

  /** Opt in or out of fresh-launch alerts. */
  setLaunches(userId: number, on: boolean) {
    this.memory.record(userId, { type: "preference", key: "launches", value: on ? "true" : "false" });
  }

  unmuteAll(userId: number) {
    for (const cls of ["new", "established"] as const) {
      if (this.store.getPref(userId, `mute_${cls}`) === "true") {
        this.memory.record(userId, { type: "preference", key: `mute_${cls}`, value: "false" });
      }
    }
  }

  // ---- outcomes ---------------------------------------------------------

  /** 24h after each alert, record where the token went. This feeds the track record. */
  async resolveOutcomes(): Promise<number> {
    const due = this.store.alertsAwaitingOutcome(new Date(Date.now() - 24 * HOUR));
    const quotes = new Map<string, number | null>();
    const sharedDone = new Set<string>();
    let n = 0;
    for (const a of due) {
      if (!quotes.has(a.coinType)) {
        const q = await this.market.quote(a.coinType).catch(() => null);
        quotes.set(a.coinType, q?.priceUsd ?? null);
      }
      const now = quotes.get(a.coinType);
      if (!now || !a.priceUsd) continue;
      const changePct = Math.round((now / a.priceUsd - 1) * 1000) / 10;
      this.memory.record(a.userId, { type: "alert_outcome", alertId: a.id, symbol: a.symbol, tokenClass: a.tokenClass, changePct });
      const sharedKey = `${a.poolAddress}:${a.sentAt.slice(0, 13)}`;
      if (!sharedDone.has(sharedKey)) {
        sharedDone.add(sharedKey);
        this.memory.record(null, { type: "token_outcome", coinType: a.coinType, symbol: a.symbol, tokenClass: a.tokenClass, changePct });
      }
      n++;
    }
    return n;
  }

  // ---- reports ----------------------------------------------------------

  async holdingsReport(userId: number): Promise<string> {
    const holdings = this.store.openHoldings(userId);
    if (holdings.length === 0) return "you're not holding anything i'm tracking yet. buy something on sui and i'll notice on my next check.";
    const views: HoldingView[] = [];
    for (const h of holdings) {
      const q = await this.market.quote(h.coinType).catch(() => null);
      views.push({ holding: h, priceUsd: q?.priceUsd ?? null, volumeH24Usd: q?.volumeH24Usd ?? null });
    }
    // Biggest movers first, either direction.
    views.sort((a, b) => Math.abs(change(b)) - Math.abs(change(a)));
    return [`<b>your sui bags</b>`, ...views.map(holdingLine)].join("\n\n");
  }

  async sendDigests(): Promise<void> {
    for (const user of this.store.usersWithWallets()) {
      if (this.store.openHoldings(user.id).length === 0) continue;
      await this.notify(user.chatId, `morning. here's where your bags are.\n\n${await this.holdingsReport(user.id)}`);
    }
  }

  memoryReport(userId: number): string {
    const user = this.store.getUser(userId);
    const ns = userNamespace(userId);
    const stats = this.store.memoryStats(ns);
    const outcomesNew = this.store.outcomes(userId, "new");
    const outcomesEst = this.store.outcomes(userId, "established");
    const muted = ["new", "established"].filter((c) => this.store.getPref(userId, `mute_${c}`) === "true");
    const lines = [
      "<b>here's what i remember about you</b>",
      `wallet: ${user?.wallet ? `<code>${user.wallet}</code>` : "you haven't given me one yet"}`,
      `weekly budget: ${user?.budgetUsd != null ? usd(user.budgetUsd) : "not set"}, ${Math.round((user?.baseShare ?? 0.25) * 100)}% per alert`,
      `bags i'm watching: ${this.store.openHoldings(userId).length}`,
      `brand-new pools: ${record(outcomesNew)}, so your multiplier is ${trackRecordMultiplier(outcomesNew)}`,
      `established tokens: ${record(outcomesEst)}, so your multiplier is ${trackRecordMultiplier(outcomesEst)}`,
      `muted: ${muted.length ? muted.map((c) => (c === "new" ? "brand-new pools" : "established tokens")).join(", ") : "nothing"}`,
      "",
      `<b>walrus memory</b> (${this.memory.isDryRun ? "dry run" : "mainnet"}), namespace <code>${ns}</code>`,
      `${stats.confirmed} stored · ${stats.queued} on the way · ${stats.failed} failed${stats.dry_run ? ` · ${stats.dry_run} dry run` : ""}`,
      `shared token memory: ${this.store.eventCount(SHARED_NAMESPACE)} outcomes from everyone`,
    ];
    return lines.join("\n");
  }
}

function change(v: HoldingView): number {
  return v.priceUsd !== null && v.holding.entryPriceUsd ? v.priceUsd / v.holding.entryPriceUsd - 1 : 0;
}

function record(outcomes: boolean[]): string {
  if (outcomes.length === 0) return "no results yet";
  const recent = outcomes.slice(-10);
  return `${recent.filter(Boolean).length} of your last ${recent.length} alerts were up a day later`;
}

/** "pascal, " — names are lowercased to match the texting voice. */
function greet(name: string | undefined): string {
  return name ? `${name.toLowerCase()}, ` : "";
}
