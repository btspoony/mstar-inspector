/**
 * Webhook verification + event filtering tests.
 * Real signatures via `@octokit/webhooks` `sign()` (Web Crypto) — no mocks
 * for the crypto path; mock env is injected at the handler level (Task 2).
 *
 * Phase 5 B5: the comment trigger requires a bot mention and only the
 * PR author or the repository owner may trigger it.
 * Phase 5 B6b: every signature/secret reject path emits a structured
 * warning with a machine `reason` and no secret material.
 * Spec review-trigger-policy §2.1/§3: the per-App trigger mode gates the
 * pull_request auto face; the comment trigger is the standalone
 * `@{appSlug}` mention (the /review command is retired).
 */
import { describe, expect, mock, test } from "bun:test";
import { Webhooks } from "@octokit/webhooks";
import {
  classifyEvent,
  classifyWebhook,
  PULL_REQUEST_ACTIONS,
  verifySignature,
  type ReviewTriggerContext,
} from "../../src/worker/webhooks";

const SECRET = ["s3cret", "webhook", "secret"].join("-");
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const APP_SLUG = "test-app";
const EVERY_PUSH: ReviewTriggerContext = { mode: "every_push", appSlug: APP_SLUG };

/** The workerd WebCrypto throw shape (mirrors tests/worker/webhooks-workerd.test.ts). */
const workerdVerify = async (): Promise<boolean> => {
  throw new TypeError("Cannot read properties of null (reading 'map')");
};

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
    comment: { body: `@${APP_SLUG}[bot]` },
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

