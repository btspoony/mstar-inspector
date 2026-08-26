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
  /**
   * Fail-closed kill-switch (postdeploy feedback T4): reviews run ONLY when
   * this is exactly "true". Unset or any other value → every webhook is
   * classified as `ignore` (HTTP 2xx, no queue enqueue). Default OFF.
   */
  REVIEW_ENABLED?: string;
};
