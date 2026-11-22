import { describe, expect, test } from "bun:test";
import { idemKey, IDEMPOTENCY_SECONDS, isEnqueuedClaim, type IdempotencyKey } from "../../src/contracts/idem";

const KEY: IdempotencyKey = {
  installation_id: 12345,
  owner: "acme",
  repo: "inspector",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

describe("contracts/idem", () => {
  test("key format snapshot: idem:{installation_id}:{owner}/{repo}:{pr_number}:{head_sha}", () => {
    expect(idemKey(KEY)).toBe("idem:12345:acme/inspector:42:0123456789abcdef0123456789abcdef01234567");
  });

  test("IDEMPOTENCY_SECONDS is 86400 (24h)", () => {
    expect(IDEMPOTENCY_SECONDS).toBe(86400);
  });

  test("an empty head_sha cannot generate a key", () => {
    expect(() => idemKey({ ...KEY, head_sha: "" })).toThrow(/head_sha must be a non-empty string/);
  });

  test("a null head_sha cannot generate a key", () => {
    expect(() => idemKey({ ...KEY, head_sha: null as unknown as string })).toThrow(
      /head_sha must be a non-empty string/,
    );
  });

  test("isEnqueuedClaim: queued and done skip a redelivery; every other state re-enqueues", () => {
    for (const claim of ["1", "done"] as const) {
      expect(isEnqueuedClaim(claim)).toBe(true);
    }
    for (const claim of ["superseded", "dropped", "failed", "paused", "degraded", null] as const) {
      expect(isEnqueuedClaim(claim)).toBe(false);
    }
  });
});