/** Classify an issue_comment body as the PR author against APP_SLUG. */
function classifyMention(body: string, trigger: ReviewTriggerContext = EVERY_PUSH) {
  return classifyEvent("issue_comment", issueCommentBody({ comment: { body } }), undefined, true, trigger);
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
    // log hygiene: `event` carries the REAL GitHub event — no more
    // literal "unknown" at the classifier call sites.
    expect(fields).toMatchObject({ event: "pull_request", reason: "secret_misconfigured" });
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
    expect(fields).toMatchObject({ event: "pull_request", reason: "missing_signature" });
    expect(msg).toContain("401");
  });

  test("bad signature warns with reason=signature_verification_failed", async () => {
    const log = makeLog();
    await classifyWebhook(SECRET, "{}", "sha256=deadbeef", "pull_request", log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "pull_request", reason: "signature_verification_failed" });
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

describe("warn event labels (log hygiene 硬化项 3)", () => {
  test("absent event header → event falls back to the stage label (= reason)", async () => {
    const log = makeLog();
    await classifyWebhook(SECRET, "{}", null, null, log);
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "missing_signature", reason: "missing_signature" });
  });

  test("secret misconfig with absent event header → event = secret_misconfigured", async () => {
    const log = makeLog();
    await classifyWebhook("development", "{}", "sha256=deadbeef", null, log);
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "secret_misconfigured", reason: "secret_misconfigured" });
  });

  test("issue_comment actor reject carries the real event (issue_comment)", () => {
    const log = makeLog();
    classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "hacker-123" } }),
      log,
      true,
      EVERY_PUSH,
    );
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "issue_comment", reason: "actor_not_allowed" });
  });

  test("emergency brake warn on classifyEvent carries the real event when the header is present", () => {
    const log = makeLog();
    classifyEvent("pull_request", pullRequestBody("opened"), log, false);
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "pull_request", reason: "review_disabled_kill_switch" });
  });

  test("emergency brake warn with absent event header → event = review_disabled_kill_switch", () => {
    const log = makeLog();
    classifyEvent(null, pullRequestBody("opened"), log, false);
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "review_disabled_kill_switch", reason: "review_disabled_kill_switch" });
  });

  test("verifySignature throw warn: real event when threaded, stage label otherwise", async () => {
    const threaded = makeLog();
    await verifySignature(workerdVerify, "{}", "sha256=zz", threaded, "issue_comment");
    const [threadedFields] = threaded.warn.mock.calls[0] ?? [];
    expect(threadedFields).toMatchObject({
      event: "issue_comment",
      reason: "signature verification threw",
    });

    const fallback = makeLog();
    await verifySignature(workerdVerify, "{}", "sha256=zz", fallback);
    const [fallbackFields] = fallback.warn.mock.calls[0] ?? [];
    expect(fallbackFields).toMatchObject({
      event: "signature_verification_error",
      reason: "signature verification threw",
    });
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

describe("classifyEvent — review trigger mode matrix (spec §2.1, exhaustive)", () => {
  const MODES = ["open", "every_push", "manual"] as const;
  /** The §2.1 matrix cell: does mode × action enqueue the auto face? */
  const MATRIX: Record<(typeof MODES)[number], Record<string, boolean>> = {
    open: { opened: true, synchronize: false, reopened: false },
    every_push: { opened: true, synchronize: true, reopened: true },
    manual: { opened: false, synchronize: false, reopened: false },
  };

  for (const mode of MODES) {
    for (const action of PULL_REQUEST_ACTIONS) {
      test(`${mode} × pull_request.${action} → ${MATRIX[mode][action] ? "job" : "ignore"}`, () => {
        const outcome = classifyEvent("pull_request", pullRequestBody(action), undefined, true, {
          mode,
          appSlug: APP_SLUG,
        });
        if (MATRIX[mode][action]) {
          expect(outcome.kind).toBe("job");
          if (outcome.kind === "job") {
            expect(outcome.payload.action).toBe(action);
            expect(outcome.payload.triggered_by).toBe("pull_request");
            expect(outcome.payload.head_sha).toBe(HEAD_SHA);
          }
        } else {
          expect(outcome).toEqual({
            kind: "ignore",
            reason: `pull_request action ${action} does not auto-trigger in ${mode} mode`,
          });
        }
      });
    }
  }

  for (const mode of MODES) {
    test(`${mode} × pull_request.closed (never whitelisted) → the action reason, not a mode reason`, () => {
      const outcome = classifyEvent("pull_request", pullRequestBody("closed"), undefined, true, {
        mode,
        appSlug: APP_SLUG,
      });
      expect(outcome).toEqual({ kind: "ignore", reason: "pull_request action closed is not whitelisted" });
    });
    test(`${mode} × malformed payload still rejects 400 (reject set is mode-invariant)`, () => {
      const outcome = classifyEvent("pull_request", pullRequestBody("opened", { installation: null }), undefined, true, {
        mode,
        appSlug: APP_SLUG,
      });
      expect(outcome).toEqual({ kind: "reject", status: 400, reason: "pull_request payload missing required fields" });
    });
  }

  // §2.1 row: issue_comment.created (allowed actor + bot mention + on a PR)
  // → enqueue in EVERY mode; the same row without a mention → ignore.
  for (const mode of MODES) {
    test(`${mode} × issue_comment.created with a bot mention → job`, () => {
      const outcome = classifyMention(`@${APP_SLUG}[bot]`, { mode, appSlug: APP_SLUG });
      expect(outcome.kind).toBe("job");
    });
    test(`${mode} × issue_comment.created without a mention → ignore`, () => {
      const outcome = classifyMention("looks good to me", { mode, appSlug: APP_SLUG });
      expect(outcome).toEqual({ kind: "ignore", reason: "comment body does not mention the App bot" });
    });
  }
});

describe("classifyEvent — every_push default reproduces current classification (diff-to-current pin)", () => {
  test("an omitted trigger context and an explicit every_push context classify identically", () => {
    for (const action of PULL_REQUEST_ACTIONS) {
      const omitted = classifyEvent("pull_request", pullRequestBody(action));
      const explicit = classifyEvent("pull_request", pullRequestBody(action), undefined, true, {
        mode: "every_push",
        appSlug: "",
      });
      expect(explicit).toEqual(omitted);
      expect(omitted.kind).toBe("job");
    }
  });

  test("every_push payload is the exact pre-policy payload shape for all three actions", () => {
    for (const action of PULL_REQUEST_ACTIONS) {
      const outcome = classifyEvent("pull_request", pullRequestBody(action), undefined, true, {
        mode: "every_push",
        appSlug: APP_SLUG,
      });
      expect(outcome).toEqual({
        kind: "job",
        payload: {
          installation_id: 123,
          owner: "test-owner",
          repo: "test-repo",
          pr_number: 42,
          head_sha: HEAD_SHA,
          action,
          triggered_by: "pull_request",
        },
      });
    }
  });
});

describe("classifyEvent — issue_comment bot mention (spec §3)", () => {
  test("issue_comment.created with a bot mention on a PR by the author yields a job with null head_sha", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody(), undefined, true, EVERY_PUSH);
    expect(outcome.kind).toBe("job");
    if (outcome.kind === "job") {
      expect(outcome.payload).toEqual({
        installation_id: 123,
        owner: "test-owner",
        repo: "test-repo",
        pr_number: 42,
        head_sha: null,
        action: "created",
        triggered_by: "issue_comment",
      });
    }
  });

  test("a body without a mention is ignored", () => {
    const outcome = classifyMention("please review this when you can");
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body does not mention the App bot" });
  });

  test("a bare `@` with no slug context (omitted trigger) never matches", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ comment: { body: `@${APP_SLUG}` } }));
    expect(outcome).toEqual({ kind: "ignore", reason: "comment body does not mention the App bot" });
  });

  test("comment on a non-PR issue is ignored", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ issue: { number: 7 } }),
      undefined,
      true,
      EVERY_PUSH,
    );
    expect(outcome).toEqual({ kind: "ignore", reason: "comment is not on a pull request thread" });
  });

  test("comment sent by a bot is ignored (self-comment loop guard)", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "Bot", login: "mstar-inspector[bot]" } }),
      undefined,
      true,
      EVERY_PUSH,
    );
    expect(outcome).toEqual({ kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" });
  });

  test("issue_comment.edited is ignored", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody({ action: "edited" }), undefined, true, EVERY_PUSH);
    expect(outcome).toEqual({ kind: "ignore", reason: "issue_comment action edited is not whitelisted" });
  });
});

