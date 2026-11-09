import { MemWal } from "@mysten-incubation/memwal";
import { log } from "../log.js";
import {
  EVENT_TYPES,
  SHARED_NAMESPACE,
  decodeEvent,
  describe,
  encodeEvent,
  namespaceFor,
  userNamespace,
  type EventData,
  type EventType,
  type TideEvent,
  newEvent,
} from "./events.js";
import type { Store } from "./store.js";

/** Parallel writes to the Walrus relayer. Keeps a big batch (like a history backfill) from tripping rate limits. */
const WRITE_SLOTS = 2;
/** Most results one Walrus recall returns. */
const RECALL_LIMIT = 100;
const RECALL_TIMEOUT_MS = 60_000;
/** Walrus slows down when hit with many searches at once, so restores ask two at a time. */
const RECALL_SLOTS = 2;

/** Narrower search phrases for event types with more than one recall's worth of memories. */
export function recallHints(now = new Date()): string[] {
  const words = ["new token", "established token", "spike signal", "launch signal", "mover", "live alert", "Market history", "moved -", "moved 1", "moved 2", "moved 5", "sui", "solana"];
  const days: string[] = [];
  for (let i = 0; i < 45; i++) days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return [...words, ...days];
}
/** Waits before each retry of a failed write. The idempotency key makes a retry safe if the first try landed. */
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

export interface MemoryOptions {
  privateKey: string;
  accountId: string;
  serverUrl: string;
  dryRun: boolean;
  /** Inject a client (tests use the SDK's MemWalMock). */
  client?: MemoryClient;
}

/** The subset of the MemWal client Tide uses. */
export type MemoryClient = Pick<MemWal, "rememberAsync" | "waitForRememberJob" | "recall" | "health">;

/**
 * The single entry point for changing state. `record` applies an event to the
 * local cache right away and writes it to Walrus Memory in the background.
 * The cache never claims a write is stored until Walrus confirms the job.
 */
