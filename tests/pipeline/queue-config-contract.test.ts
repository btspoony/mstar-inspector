import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import "../helpers/cloudflare-workers-mock";
import { stripJsonComments } from "../../scripts/check-image-inputs";

const { QUEUE_MAX_ATTEMPTS } = await import("../../src/pipeline/consumer");

const REPO_ROOT = join(import.meta.dir, "..", "..");
const config = JSON.parse(
  stripJsonComments(readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8")),
) as {
  queues?: { consumers?: Array<{ queue?: string; max_retries?: number }> };
  env?: { production?: { queues?: { consumers?: Array<{ queue?: string; max_retries?: number }> } } };
};

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
      expect(
        QUEUE_MAX_ATTEMPTS - 1,
        `wrangler.jsonc: ${label} max_retries must be QUEUE_MAX_ATTEMPTS - 1 ` +
          `(consumer.ts stamps the failed claim on attempt ${QUEUE_MAX_ATTEMPTS})`,
      ).toBe(retries as number);
    }
  });
});
