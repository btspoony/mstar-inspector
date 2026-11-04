/**
 * The retry budget is one number in two places: `QUEUE_MAX_ATTEMPTS` decides
 * when the FINAL delivery stamps its idempotency key `failed`, and wrangler's
 * `max_retries` decides how many deliveries the platform actually makes.
 *
 * They are read by different runtimes, so neither can import the other — a
 * comment was the only link, and drift in either direction silently removes
 * the stamp: raise `max_retries` and the last delivery never reaches attempt 4,
 * leaving a stale `"1"` behind that the supersede skip accepts as proof;
 * lower it and the same stale value appears one attempt earlier. This lock
 * fails the build instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load shim, FIRST: `src/pipeline/consumer.ts` statically imports the sandbox
// adapter, whose `cloudflare:workers` builtin Bun's test runner cannot resolve.
import "../helpers/cloudflare-workers-mock";
import { stripJsonComments } from "../../scripts/check-image-inputs";

// Dynamic, like every other consumer suite: the shim above must be registered
// before the module graph evaluates.
const { QUEUE_MAX_ATTEMPTS } = await import("../../src/pipeline/consumer");

const REPO_ROOT = join(import.meta.dir, "..", "..");
const config = JSON.parse(
  stripJsonComments(readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8")),
) as {
  queues?: { consumers?: Array<{ queue?: string; max_retries?: number }> };
  env?: { production?: { queues?: { consumers?: Array<{ queue?: string; max_retries?: number }> } } };
};

/** Every deployed consumer block that runs the review pipeline. */
function reviewConsumers(): Array<[string, { queue?: string; max_retries?: number }]> {
  const blocks: Array<[string, { queue?: string; max_retries?: number }]> = [];
  for (const [label, list] of [
    ["top level (staging)", config.queues?.consumers],
    ["env.production", config.env?.production?.queues?.consumers],
  ] as const) {
    for (const consumer of list ?? []) {
      if (consumer.queue?.startsWith("review-queue")) blocks.push([label, consumer]);
    }
  }
  return blocks;
}

describe("queue retry budget ↔ QUEUE_MAX_ATTEMPTS", () => {
  test("the final attempt index equals the configured max_retries + 1", () => {
    const blocks = reviewConsumers();
    expect(blocks.length, "wrangler.jsonc: no review-queue consumer found").toBeGreaterThan(0);
    for (const [label, consumer] of blocks) {
      const retries = consumer.max_retries;
      expect(typeof retries, `wrangler.jsonc: ${label} review consumer max_retries`).toBe("number");
      // One initial delivery plus `max_retries` retries.
      expect(
        QUEUE_MAX_ATTEMPTS - 1,
        `wrangler.jsonc: ${label} max_retries must be QUEUE_MAX_ATTEMPTS - 1 ` +
          `(consumer.ts stamps the failed claim on attempt ${QUEUE_MAX_ATTEMPTS})`,
      ).toBe(retries as number);
    }
  });
});