export class Memory {
  private readonly client: MemoryClient | null;
  private readonly inflight = new Set<Promise<void>>();
  /** Namespaces whose last rebuild hit the recall cap, for a follow-up deepFill. */
  lastCapped: { namespace: string; types: EventType[] }[] = [];
  /** How long one recall may take before it's skipped. */
  recallTimeoutMs = RECALL_TIMEOUT_MS;
  /** Searches during the current restore that failed, and the last reason. */
  recallStats = { ok: 0, failed: 0, lastError: "" };
  private recallActive = 0;
  private recallWaiters: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    opts: MemoryOptions,
    private readonly retryDelaysMs: number[] = RETRY_DELAYS_MS,
  ) {
    this.client =
      opts.client ??
      (opts.dryRun ? null : MemWal.create({ key: opts.privateKey, accountId: opts.accountId, serverUrl: opts.serverUrl }));
  }

  /** Wait for every background write to settle (used before shutdown and in tests). */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  get isDryRun(): boolean {
    return this.client === null;
  }

  async health(): Promise<string> {
    if (!this.client) return "dry run (no Walrus writes)";
    await this.client.health();
    return "connected to Walrus Memory Mainnet relayer";
  }

  /**
   * Apply and persist an event. With a fixed `id`, re-recording the same fact
   * is a no-op (used for history outcomes, so a re-run never double-counts).
   */
  record(userId: number | null, data: EventData, id?: string): TideEvent {
    const event = newEvent(userId, data, new Date(), id);
    if (!this.store.apply(event) && id) return event;
    const p = this.persist(event).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return event;
  }

  /** Writes waiting for a slot; at most WRITE_SLOTS go to the relayer at once. */
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private async slot(): Promise<() => void> {
    if (this.active >= WRITE_SLOTS) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  private async persist(event: TideEvent): Promise<void> {
    const namespace = namespaceFor(event);
    if (!this.client) {
      this.store.logMemory(event.id, namespace, "dry_run");
      log.debug("memory (dry run)", encodeEvent(event));
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const release = await this.slot();
      let message: string;
      try {
        const job = await this.client.rememberAsync(encodeEvent(event), namespace, { idempotencyKey: event.id });
        this.store.logMemory(event.id, namespace, "queued", { jobId: job.job_id });
        const done = await this.client.waitForRememberJob(job.job_id, { timeoutMs: 5 * 60_000 });
        this.store.logMemory(event.id, namespace, "confirmed", { jobId: job.job_id, blobId: done.blob_id });
        return;
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        release();
      }
      // Walrus already holds an event with this id (sent before a restart wiped the local copy):
      // nothing is missing, so count it as stored instead of failed.
      if (/idempotency_key was already used|\b409\b/i.test(message)) {
        this.store.logMemory(event.id, namespace, "confirmed", { error: "already on walrus" });
        return;
      }
      // A bad key won't fix itself; anything else (rate limit, timeout, relayer hiccup) gets another go.
      const permanent = /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message);
      if (permanent || attempt >= this.retryDelaysMs.length) {
        this.store.logMemory(event.id, namespace, "failed", { error: message });
        log.warn(`Walrus write failed for ${event.data.type} ${event.id} after ${attempt + 1} tries: ${message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
    }
  }

  /**
   * Try failed writes again (oldest first). Events stay in the local cache, so
   * nothing is lost while the relayer is having a bad moment. Returns how many were re-sent.
   */
  retryFailed(limit = 40): number {
    const events = this.store.failedEvents(limit);
    for (const e of events) {
      const p = this.persist(e).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
    return events.length;
  }

  /** Read back every Tide event stored in a namespace. */
  /** One recall with a time limit, so a slow search can't stall a restore. */
  private async recallSafe(namespace: string, query: string): Promise<string[]> {
    if (!this.client) return [];
    while (this.recallActive >= RECALL_SLOTS) await new Promise<void>((r) => this.recallWaiters.push(r));
    this.recallActive++;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("recall timed out")), this.recallTimeoutMs)));
    try {
      const res = await Promise.race([this.client.recall({ query, limit: RECALL_LIMIT, namespace }), timeout]);
      this.recallStats.ok++;
      return res.results.map((m) => m.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recallStats.failed++;
      this.recallStats.lastError = msg;
      log.warn(`recall "${query}" in ${namespace} failed: ${msg}`);
      return [];
    } finally {
      clearTimeout(timer);
      this.recallActive--;
      this.recallWaiters.shift()?.();
    }
  }

  /** Decode recall texts of one type into `seen`; returns how many were new. */
  private collect(texts: string[], type: string, seen: Map<string, TideEvent>): number {
    let added = 0;
    for (const t of texts) {
      const e = decodeEvent(t);
      if (e && e.data.type === type && !seen.has(e.id)) (seen.set(e.id, e), added++);
    }
    return added;
  }

  /**
   * Everything in a namespace, one recall per event type (fast). `full` lists the types that
   * hit the 100-result cap, for deepFill to dig into later.
   */
  async fetchNamespaceShallow(namespace: string): Promise<{ events: TideEvent[]; full: EventType[] }> {
    const seen = new Map<string, TideEvent>();
    const full: EventType[] = [];
    await Promise.all(
      EVENT_TYPES.map(async (type) => {
        const texts = await this.recallSafe(namespace, `[tide:${type}]`);
        this.collect(texts, type, seen);
        if (texts.length >= RECALL_LIMIT) full.push(type);
      }),
    );
    return { events: [...seen.values()].sort((a, b) => a.at.localeCompare(b.at)), full };
  }

  /**
   * More of the types that hit the cap, through narrower searches (class, kind, chain, recent
   * dates), a few at a time, until the time budget runs out. Returns only events not in `known`.
   */
  async deepFill(namespace: string, types: EventType[], known: Set<string>, budgetMs = 4 * 60_000): Promise<TideEvent[]> {
    const deadline = Date.now() + budgetMs;
    const found = new Map<string, TideEvent>();
    for (const id of known) found.set(id, null as never);
    for (const type of types) {
      const hints = recallHints();
      for (let i = 0; i < hints.length && Date.now() < deadline; i += 4) {
        const batch = await Promise.all(hints.slice(i, i + 4).map((h) => this.recallSafe(namespace, `[tide:${type}] ${h}`)));
        for (const texts of batch) this.collect(texts, type, found);
      }
    }
    return [...found.values()].filter((e): e is TideEvent => e !== null && !known.has(e.id));
  }

  /** Shallow fetch plus a deep fill of capped types: the whole namespace, as far as recall allows. */
  async fetchNamespace(namespace: string, budgetMs?: number): Promise<TideEvent[]> {
    const { events, full } = await this.fetchNamespaceShallow(namespace);
    if (!full.length) return events;
    const more = await this.deepFill(namespace, full, new Set(events.map((e) => e.id)), budgetMs);
    return [...events, ...more].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Apply events that may be older than what's local without disturbing newer state (outcomes, alerts). */
  applyMore(events: TideEvent[]): number {
    let n = 0;
    for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) if (this.store.apply(e)) n++;
    return n;
  }


  /**
   * Memories about this user that relate to what they just said, via Walrus
   * semantic recall (like Jasmine: anything past distance 0.8 is unrelated).
   * Falls back to their most recent local events if Walrus is unavailable.
   */
  async recallFor(userId: number, query: string, limit = 6): Promise<string[]> {
    const line = (e: TideEvent) => `${e.at.slice(0, 10)}: ${describe(e)}`;
    if (this.client) {
      try {
        const res = await this.client.recall({ query, limit, namespace: userNamespace(userId), maxDistance: 0.8 });
        const events = res.results.map((m) => decodeEvent(m.text)).filter((e): e is TideEvent => e !== null);
        if (events.length) return events.map(line);
      } catch (err) {
        log.debug("recall failed, using local events:", err instanceof Error ? err.message : err);
      }
    }
    return this.store.recentEvents(userId, limit).map(line);
  }

  /**
   * The wipe test: drop the local cache and rebuild it from Walrus Memory alone.
   * Returns how many events were recovered per namespace.
   */
  async rebuild(userIds: number[]): Promise<Record<string, number>> {
    if (!this.client) throw new Error("Rebuild needs Walrus Memory credentials (dry run is on).");
    await this.flush();
    const namespaces = [SHARED_NAMESPACE, ...userIds.map(userNamespace)];
    const fetched = new Map<string, TideEvent[]>();
    this.lastCapped = [];
    await Promise.all(
      namespaces.map(async (ns) => {
        const { events, full } = await this.fetchNamespaceShallow(ns);
        fetched.set(ns, events);
        if (full.length) this.lastCapped.push({ namespace: ns, types: full });
      }),
    );

    // Merge with what's already local (things done since this server started, and writes Walrus
    // hasn't indexed yet), then replay everything in time order so the latest change wins.
    const byId = new Map<string, TideEvent>();
    for (const e of [...fetched.values()].flat()) byId.set(e.id, e);
    for (const e of this.store.allEvents()) if (!byId.has(e.id)) byId.set(e.id, e);
    const all = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
    this.store.wipeDerived();
    for (const e of all) this.store.apply(e);

    // Buys still missing a reason go back in the question queue.
    for (const id of userIds) {
      this.store.clearSnapshot(id);
      for (const h of this.store.openHoldings(id)) if (!h.reason) this.store.addPendingReason(h.id, id);
    }
    return Object.fromEntries([...fetched].map(([ns, evs]) => [ns, evs.length]));
  }
}
