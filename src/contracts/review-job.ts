/**
 * Which GitHub App's credentials the consumer must resolve for this job
 * (plan 13 Task 2, architect lock L3).
 *
 * - `{ kind: "legacy" }` → the Worker-secrets global App (env APP_ID /
 *   PRIVATE_KEY) — attached explicitly by the legacy `POST /webhook` route.
 * - `{ kind: "app", appId }` → the `github_apps` row (D1) with that id —
 *   attached by the per-App `POST /webhook/:appSlug` route after
 *   classification.
 *
 * `appId` is a reference (a `github_apps.id` UUID), never a credential —
 * the queue carries the id only; the decrypted PEM exists solely in
 * consumer memory (lock L4, contracts D red line unchanged).
 */
export type AppRef = { kind: "app"; appId: string } | { kind: "legacy" };

/**
 * Review job queue payload — single source of truth (compass contracts B).
 * Produced by the worker (04) and consumed by the pipeline (06).
 * MUST NOT contain tokens, secrets, or private keys (compass contracts D).
 *
 * `appRef` is OPTIONAL for backward compatibility (lock L3): absent = legacy
 * in BOTH directions — old in-flight messages without the field resolve to
 * the env App, and an old Worker receiving a new message simply ignores the
 * extra field. The legacy route still attaches an EXPLICIT
 * `{ kind: "legacy" }` (no "absent = legacy" dual convention on the
 * producer side).
 */
export type ReviewJobPayload = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
  action: string;
  triggered_by: "pull_request" | "review_command";
  appRef?: AppRef;
};
