import { describe, expect, it } from "vitest";
import { Store } from "../src/memory/store.js";
import { Memory, type MemoryClient } from "../src/memory/walrus.js";

/** A relayer that fails the first `failures` calls with `error`, then works. */
function flaky(failures: number, error = "429 Too Many Requests") {
  let calls = 0;
  const client = {
    calls: () => calls,
    rememberAsync: async () => {
      calls++;
      if (calls <= failures) throw new Error(error);
      return { job_id: `job${calls}` };
    },
    waitForRememberJob: async () => ({ blob_id: "blob" }),
    recall: async () => ({ results: [] }),
    health: async () => ({}),
  };
  return client as unknown as MemoryClient & { calls: () => number };
}

const setup = (client: MemoryClient) => {
  const store = new Store(":memory:");
  return { store, memory: new Memory(store, { privateKey: "", accountId: "", serverUrl: "", dryRun: false, client }, [1, 1, 1]) };
};

describe("Walrus writes survive a bad moment", () => {
  it("retries a rate-limited write until it lands", async () => {
    const client = flaky(2);
    const { store, memory } = setup(client);
    memory.record(1, { type: "profile_set", chatId: 1, budgetUsd: 30 });
    await memory.flush();
    expect(client.calls()).toBe(3);
    expect(store.memoryStats()).toMatchObject({ confirmed: 1, failed: 0 });
  });

  it("gives up on a bad key straight away and says why", async () => {
    const client = flaky(99, "401 Unauthorized");
    const { store, memory } = setup(client);
    memory.record(1, { type: "profile_set", chatId: 1 });
    await memory.flush();
    expect(client.calls()).toBe(1);
    expect(store.memoryStats().failed).toBe(1);
    expect(store.topFailure()).toEqual({ error: "401 Unauthorized", n: 1 });
  });

  it("re-sends failed writes later from the local copy", async () => {
    const client = flaky(4);
    const { store, memory } = setup(client);
    memory.record(1, { type: "profile_set", chatId: 1, budgetUsd: 30 });
    await memory.flush();
    expect(store.memoryStats().failed).toBe(1);
    expect(memory.retryFailed()).toBe(1);
    await memory.flush();
    expect(store.memoryStats()).toMatchObject({ confirmed: 1, failed: 0 });
  });
});
