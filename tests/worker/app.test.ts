import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";

const SECRET = "s3cret-webhook-secret";

/** Functional KV/Queue stubs — the /webhook path now enqueues (Task 2). */
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
    // T4: the classification tests exercise the ENABLED path; the kill-switch
    // (unset REVIEW_ENABLED → ignore) has its own test below.
    REVIEW_ENABLED: "true",
    ...overrides,
  };
}

function webhookRequest(body: string, headers: Record<string, string>): Request {
  return new Request("https://worker.local/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("worker fetch entry", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await worker.fetch(new Request("https://worker.local/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid signed pull_request webhook returns 200 accepted", async () => {
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      installation: { id: 123 },
      pull_request: { number: 42, head: { sha: "abc123" } },
      repository: { name: "test-repo", owner: { login: "test-owner" } },
    });
    const signature = await new Webhooks({ secret: SECRET }).sign(body);
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": signature, "x-github-event": "pull_request" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("accepted");
  });

  test("bad signature returns 401", async () => {
    const body = "{}";
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  test('"development" secret returns 500 fail-closed', async () => {
    const body = "{}";
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" }),
      makeEnv({ WEBHOOK_SECRET: "development" }),
    );
    expect(res.status).toBe(500);
  });

  test("uninteresting event returns 200 ignored (no GitHub retry)", async () => {
    const body = "{}";
    const signature = await new Webhooks({ secret: SECRET }).sign(body);
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": signature, "x-github-event": "ping" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
  });
  test("REVIEW_ENABLED unset → every webhook is ignored with 200 and nothing is enqueued (T4)", async () => {
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      installation: { id: 123 },
      pull_request: { number: 42, head: { sha: "abc123" } },
      repository: { name: "test-repo", owner: { login: "test-owner" } },
    });
    const signature = await new Webhooks({ secret: SECRET }).sign(body);
    const sent: unknown[] = [];
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": signature, "x-github-event": "pull_request" }),
      makeEnv({
        REVIEW_ENABLED: undefined,
        REVIEW_QUEUE: { send: async (message: unknown) => { sent.push(message); } } as unknown as Env["REVIEW_QUEUE"],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  test('REVIEW_ENABLED "false" → webhook ignored with 200, nothing enqueued (T4)', async () => {
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      installation: { id: 123 },
      pull_request: { number: 42, head: { sha: "abc123" } },
      repository: { name: "test-repo", owner: { login: "test-owner" } },
    });
    const signature = await new Webhooks({ secret: SECRET }).sign(body);
    const sent: unknown[] = [];
    const res = await worker.fetch(
      webhookRequest(body, { "x-hub-signature-256": signature, "x-github-event": "pull_request" }),
      makeEnv({
        REVIEW_ENABLED: "false",
        REVIEW_QUEUE: { send: async (message: unknown) => { sent.push(message); } } as unknown as Env["REVIEW_QUEUE"],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  test("oversized webhook body (Content-Length > 1MB) is rejected with 413 before buffering", async () => {
    const origWarn = console.warn;
    const warn = mock((_msg: unknown) => {});
    console.warn = warn;
    try {
      // The body is never sent: the handler rejects on the Content-Length
      // header before reading the body, so a header-only oversized request
      // exercises the same gate.
      const res = await worker.fetch(
        webhookRequest(
          "",
          { "x-github-event": "ping", "content-length": String(1_000_001) },
        ),
        makeEnv(),
      );
      expect(res.status).toBe(413);
      expect(await res.text()).toBe("payload too large");
      // The rejection is structured-logged (reason=webhook_body_too_large).
      expect(warn).toHaveBeenCalledTimes(1);
      const payload = warn.mock.calls[0]?.[0] as string;
      expect(payload).toContain("webhook_body_too_large");
    } finally {
      console.warn = origWarn;
    }
  });
});
