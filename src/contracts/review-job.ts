/**
 * why: Review job queue payload — single source of truth (compass contracts B).
 * Produced by the worker (04) and consumed by the pipeline (06).
 * MUST NOT contain tokens, secrets, or private keys (compass contracts D).
 *
 * THREE ids, because the pre-split review row is now two entities plus the
 * target: `botRef.appId` names the `github_apps` row — the installation's
 * credentials, webhook identity and publishing identity; `botRef.botId` names
 * the `review_bots` row — the model chain, sandbox image, price multiplier and
 * monthly quota the execution reads. The two ids are equal only for rows the
 * entity split migrated: this release creates exactly one bot per App under
 * the same id, and chained mounts make them diverge once the chain model
 * ships. `targetId` names the `review_targets` row that owns the review level,
 * the Check gate and the business pause. All three are required on every
 * enqueued job, and the consumer refuses a message whose target belongs to
 * another App.
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
  triggered_by: "pull_request" | "issue_comment" | "check_run";
  /**
   * The completed check run a `check_run.rerequested` delivery asked to run
   * again — an idempotency dimension only: the KV claims key through
   * `rerunIdemKey`, so a rerun of an already-reviewed head reaches the
   * pipeline's settle-skip instead of dying on the plain key's `done`,
   * and GitHub's redelivery of the same rerequested event enqueues once.
   */
  rerun_check_run_id?: number;
  botRef: { appId: string; botId: string };
  targetId: string;
  attachDeliveryId?: string;
  successor_of?: string;
};
