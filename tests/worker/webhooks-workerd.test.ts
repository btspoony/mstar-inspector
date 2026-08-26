/**
 * Workerd-equivalent signature verification tests (QC F-001 + F-005).
 *
 * On the deployed Worker, wrangler resolves `@octokit/webhooks-methods` via
 * the `browser` condition → WebCrypto verify → `hexToUInt8Array` throws a
 * TypeError on malformed (non-hex) signatures, while Bun/node resolves the
 * `node` condition → `timingSafeEqual` → returns false. The `verifySignature`
 * seam reproduces the workerd throw path and locks the behavior both
 * runtimes must share: malformed signature → 401, never 500, with a
 * structured `event=unknown` warning.
 *
 * The `getWebhooks` accessor is used to lock the module-level singleton
 * (F-005): the hot path must not build a `Webhooks` instance per request.
 */
import { describe, expect, mock, test } from "bun:test";
import worker from "../../src/worker/index";
import { classifyWebhook, getWebhooks, verifySignature } from "../../src/worker/webhooks";
import type { Env } from "../../src/worker/env";

const SECRET = "s3cret-webhook-secret";

/** The workerd WebCrypto throw: `hexToUInt8Array` on non-hex input. */
const workerdVerify = async (): Promise<boolean> => {
  throw new TypeError("Cannot read properties of null (reading 'map')");
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ID: "123",
    PRIVATE_KEY: "private-key",
    WEBHOOK_SECRET: SECRET,
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    ...overrides,
  };
}

describe("verifySignature — workerd hex-decode throw path (F-001)", () => {
  test("a throwing verifier yields false (401), not an uncaught 500", async () => {
    const valid = await verifySignature(workerdVerify, "{}", "sha256=zz");
    expect(valid).toBe(false);
  });

  test("a throwing verifier logs a structured event=unknown warning", async () => {
    const warn = mock((_fields: unknown, _msg?: string) => {});
    const valid = await verifySignature(workerdVerify, "{}", "sha256=zz", {
      info: mock(() => {}),
      warn,
    });

    expect(valid).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      event: "unknown",
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

describe("worker fetch entry — malformed signature maps to 401 (F-001)", () => {
  test("malformed signature returns 401 at the HTTP boundary", async () => {
    const res = await worker.fetch(
      new Request("https://worker.local/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=zz", "x-github-event": "pull_request" },
        body: "{}",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("module-level Webhooks singleton (F-005)", () => {
  test("getWebhooks returns the same instance across calls", () => {
    const first = getWebhooks(SECRET);
    const second = getWebhooks(SECRET);
    expect(second).toBe(first);
  });
});
