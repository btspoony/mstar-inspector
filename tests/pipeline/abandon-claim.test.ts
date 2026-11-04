/**
 * `putAbandonClaim` — the one write path for every claim that names a commit
 * which was NOT reviewed. Its whole job is the `done` guard: `done` is the
 * durable proof a commit was reviewed, so no abandon outcome may overwrite it.
 */
import { describe, expect, test } from "bun:test";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  IDEM_DONE,
  IDEMPOTENCY_SECONDS,
  putAbandonClaim,
  type AbandonClaim,
} from "../../src/contracts/idem";

const KEY = "idem:123:acme/widgets:42:abc123";

const ABANDON_CLAIMS: AbandonClaim[] = ["dropped", "failed", "paused", "degraded", "superseded"];

/** A KV double over one entry map, recording every write. */
function kvDouble(initial: string | null, getError?: Error) {
  const writes: Array<{ key: string; value: string; options?: unknown }> = [];
  const store = new Map<string, string>();
  if (initial !== null) store.set(KEY, initial);
  const kv = {
    async get(key: string) {
      if (getError !== undefined) throw getError;
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: unknown) {
      writes.push({ key, value, options });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, writes, store };
}

describe("contracts/idem putAbandonClaim", () => {
  test("every abandon claim is written over an absent or queued claim", async () => {
    for (const claim of ABANDON_CLAIMS) {
      for (const initial of [null, "1"]) {
        const { kv, writes } = kvDouble(initial);
        await putAbandonClaim(kv, KEY, claim, IDEMPOTENCY_SECONDS);
        expect(writes).toEqual([{ key: KEY, value: claim, options: { expirationTtl: IDEMPOTENCY_SECONDS } }]);
      }
    }
  });

  test("a completed review is never downgraded", async () => {
    for (const claim of ABANDON_CLAIMS) {
      const { kv, writes, store } = kvDouble(IDEM_DONE);
      await putAbandonClaim(kv, KEY, claim, IDEMPOTENCY_SECONDS);
      expect(writes).toHaveLength(0);
      expect(store.get(KEY)).toBe(IDEM_DONE);
    }
  });

  test("a KV read fault leaves the claim untouched and never throws", async () => {
    const { kv, writes, store } = kvDouble("1", new Error("kv down"));
    await putAbandonClaim(kv, KEY, "dropped", IDEMPOTENCY_SECONDS);
    expect(writes).toHaveLength(0);
    expect(store.get(KEY)).toBe("1");
  });
});