describe("classifyEvent — bot mention grammar (spec §3 standalone token)", () => {
  test("canonical @slug[bot] form matches", () => {
    expect(classifyMention(`@${APP_SLUG}[bot]`).kind).toBe("job");
  });

  test("bare-slug form matches", () => {
    expect(classifyMention(`@${APP_SLUG}`).kind).toBe("job");
  });

  test("matching is ASCII case-insensitive against the slug", () => {
    expect(classifyMention("@TEST-APP").kind).toBe("job");
    expect(classifyMention("@Test-App[bot]").kind).toBe("job");
  });

  test("trailing punctuation does not break the match", () => {
    expect(classifyMention(`@${APP_SLUG},`).kind).toBe("job");
    expect(classifyMention(`@${APP_SLUG}.`).kind).toBe("job");
    expect(classifyMention(`@${APP_SLUG}?`).kind).toBe("job");
  });

  test("match at body start, middle, and end (any position)", () => {
    expect(classifyMention(`@${APP_SLUG} can you take another pass?`).kind).toBe("job");
    expect(classifyMention(`hey @${APP_SLUG} can you take another pass?`).kind).toBe("job");
    expect(classifyMention(`can you take another pass @${APP_SLUG}`).kind).toBe("job");
  });

  test("a mention on its own line inside a multi-line body matches", () => {
    expect(classifyMention(`some context\n@${APP_SLUG}\nmore context`).kind).toBe("job");
  });

  test("trailing hyphen continuation rejects @slug-other (hyphens continue a login)", () => {
    expect(classifyMention(`@${APP_SLUG}-other`)).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
  });

  test("trailing continuation rejects @slugbot", () => {
    expect(classifyMention(`@${APP_SLUG}bot`)).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
  });

  test("trailing digit continuation rejects @slug2", () => {
    expect(classifyMention(`@${APP_SLUG}2`)).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
  });

  test("leading boundary rejects the email-shaped name@slug.host", () => {
    expect(classifyMention(`contact me at name@${APP_SLUG}.host`)).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
  });

  test("a body whose every occurrence is continuation-blocked does not match", () => {
    expect(classifyMention(`@${APP_SLUG}-other and @${APP_SLUG}bot`)).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
  });

  test("a continuation-blocked occurrence still allows a later standalone one", () => {
    expect(classifyMention(`@${APP_SLUG}bot is a different app, but @${APP_SLUG} is ours`).kind).toBe("job");
  });

  test("multi-App isolation: a sibling App's mention never triggers this App", () => {
    // This App's route (test-app), a body naming the sibling → ignore.
    expect(classifyMention("@other-app[bot]")).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
    // The sibling's route, a body naming this App → ignore.
    expect(classifyMention(`@${APP_SLUG}[bot]`, { mode: "every_push", appSlug: "other-app" })).toEqual({
      kind: "ignore",
      reason: "comment body does not mention the App bot",
    });
    // Control: the same body DOES match the route of the App it names.
    expect(classifyMention("@other-app[bot]", { mode: "every_push", appSlug: "other-app" }).kind).toBe("job");
  });
});

