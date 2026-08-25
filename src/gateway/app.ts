/**
 * Gateway app factory — registers webhook handlers on a Probot instance.
 *
 * Contract (plan 01 Module contracts):
 * - `createGatewayApp(options?)` returns `(app: Probot) => void`
 * - It does NOT `listen()`, does NOT `process.exit`, and does not bind a port.
 * - M0: handlers only log structured events; they do NOT fetch diffs or start reviews.
 *
 * Subscribed events (plan Clarify decisions 2–3):
 * - `pull_request` × `opened` | `synchronize` | `reopened`
 * - `issue_comment.created` with a body starting with `/review` (case-sensitive)
 *   on a pull request thread (issue carries a `pull_request` object).
 *
 * Workers-compatible: this module only registers callbacks on the Probot
 * instance passed in; it performs no I/O and imports no Node-only APIs.
 * The `Probot` reference below is a type-only import (erased at runtime).
 * Context types are structural (plan: "实现用结构类型，测试只验证行为") so the
 * handlers stay decoupled from Probot's runtime `Context` class.
 */

import type { Probot } from "probot";

export type GatewayEventLog = {
  event: "pull_request" | "issue_comment";
  action: string;
  installation_id: number | null;
  owner: string;
  repo: string;
  pr_number: number | null;
  head_sha: string | null;
};

export type GatewayLog = {
  info: (fields: GatewayEventLog, msg?: string) => void;
};

export type GatewayAppOptions = {
  log?: GatewayLog;
};

/** Structural context for `pull_request` webhook events. */
export type PullRequestContext = {
  payload: {
    action: string;
    installation?: { id?: number } | null;
    number?: number;
    pull_request: { number?: number; head?: { sha?: string | null } };
    repository?: { name?: string; owner?: { login?: string } };
  };
  log: GatewayLog;
};

/** Structural context for `issue_comment` webhook events. */
export type IssueCommentContext = {
  payload: {
    action: string;
    installation?: { id?: number } | null;
    comment: { body?: string };
    issue: { number?: number; pull_request?: unknown };
    repository?: { name?: string; owner?: { login?: string } };
  };
  log: GatewayLog;
};

const REVIEW_COMMAND_PREFIX = "/review";

/**
 * M0 handler for `pull_request` events (whitelisted actions only — the
 * factory registers per-action so non-whitelisted actions never reach here).
 * Logs the structured event with the idempotency key components
 * `(installation_id, owner, repo, pr_number, head_sha)`; no diff fetch, no review.
 */
export async function handlePullRequest(context: PullRequestContext): Promise<void> {
  const { payload, log } = context;
  log.info(
    {
      event: "pull_request",
      action: payload.action,
      installation_id: payload.installation?.id ?? null,
      owner: payload.repository?.owner?.login ?? "",
      repo: payload.repository?.name ?? "",
      pr_number: payload.pull_request.number ?? payload.number ?? null,
      head_sha: payload.pull_request.head?.sha ?? null,
    },
    "pull_request event received",
  );
}

/**
 * M0 handler for the `/review` slash command (`issue_comment.created` whose
 * body starts with `/review` on a pull request thread). Logs the structured
 * event; no diff fetch, no review. `head_sha` is not present in
 * `issue_comment` payloads, so it is logged as `null` (M1 resolves it).
 */
export async function handleReviewCommand(context: IssueCommentContext): Promise<void> {
  const { payload, log } = context;
  log.info(
    {
      event: "issue_comment",
      action: payload.action,
      installation_id: payload.installation?.id ?? null,
      owner: payload.repository?.owner?.login ?? "",
      repo: payload.repository?.name ?? "",
      pr_number: payload.issue.number ?? null,
      head_sha: null,
    },
    "review command received",
  );
}

export function createGatewayApp(options?: GatewayAppOptions): (app: Probot) => void {
  const log: GatewayLog = options?.log ?? {
    info: (fields, msg) => {
      // Default sink: structured JSON line on stdout. No secrets are logged.
      console.log(JSON.stringify({ ...fields, msg: msg ?? "" }));
    },
  };

  return (app: Probot) => {
    // Whitelisted pull_request actions (plan Clarify decision 3): anything
    // else (closed, labeled, …) is never registered, so it never reaches a handler.
    app.on("pull_request.opened", (context) => handlePullRequest({ ...context, log }));
    app.on("pull_request.synchronize", (context) => handlePullRequest({ ...context, log }));
    app.on("pull_request.reopened", (context) => handlePullRequest({ ...context, log }));

    // /review slash command (plan Clarify decision 2): body must start with
    // "/review" (case-sensitive) and the thread must be a pull request.
    app.on("issue_comment.created", (context) => {
      const { payload } = context;
      const body = payload.comment?.body ?? "";
      const isPullRequest = payload.issue?.pull_request != null;
      if (body.startsWith(REVIEW_COMMAND_PREFIX) && isPullRequest) {
        return handleReviewCommand({ ...context, log });
      }
    });
  };
}
