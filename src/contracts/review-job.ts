/**
 * why: Review job queue payload — single source of truth (compass contracts B).
 * Produced by the worker (04) and consumed by the pipeline (06).
 * MUST NOT contain tokens, secrets, or private keys (compass contracts D).
 *
 * TWO ids, because the review configuration lives on two rows:
 * `botRef.appId` names the `review_bots` row the job executes as — its
 * credentials, model chain, sandbox image and operational pause (AL-24-2);
 * `targetId` names the `review_targets` row that owns the review level, the
 * Check gate and the business pause. Both are required on every enqueued job,
 * and the consumer refuses a message whose target belongs to another bot.
 *
 * The ids are attached by the per-App `POST /webhook/:workspaceId/:appId`
 * route — the ONLY production producer — after it resolves the target.
 * Each is a reference (a row id), never a credential: the queue carries ids
 * only; the decrypted PEM exists solely in consumer memory (lock L4,
 * contracts D red line unchanged).
 */
export type ReviewJobPayload = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  head_at?: string;
  comment_id?: number;
  action: string;
  triggered_by: "pull_request" | "issue_comment";
  botRef: { appId: string };
  targetId: string;
  attachDeliveryId?: string;
  successor_of?: string;
};
