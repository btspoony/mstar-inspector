/**
 * Review job queue payload — single source of truth (compass contracts B).
 * Produced by the worker (04) and consumed by the pipeline (06).
 * MUST NOT contain tokens, secrets, or private keys (compass contracts D).
 *
 * `appRef.appId` — which GitHub App's credentials the consumer must resolve
 * for this job (required single shape,
 * AL-24-2). The `github_apps` row (D1) with that id — attached by the
 * per-App `POST /webhook/:workspaceId/:appId` route after classification,
 * the ONLY
 * production attach point.
 *
 * `appId` is a reference (a `github_apps.id` UUID), never a credential —
 * the queue carries the id only; the decrypted PEM exists solely in
 * consumer memory (lock L4, contracts D red line unchanged).
 *
 * Archaeology: the original `appRef` was an OPTIONAL union
 * (`{ kind: "app", appId } | { kind: "legacy" }`, absent = legacy — lock L3)
 * serving the retired env-App legacy face; the cutover retired that face and
 * collapsed the contract to the single required per-App shape.
 */
export type ReviewJobPayload = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  /**
   * The PR's `pull_request.updated_at` for the delivery that produced this
   * job, normalized to UTC ISO-8601 (`…Z`) so it compares as text against the
   * ledger's `pull_requests.head_at` — the two uses are the supersede
   * comparison (skip only when the ledger holds a strictly newer stamp AND
   * that newer commit owns a queued job — its idempotency claim) and
   * the ordering of queued deliveries.
   *
   * Optional: absent for every `issue_comment` job (no commit stamp) and for a
   * `pull_request` delivery whose stamp was missing or malformed, exactly as
   * for messages enqueued before this field existed.
   */
  head_at?: string;
  action: string;
  triggered_by: "pull_request" | "issue_comment";
  appRef: { appId: string };
};
