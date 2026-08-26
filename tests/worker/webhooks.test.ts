/**
 * Webhook verification + event filtering tests.
 * Real signatures via `@octokit/webhooks` `sign()` (Web Crypto) — no mocks
 * for the crypto path; mock env is injected at the handler level (Task 2).
 *
 * Phase 5 B5: /review is an exact command (not a bare prefix) and only the
 * PR author or the repository owner may trigger it.
 * Phase 5 B6b: every signature/secret reject path emits a structured
 * warning with a machine `reason` and no secret material.
 */
import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import { classifyEvent, classifyWebhook, PULL_REQUEST_ACTIONS } from "../../src/worker/webhooks";

const SECRET = "s3cret-webhook-secret";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeWebhooks(secret: string): Webhooks {
  return new Webhooks({ secret });
}

function makeLog() {
  const info = mock((_fields: unknown, _msg?: string) => {});
  const warn = mock((_fields: unknown, _msg?: string) => {});
  return { info, warn };
}

function pullRequestBody(action: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action,
    number: 42,
    installation: { id: 123 },
    pull_request: { number: 42, head: { sha: HEAD_SHA } },
    repository: { name: "test-repo", owner: { login: "test-owner" } },
    ...overrides,
  });
}

function issueCommentBody(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    action: "created",
    installation: { id: 123 },
    comment: { body: "/review" },
    issue: {
      number: 42,
      user: { login: "test-author" },
      pull_request: { url: "https://api.github.com/repos/test-owner/test-repo/pulls/42" },
    },
    repository: { name: "test-repo", owner: { login: "test-owner" } },
    sender: { type: "User", login: "test-author" },
    ...overrides,
  });
}

