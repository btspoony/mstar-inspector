/**
 * Webhook verification + event filtering tests.
 * Real signatures via `@octokit/webhooks` `sign()` (Web Crypto) — no mocks
 * for the crypto path; mock env is injected at the handler level (Task 2).
 */
import { describe, expect, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import { classifyEvent, classifyWebhook, PULL_REQUEST_ACTIONS } from "../../src/worker/webhooks";

const SECRET = "s3cret-webhook-secret";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeWebhooks(secret: string): Webhooks {
  return new Webhooks({ secret });
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
    issue: { number: 42, pull_request: { url: "https://api.github.com/repos/test-owner/test-repo/pulls/42" } },
    repository: { name: "test-repo", owner: { login: "test-owner" } },
    sender: { type: "User", login: "human" },
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

describe("classifyEvent — issue_comment /review command", () => {
  test("issue_comment.created with /review on a PR yields a job with null head_sha", () => {
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

  test("case-variant /Review body is ignored (case-sensitive)", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "/Review" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body does not start with /review" });
  });

  test("non-/review body is ignored", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: "please review" } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body does not start with /review" });
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
