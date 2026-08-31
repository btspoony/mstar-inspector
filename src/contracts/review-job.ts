/**
 * Review job queue payload — single source of truth (compass contracts B).
 * Produced by the worker (04) and consumed by the pipeline (06).
 * MUST NOT contain tokens, secrets, or private keys (compass contracts D).
 *
 * `appRef.appId` — which GitHub App's credentials the consumer must resolve
 * for this job (plan 13 Task 2; plan 24 Task 1: required single shape,
 * AL-24-2). The `github_apps` row (D1) with that id — attached by the
 * per-App `POST /webhook/:appSlug` route after classification, the ONLY
 * production attach point.
 *
 * `appId` is a reference (a `github_apps.id` UUID), never a credential —
 * the queue carries the id only; the decrypted PEM exists solely in
 * consumer memory (lock L4, contracts D red line unchanged).
 *
 * Archaeology: pre-plan-24 `appRef` was an OPTIONAL union
 * (`{ kind: "app", appId } | { kind: "legacy" }`, absent = legacy — lock L3)
 * serving the retired env-App legacy face; plan 24 retired that face and
 * collapsed the contract to the single required per-App shape.
 */
export type ReviewJobPayload = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  action: string;
  triggered_by: "pull_request" | "review_command";
  appRef: { appId: string };
};
