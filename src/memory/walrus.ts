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
  type TideEvent,
  newEvent,
} from "./events.js";
import type { Store } from "./store.js";

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

  constructor(
    private readonly store: Store,
    opts: MemoryOptions,
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

  record(userId: number | null, data: EventData): TideEvent {
    const event = newEvent(userId, data);
    this.store.apply(event);
    const p = this.persist(event).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return event;
  }

  private async persist(event: TideEvent): Promise<void> {
    const namespace = namespaceFor(event);
    if (!this.client) {
      this.store.logMemory(event.id, namespace, "dry_run");
      log.debug("memory (dry run)", encodeEvent(event));
      return;
    }
    try {
      const job = await this.client.rememberAsync(encodeEvent(event), namespace, { idempotencyKey: event.id });
      this.store.logMemory(event.id, namespace, "queued", { jobId: job.job_id });
      const done = await this.client.waitForRememberJob(job.job_id, { timeoutMs: 5 * 60_000 });
      this.store.logMemory(event.id, namespace, "confirmed", { jobId: job.job_id, blobId: done.blob_id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.logMemory(event.id, namespace, "failed", { error: message });
      log.warn(`Walrus write failed for ${event.data.type} ${event.id}: ${message}`);
    }
  }

  /** Read back every Tide event stored in a namespace. */
  async fetchNamespace(namespace: string): Promise<TideEvent[]> {
    if (!this.client) return [];
    const seen = new Map<string, TideEvent>();
    // Recall is similarity search capped at 100 per call, so ask once per event type.
    for (const type of EVENT_TYPES) {
      const res = await this.client.recall({ query: `[tide:${type}]`, limit: 100, namespace });
      for (const m of res.results) {
        const e = decodeEvent(m.text);
        if (e && e.data.type === type) seen.set(e.id, e);
      }
    }
    return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
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
    for (const ns of namespaces) fetched.set(ns, await this.fetchNamespace(ns));

    this.store.wipeDerived();
    const all = [...fetched.values()].flat().sort((a, b) => a.at.localeCompare(b.at));
    for (const e of all) this.store.apply(e);

    // Buys still missing a reason go back in the question queue.
    for (const id of userIds) {
      this.store.clearSnapshot(id);
      for (const h of this.store.openHoldings(id)) if (!h.reason) this.store.addPendingReason(h.id, id);
    }
    return Object.fromEntries([...fetched].map(([ns, evs]) => [ns, evs.length]));
  }
}
