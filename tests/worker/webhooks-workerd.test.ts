/**
 * Workerd-equivalent signature verification tests (QC F-001 + F-005).
 *
 * On the deployed Worker, wrangler resolves `@octokit/webhooks-methods` via
 * the `browser` condition → WebCrypto verify → `hexToUInt8Array` throws a
 * TypeError on malformed (non-hex) signatures, while Bun/node resolves the
 * `node` condition → `timingSafeEqual` → returns false. The `verifySignature`
 * seam reproduces the workerd throw path and locks the behavior both
 * runtimes must share: malformed signature → 401, never 500, with a
 * structured stage-labeled warning (plan 15 log hygiene).
 *
 * The `getWebhooks` accessor is used to lock the module-level verifier
 * cache (F-005 + plan 15 L1): the hot path must not build a `Webhooks`
 * instance per request, cacheKeys are isolated, and a secret mismatch
 * (rotation) rebuilds + replaces the entry.
 */
import { describe, expect, mock, test } from "bun:test";
import { classifyWebhook, getWebhooks, verifySignature } from "../../src/worker/webhooks";
import type { Env } from "../../src/worker/env";

const SECRET = "s3cret-webhook-secret";

/** The workerd WebCrypto throw: `hexToUInt8Array` on non-hex input. */
const workerdVerify = async (): Promise<boolean> => {
  throw new TypeError("Cannot read properties of null (reading 'map')");
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    // T4: these tests exercise the ENABLED path (kill-switch off would turn
    // every webhook into a 200 ignore before signature verification).
    REVIEW_ENABLED: "true",
    ...overrides,
  };
}

describe("verifySignature — workerd hex-decode throw path (F-001)", () => {
  test("a throwing verifier yields false (401), not an uncaught 500", async () => {
    const valid = await verifySignature(workerdVerify, "{}", "sha256=zz");
    expect(valid).toBe(false);
  });

  test("a throwing verifier logs a structured warning with a stage-label event", async () => {
    const warn = mock((_fields: unknown, _msg?: string) => {});
    const valid = await verifySignature(workerdVerify, "{}", "sha256=zz", {
      info: mock(() => {}),
      warn,
    });

    expect(valid).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] ?? [];
    // Plan 15 log hygiene: no literal "unknown" — the direct call passes no
    // event, so the warn falls back to the stage label.
    expect(fields).toMatchObject({
      event: "signature_verification_error",
      reason: "signature verification threw",
      detail: "Cannot read properties of null (reading 'map')",
    });
    expect(msg).toContain("malformed signature");
  });

  test("a false verifier yields false without logging", async () => {
    const warn = mock((_fields: unknown, _msg?: string) => {});
    const valid = await verifySignature(async () => false, "{}", "sha256=deadbeef", {
      info: mock(() => {}),
      warn,
    });

    expect(valid).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("classifyWebhook — malformed signatures fail closed with 401 (F-001)", () => {
  test("malformed signature (non-hex) is rejected with 401, not 500", async () => {
    const outcome = await classifyWebhook(SECRET, "{}", "sha256=zz", "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "signature verification failed" });
  });

  test("empty digest (sha256=) is rejected with 401", async () => {
    const outcome = await classifyWebhook(SECRET, "{}", "sha256=", "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "signature verification failed" });
  });

  test("non-sha256 prefix is rejected with 401", async () => {
    const outcome = await classifyWebhook(SECRET, "{}", "md5=deadbeef", "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "signature verification failed" });
  });
});

describe("module-level verifier cache (F-005 + plan 15 L1)", () => {
  test("getWebhooks returns the same instance across calls for one cacheKey", () => {
    const first = getWebhooks("workerd-test-key", SECRET);
    const second = getWebhooks("workerd-test-key", SECRET);
    expect(second).toBe(first);
  });

  test("distinct cacheKeys never share an instance (per-App row-id isolation)", () => {
    const legacy = getWebhooks("legacy", SECRET);
    const perApp = getWebhooks("some-app-row-id", SECRET);
    expect(perApp).not.toBe(legacy);
    // Same key again → the memoized instance (not a third one).
    expect(getWebhooks("legacy", SECRET)).toBe(legacy);
  });

  test("secret mismatch on the same cacheKey → rebuild + REPLACE (rotation evicts the old entry exactly)", () => {
    const before = getWebhooks("workerd-rotation-key", "secret-v1");
    const rotated = getWebhooks("workerd-rotation-key", "secret-v2");
    expect(rotated).not.toBe(before); // rebuilt
    expect(getWebhooks("workerd-rotation-key", "secret-v2")).toBe(rotated); // memoized
    // The old secret's entry is GONE: the same cacheKey + old secret rebuilds
    // again instead of returning the pre-rotation instance.
    expect(getWebhooks("workerd-rotation-key", "secret-v1")).not.toBe(before);
  });
});
