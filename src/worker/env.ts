/**
 * Worker fetch-face environment (compass contracts B).
 * No `DB` here — D1 enters only the 06 `PipelineEnv` (consumer face).
 */
import type { KVNamespace, Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";

export type Env = {
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  REVIEW_QUEUE: Queue<ReviewJobPayload>;
  IDEMPOTENCY_KV: KVNamespace;
};
