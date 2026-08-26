/**
 * Worker entry — Hono app exported as the module `fetch` handler (no listen).
 * 06 appends the queue wiring here (worker → pipeline, the only legal edge).
 *
 * Routes:
 * - GET /healthz → 200 {"ok":true}
 * - POST /webhook → verified GitHub webhook → classify → (Task 2: enqueue)
 */
import { Hono } from "hono";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { Env } from "./env";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { PipelineEnv } from "../pipeline/consumer";
import { classifyWebhook, WEBHOOK_BODY_LIMIT } from "./webhooks";
import { defaultLog, handleReviewJob } from "./handlers";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/webhook", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  // Body-size cap checked BEFORE buffering the body (B6): an oversized
  // payload is rejected with 413 before any signature work or body read.
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > WEBHOOK_BODY_LIMIT) {
    defaultLog.warn(
      {
        event: "unknown",
        reason: "webhook_body_too_large",
        detail: `content_length=${contentLength}`,
      },
      "webhook rejected with 413 — body exceeds size limit",
    );
    return c.text("payload too large", 413);
  }
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;

  // T4 kill-switch: reviews run ONLY when REVIEW_ENABLED is exactly "true"
  // (fail-closed — unset/any other value → every webhook is ignored, 2xx).
  const reviewEnabled = c.env.REVIEW_ENABLED === "true";
  const outcome = await classifyWebhook(secret, rawBody, signature, eventName, defaultLog, reviewEnabled);

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }
  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }
  // Idempotency pre-check (non-null head_sha only) + REVIEW_QUEUE.send.
  // KV failure → conservative pass (enqueue anyway, D1 fallback).
  await handleReviewJob(outcome.payload, { env: c.env, log: defaultLog });
  return c.text("accepted", 200);
});

export default {
  fetch: app.fetch,
  // 06 queue wiring — the ONLY legal worker → pipeline edge (compass A).
  // Dynamic import: the consumer statically loads the workerd-only
  // @cloudflare/sandbox SDK, which Bun's test runner cannot resolve — a
  // static import would break the fetch-path tests (platform-specific
  // module exception to the static-import rule).
  async queue(batch: MessageBatch<ReviewJobPayload>, env: Env & PipelineEnv): Promise<void> {
    const { createReviewConsumer } = await import("../pipeline/consumer");
    await createReviewConsumer(env)(batch);
  },
};
