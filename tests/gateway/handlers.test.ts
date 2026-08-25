import { describe, expect, mock, test, type Mock } from "bun:test";
import {
  createGatewayApp,
  handlePullRequest,
  handleReviewCommand,
  type GatewayEventLog,
} from "../../src/gateway/app";

type CapturedHandler = (context: unknown) => unknown;
type MockOn = Mock<(event: string, handler: CapturedHandler) => void>;
type MockInfo = Mock<(fields: GatewayEventLog, msg?: string) => void>;

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Fake Probot: records `on(event, handler)` registrations instead of dispatching. */
function makeMockApp(): { on: MockOn; handlers: Record<string, CapturedHandler> } {
  const handlers: Record<string, CapturedHandler> = {};
  const on = mock((event: string, handler: CapturedHandler) => {
    handlers[event] = handler;
  });
  return { on, handlers };
}

function makeLog(): { info: MockInfo } {
  return { info: mock((_fields: GatewayEventLog, _msg?: string) => {}) };
}

/** Minimal `pull_request` webhook payload fixture (no real webhook dependency). */
function pullRequestFixture(action: string, log = makeLog()) {
  return {
    payload: {
      action,
      installation: { id: 12345 },
      number: 42,
      pull_request: { number: 42, head: { sha: HEAD_SHA } },
      repository: { name: "inspector", owner: { login: "acme" } },
    },
    log,
  };
}

/** Minimal `issue_comment.created` webhook payload fixture. */
function issueCommentFixture(
  body: string,
  issue: { number: number; pull_request?: unknown },
  log = makeLog(),
) {
  return {
    payload: {
      action: "created",
      installation: { id: 12345 },
      comment: { body },
      issue,
      repository: { name: "inspector", owner: { login: "acme" } },
    },
    log,
  };
}

describe("createGatewayApp webhook registration", () => {
  test("registers only the whitelisted pull_request actions and issue_comment.created", () => {
    const appFn = createGatewayApp({ log: makeLog() });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    expect(Object.keys(handlers).sort()).toEqual([
      "issue_comment.created",
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ]);
  });

  test("non-whitelisted pull_request actions (e.g. closed) have no registered handler", () => {
    const appFn = createGatewayApp({ log: makeLog() });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    expect(handlers["pull_request.closed"]).toBeUndefined();
    expect(handlers["pull_request.labeled"]).toBeUndefined();
  });

  test("pull_request opened/synchronize/reopened log a structured event with idempotency fields", () => {
    const log = makeLog();
    const appFn = createGatewayApp({ log });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    for (const action of ["opened", "synchronize", "reopened"]) {
      const handler = handlers[`pull_request.${action}`];
      expect(handler, `handler registered for pull_request.${action}`).toBeDefined();
      handler?.(pullRequestFixture(action));

      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info.mock.calls[0]?.[0]).toMatchObject({
        event: "pull_request",
        action,
        installation_id: 12345,
        owner: "acme",
        repo: "inspector",
        pr_number: 42,
        head_sha: HEAD_SHA,
      });
      log.info.mockClear();
    }
  });

  test("issue_comment.created with a /review body on a PR logs the review command", () => {
    const log = makeLog();
    const appFn = createGatewayApp({ log });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    const handler = handlers["issue_comment.created"];
    expect(handler).toBeDefined();
    handler?.(issueCommentFixture("/review", { number: 42, pull_request: { html_url: "https://github.com/acme/inspector/pull/42" } }));

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "issue_comment",
      action: "created",
      installation_id: 12345,
      owner: "acme",
      repo: "inspector",
      pr_number: 42,
      head_sha: null,
    });
  });

  test("issue_comment.created with a non-/review body is ignored", () => {
    const log = makeLog();
    const appFn = createGatewayApp({ log });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    const handler = handlers["issue_comment.created"];
    expect(handler).toBeDefined();
    handler?.(issueCommentFixture("please review", { number: 42, pull_request: {} }));

    expect(log.info).not.toHaveBeenCalled();
  });
  test("issue_comment.created with a case-variant /Review body is ignored (case-sensitive)", () => {
    const log = makeLog();
    const appFn = createGatewayApp({ log });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    const handler = handlers["issue_comment.created"];
    expect(handler).toBeDefined();
    handler?.(issueCommentFixture("/Review", { number: 42, pull_request: {} }));

    expect(log.info).not.toHaveBeenCalled();
  });

  test("issue_comment.created on a non-PR issue is ignored", () => {
    const log = makeLog();
    const appFn = createGatewayApp({ log });
    const { on, handlers } = makeMockApp();
    appFn({ on } as never);

    const handler = handlers["issue_comment.created"];
    expect(handler).toBeDefined();
    handler?.(issueCommentFixture("/review", { number: 7 }));

    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("exported handler contract", () => {
  test("handlePullRequest logs event=pull_request with action and idempotency fields", async () => {
    const log = makeLog();
    await handlePullRequest(pullRequestFixture("opened", log));

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "pull_request",
      action: "opened",
      installation_id: 12345,
      owner: "acme",
      repo: "inspector",
      pr_number: 42,
      head_sha: HEAD_SHA,
    });
  });

  test("handleReviewCommand logs event=issue_comment with pr_number and head_sha null", async () => {
    const log = makeLog();
    await handleReviewCommand(issueCommentFixture("/review", { number: 42, pull_request: {} }, log));

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[0]).toMatchObject({
      event: "issue_comment",
      action: "created",
      installation_id: 12345,
      owner: "acme",
      repo: "inspector",
      pr_number: 42,
      head_sha: null,
    });
  });
});