describe("classifyEvent — bot mention grammar: ASCII-restricted folding (QC F-001/S-1)", () => {
  const K_SLUG: ReviewTriggerContext = { mode: "every_push", appSlug: "k-app" };
  const I_SLUG: ReviewTriggerContext = { mode: "every_push", appSlug: "bot-i" };
  const NOT_A_MENTION = {
    kind: "ignore",
    reason: "comment body does not mention the App bot",
  } as const;

  test("plain-ASCII control: the same k/i slug shapes match as before (behavior unchanged)", () => {
    expect(classifyMention("@k-app", K_SLUG).kind).toBe("job");
    expect(classifyMention("@K-App", K_SLUG).kind).toBe("job");
    expect(classifyMention("@bot-i", I_SLUG).kind).toBe("job");
    expect(classifyMention("@Bot-I", I_SLUG).kind).toBe("job");
  });

  test("U+212A KELVIN SIGN never folds into a k of the slug (no phantom mention)", () => {
    // In place of the leading k: String.toLowerCase() built "@k-app" in a
    // folded copy, but the ORIGINAL body never contains the mention.
    expect(classifyMention("@\u212A-app", K_SLUG)).toEqual(NOT_A_MENTION);
    // Same for a KELVIN SIGN continuing a real leading k (still not `@k-app`).
    expect(classifyMention("@k\u212A-app", K_SLUG)).toEqual(NOT_A_MENTION);
  });

  test("U+0130 never folds into the trailing i of an i-ending slug (no boundary-opening match)", () => {
    // In place of the trailing i: the folded copy matched "@bot-i" and its
    // combining dot opened the after-boundary; the original text does not
    // contain the mention at all.
    expect(classifyMention("@bot-\u0130", I_SLUG)).toEqual(NOT_A_MENTION);
    expect(classifyMention("@bot-\u0130x", I_SLUG)).toEqual(NOT_A_MENTION);
  });

  test("a non-ASCII character before `@` is not a login continuation: a literal mention still matches", () => {
    // Boundary characters are read from the ORIGINAL body against the ASCII
    // class — U+0130 is outside [A-Za-z0-9-], so it cannot close the boundary.
    expect(classifyMention("\u0130 @bot-i please", I_SLUG).kind).toBe("job");
  });
});

describe("classifyEvent — bot mention actor allowlist (B5)", () => {
  test("the PR author is allowed", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "test-author" } }),
      undefined,
      true,
      EVERY_PUSH,
    );
    expect(outcome.kind).toBe("job");
  });

  test("the repository owner is allowed", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "test-owner" } }),
      undefined,
      true,
      EVERY_PUSH,
    );
    expect(outcome.kind).toBe("job");
  });

  test("a random commenter is ignored with a structured actor_not_allowed warning", () => {
    const log = makeLog();
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User", login: "hacker-123" } }),
      log,
      true,
      EVERY_PUSH,
    );
    expect(outcome).toEqual({ kind: "ignore", reason: "comment actor is not the PR author or repo owner" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "issue_comment", reason: "actor_not_allowed" });
    expect(msg).toContain("not the PR author or repo owner");
  });

  test("a missing sender login is ignored (fail closed)", () => {
    const outcome = classifyEvent(
      "issue_comment",
      issueCommentBody({ sender: { type: "User" } }),
      undefined,
      true,
      EVERY_PUSH,
    );
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
describe("REVIEW_ENABLED emergency brake (AC4a)", () => {
  test("classifyEvent with reviews disabled ignores even a whitelisted event", () => {
    const outcome = classifyEvent("pull_request", pullRequestBody("opened"), undefined, false);
    expect(outcome).toEqual({
      kind: "ignore",
      reason: "reviews stopped by the REVIEW_ENABLED emergency brake",
    });
  });

  test("classifyEvent with reviews disabled ignores a bot mention", () => {
    const outcome = classifyEvent("issue_comment", issueCommentBody(), undefined, false, EVERY_PUSH);
    expect(outcome.kind).toBe("ignore");
  });

  test("classifyEvent with reviews disabled logs a structured review_disabled_kill_switch warning", () => {
    const log = makeLog();
    const outcome = classifyEvent("pull_request", pullRequestBody("opened"), log, false);
    expect(outcome.kind).toBe("ignore");
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ event: "pull_request", reason: "review_disabled_kill_switch" });
    expect(msg).toContain("emergency brake");
  });

  test("classifyWebhook with reviews disabled ignores before any signature work", async () => {
    const log = makeLog();
    // Even a bad signature is ignored (2xx) — the emergency brake short-circuits
    // before verification, so a disabled worker never rejects/retries.
    const outcome = await classifyWebhook(SECRET, "{}", "sha256=deadbeef", "pull_request", log, false);
    expect(outcome).toEqual({
      kind: "ignore",
      reason: "reviews stopped by the REVIEW_ENABLED emergency brake",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("classifyWebhook with reviews enabled keeps the payload unchanged", async () => {
    const body = pullRequestBody("opened");
    const signature = await makeWebhooks(SECRET).sign(body);
    const outcome = await classifyWebhook(SECRET, body, signature, "pull_request", undefined, true);
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
});
