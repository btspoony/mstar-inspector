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
  /**
   * note: The PR's `pull_request.updated_at` for the delivery that produced this
   * job, normalized to UTC ISO-8601 (`…Z`) so it compares as text against the
   * ledger's `pull_requests.head_at`. It has exactly two uses, both in the
   * supersede comparison: the payload stamp is the left operand and the
   * ledger's watermark the right one (skip only when the ledger holds a
   * strictly newer stamp AND that newer commit owns a queued job — its
   * idempotency claim). Nothing sorts the queue by it.
   *
   * Optional: absent for every `issue_comment` job (no commit stamp) and for a
   * `pull_request` delivery whose stamp was missing or malformed, exactly as
   * for messages enqueued before this field existed.
   */
  head_at?: string;
  /**
   * note: The `issue_comment` id that produced this job — the comment trigger's
   * identity, and the only thing an idempotency claim can key on when
   * `head_sha` is null (a mention delivery states no commit). Present on
   * every `issue_comment` job whose payload carried a readable `comment.id`;
   * absent otherwise, exactly like `head_at`.
   */
  comment_id?: number;
  action: string;
  triggered_by: "pull_request" | "issue_comment";
  botRef: { appId: string };
  /** note: The `review_targets` row this job's review configuration comes from. */
  targetId: string;
  /**
   * note: The Check attach identity of the DELIVERY that created this job's Check run
   * (spec §7.9): the id the delivery path used as its holder
   * (`delivery:<id>`). The queue carries the ID only — never credentials.
   *
   * Absent when this delivery's attach found the key already owned (a duplicate
   * delivery, a queue redelivery) or when its inline budget expired before the
   * attach finished: such a message never created a row of its own, so its skip
   * paths must settle nothing rather than take another delivery's run.
   */
  attachDeliveryId?: string;
};