describe("classifyWebhook — signature verification (fail-closed)", () => {
  test("valid signature on a whitelisted pull_request event yields a job", async () => {
    const body = pullRequestBody("opened");
    const signature = await makeWebhooks(SECRET).sign(body);
    const outcome = await classifyWebhook(SECRET, body, signature, "pull_request");
    expect(outcome.kind).toBe("job");
    if (outcome.kind === "job") {
      expect(outcome.payload).toEqual({
        installation_id: 123,
        owner: "test-owner",
        repo: "test-repo",
        pr_number: 42,
        head_sha: HEAD_SHA,
        action: "opened",
        triggered_by: "pull_request",
      });
    }
  });

  test("bad signature is rejected with 401", async () => {
    const body = pullRequestBody("opened");
    const outcome = await classifyWebhook(SECRET, body, "sha256=deadbeef", "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "signature verification failed" });
  });

  test("missing signature header is rejected with 401", async () => {
    const body = pullRequestBody("opened");
    const outcome = await classifyWebhook(SECRET, body, null, "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "missing X-Hub-Signature-256 header" });
  });

  test("signature signed with a different secret is rejected with 401", async () => {
    const body = pullRequestBody("opened");
    const signature = await makeWebhooks("other-secret").sign(body);
    const outcome = await classifyWebhook(SECRET, body, signature, "pull_request");
    expect(outcome).toEqual({ kind: "reject", status: 401, reason: "signature verification failed" });
  });

  test('"development" secret is rejected with 500 before any verification', async () => {
    const body = pullRequestBody("opened");
    const signature = await makeWebhooks("development").sign(body);
    const outcome = await classifyWebhook("development", body, signature, "pull_request");
    expect(outcome).toEqual({
      kind: "reject",
      status: 500,
      reason: "webhook secret is missing, empty, or the default 'development'",
    });
  });

  test("empty secret is rejected with 500", async () => {
    const body = pullRequestBody("opened");
    const outcome = await classifyWebhook("", body, "sha256=whatever", "pull_request");
    expect(outcome.kind).toBe("reject");
    if (outcome.kind === "reject") {
      expect(outcome.status).toBe(500);
    }
  });
});

describe("classifyWebhook — reject paths log structured warnings (B6b)", () => {
  test("secret misconfig warns with reason=secret_misconfigured and no secret field", async () => {
    const log = makeLog();
    const outcome = await classifyWebhook("development", "{}", "sha256=deadbeef", "pull_request", log);
    expect(outcome.kind).toBe("reject");
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "unknown", reason: "secret_misconfigured" });
    expect(msg).toContain("500");
    // The secret itself is never a log field — only a fixed diagnostic
    // reason/detail (which is a constant string, not the secret value).
    expect(Object.keys(fields as Record<string, unknown>)).not.toContain("secret");
    expect((fields as Record<string, unknown>).detail).toBe(
      "secret missing, empty, or the default 'development'",
    );
  });

  test("missing signature warns with reason=missing_signature", async () => {
    const log = makeLog();
    await classifyWebhook(SECRET, "{}", null, "pull_request", log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "unknown", reason: "missing_signature" });
    expect(msg).toContain("401");
  });

  test("bad signature warns with reason=signature_verification_failed", async () => {
    const log = makeLog();
    await classifyWebhook(SECRET, "{}", "sha256=deadbeef", "pull_request", log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "unknown", reason: "signature_verification_failed" });
    expect(msg).toContain("401");
  });

  test("a valid request logs no rejection warning", async () => {
    const log = makeLog();
    const body = pullRequestBody("opened");
    const signature = await makeWebhooks(SECRET).sign(body);
    await classifyWebhook(SECRET, body, signature, "pull_request", log);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("classifyEvent — pull_request whitelist", () => {
  for (const action of PULL_REQUEST_ACTIONS) {
    test(`pull_request.${action} yields a job`, () => {
      const outcome = classifyEvent("pull_request", pullRequestBody(action));
      expect(outcome.kind).toBe("job");
      if (outcome.kind === "job") {
        expect(outcome.payload.action).toBe(action);
        expect(outcome.payload.triggered_by).toBe("pull_request");
        expect(outcome.payload.head_sha).toBe(HEAD_SHA);
      }
    });
  }

  test("pull_request.closed is ignored (200, no job)", () => {
    const outcome = classifyEvent("pull_request", pullRequestBody("closed"));
    expect(outcome).toEqual({ kind: "ignore", reason: "pull_request action closed is not whitelisted" });
  });

  test("pull_request.labeled is ignored", () => {
    const outcome = classifyEvent("pull_request", pullRequestBody("labeled"));
    expect(outcome.kind).toBe("ignore");
  });

  test("pull_request with missing required fields is rejected with 400", () => {
    const outcome = classifyEvent("pull_request", pullRequestBody("opened", { installation: null }));
    expect(outcome).toEqual({ kind: "reject", status: 400, reason: "pull_request payload missing required fields" });
  });
});

describe("classifyEvent — issue_comment /review exact command (B5)", () => {
  test("issue_comment.created with /review on a PR by the author yields a job with null head_sha", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody());
    expect(outcome.kind).toBe("job");
    if (outcome.kind === "job") {
      expect(outcome.payload).toEqual({
        installation_id: 123,
        owner: "test-owner",
        repo: "test-repo",
        pr_number: 42,
        head_sha: null,
        action: "created",
        triggered_by: "review_command",
      });
    }
  });

  test("/review with trailing whitespace is accepted (trimmed)", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "  /review  " } }));
    expect(outcome.kind).toBe("job");
  });

  test("/review with arguments is accepted", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "/review focused on auth" } }));
    expect(outcome.kind).toBe("job");
  });

  test("case-variant /Review body is ignored (case-sensitive)", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "/Review" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body is not the exact /review command" });
  });

  test("/reviewing prefix does NOT trigger (exact command)", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "/reviewing the diff" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body is not the exact /review command" });
  });

  test("non-/review body is ignored", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "please review" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body is not the exact /review command" });
  });

  test("comment on a non-PR issue is ignored", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ issue: { number: 7 } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment is not on a pull request thread" });
  });

  test("comment sent by a bot is ignored (self-comment loop guard)", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "Bot", login: "mstar-inspector[bot]" } }),
    );
    expect(outcome).toEqual({ kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" });
  });

  test("issue_comment.edited is ignored", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ action: "edited" }));
    expect(outcome).toEqual({ kind: "ignore", reason: "issue_comment action edited is not whitelisted" });
  });
});

describe("classifyEvent — /review actor allowlist (B5)", () => {
  test("the PR author is allowed", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "test-author" } }),
    );
    expect(outcome.kind).toBe("job");
  });

  test("the repository owner is allowed", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "test-owner" } }),
    );
    expect(outcome.kind).toBe("job");
  });

  test("a random commenter is ignored with a structured actor_not_allowed warning", () => {
    const log = makeLog();
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "hacker-123" } }),
      log,
    );
    expect(outcome).toEqual({ kind: "ignore", reason: "comment actor is not the PR author or repo owner" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "unknown", reason: "actor_not_allowed" });
    expect(msg).toContain("not the PR author or repo owner");
  });

  test("a missing sender login is ignored (fail closed)", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ sender: { type: "User" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment actor is not the PR author or repo owner" });
  });
});

describe("classifyEvent — everything else", () => {
  test("non-whitelisted event (ping) is ignored", () => {
    const outcome = classifyEvent("ping", "{}");
    expect(outcome).toEqual({ kind: "ignore", reason: "event ping is not whitelisted" });
  });

  test("missing X-GitHub-Event header is ignored", () => {
    const outcome = classifyEvent(null, "{}");
    expect(outcome).toEqual({ kind: "ignore", reason: "missing X-GitHub-Event header" });
  });

  test("invalid JSON body is rejected with 400", () => {
    const outcome = classifyEvent("pull_request", "{not json");
    expect(outcome).toEqual({ kind: "reject", status: 400, reason: "invalid JSON body" });
  });
});
