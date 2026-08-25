/**
 * Worker entry — Hono app exported as the module `fetch` handler (no listen).
 * 06 appends the queue wiring here (worker → pipeline, the only legal edge).
 *
 * Routes:
 * - GET /healthz → 200 {"ok":true}
 * - POST /webhook → verified GitHub webhook → classify → (Task 2: enqueue)
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { classifyWebhook } from "./webhooks";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/webhook", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;

  const outcome = await classifyWebhook(secret, rawBody, signature, eventName);

  if (outcome.kind === "reject") {
    return c.text(outcome.reason, outcome.status);
  }
  if (outcome.kind === "ignore") {
    return c.text("ignored", 200);
  }
  // Task 2: idempotency pre-check + REVIEW_QUEUE.send(outcome.payload).
  return c.text("accepted", 200);
});

export default {
  fetch: app.fetch,
};
