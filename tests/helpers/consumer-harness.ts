import { expect, mock } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { AttemptStarter, ConsumerLog, PipelineEnv } from "../../src/pipeline/consumer";
import { inlineWorkflowStarter } from "./workflow-route";
import type { ReviewSandbox } from "../../src/pipeline/sandbox";
import type { ReviewCommenter } from "../../src/pipeline/comment";
import type { TestD1 } from "../store/helpers";
import type { CommenterCall, FakeCommenterState } from "./review-commenter";
import { createFakeCommenter, initialFakeCommenterState } from "./review-commenter";
import type { FakeSandboxState, TestLogLine } from "./consumer-fixtures";
import {
  createFakeSandbox,
  createSeededTestD1,
  createTestLog,
  registerGitOpsCommands,
  SHA,
  TEST_APP_ID,
  TEST_INSTALLATION_ID,
  TEST_KEY,
  TEST_OWNER,
  TEST_PR_NUMBER,
  TEST_REPO,
} from "./consumer-fixtures";

import "./cloudflare-workers-mock";

import type * as consumerModuleNs from "../../src/pipeline/consumer";

/** The consumer module's exported surface, as `loadConsumer()` resolves it. */
export type ConsumerModule = typeof consumerModuleNs;

let consumerLoad: Promise<ConsumerModule> | undefined;

/**
 * Load the consumer under test through ONE cached promise. The workerd shim
 * above is already registered when this module is imported, so the dynamic
 * import is safe here and nowhere else.
 *
 * The cached promise REJECTS when the namespace came back without
 * `createReviewConsumer`: a half-built namespace otherwise fails later as
 * "x is not a function", which names the symptom and not the cause.
 */
export function loadConsumer(): Promise<ConsumerModule> {
  consumerLoad ??= import("../../src/pipeline/consumer").then((mod) => {
    if (typeof mod.createReviewConsumer !== "function") {
      throw new Error(
        "consumer-harness: ../../src/pipeline/consumer loaded without its exports — " +
          "the workerd shim must be registered before this import, and the module must not be shared with a concurrent loader",
      );
    }
    return mod;
  });
  return consumerLoad;
}

export { DIFF_PREFETCH_MAX_BYTES } from "../../src/pipeline/gitops";

/** Every per-test double, recorder and builder one harness instance owns. */
export type ConsumerHarness = {
  fakeSandbox: {
    state: FakeSandboxState;
    runCommand: (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    claimMarker: (marker: string) => Promise<"written" | "matched" | "unknown">;
    runMarked: (
      marker: string,
      cmd: string,
      opts?: unknown,
    ) => Promise<{ kind: "ran"; stdout: string; stderr: string; exitCode: number } | { kind: "unknown" }>;
    destroyMarked: (marker: string) => Promise<"destroyed" | "unknown">;
    destroy: () => Promise<void>;
  };
  sandbox: FakeSandboxState;
  commenterCalls: CommenterCall[];
  commenterState: FakeCommenterState;
  fakeCommenter: ReviewCommenter;
  overrides: {
    createAppCommenter: () => ReviewCommenter;
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
    startAttempt: AttemptStarter;
  };
  successorEnqueues: ReviewJobPayload[];
  logLines: TestLogLine[];
  testLog: ConsumerLog;
  kvState: {
    getValue: string | null;
    getError: Error | undefined;
    entries: Map<string, string>;
    putError: Error | undefined;
  };
  kvPuts: Array<{ key: string; value: string; options?: unknown }>;
  queueState: { attempts: number };
  messageRetryCalls: Array<{ attempts: number; delaySeconds?: number }>;
  messageAckCalls: Array<{ attempts: number }>;
  makeEnv: (envOverrides?: Partial<PipelineEnv>) => Promise<PipelineEnv>;
  makeBatch: (payload: ReviewJobPayload) => MessageBatch<ReviewJobPayload>;
  expectFailureRedacted: (
    consumer: (batch: MessageBatch<ReviewJobPayload>) => Promise<void>,
    db: TestD1,
    expected: { secret: string; tail: string },
  ) => Promise<string>;
};

/**
 * One test's doubles and builders. Nothing in here is shared: a recorder this
 * instance owns is invisible to every other instance, and the builders read
 * and write only this instance's state.
 */
export function createConsumerHarness(): ConsumerHarness {
  const fakeSandbox = createFakeSandbox();
  const sandbox = fakeSandbox.state;

  const commenterCalls: CommenterCall[] = [];
  const commenterState = initialFakeCommenterState();
  const fakeCommenter = createFakeCommenter(commenterState, commenterCalls);

  const successorEnqueues: ReviewJobPayload[] = [];
  const overrides = {
    createAppCommenter: () => fakeCommenter,
    getSandbox: async () => fakeSandbox,
    startAttempt: inlineWorkflowStarter(successorEnqueues),
  };

  const { lines: logLines, log: testLog } = createTestLog();

  const kvState: ConsumerHarness["kvState"] = {
    getValue: null,
    getError: undefined,
    entries: new Map(),
    putError: undefined,
  };
  const kvPuts: ConsumerHarness["kvPuts"] = [];
  const kv = {
    get: mock(async (key: string) => {
      if (kvState.getError !== undefined) throw kvState.getError;
      return kvState.entries.get(key) ?? kvState.getValue;
    }),
    put: mock(async (key: string, value: string, options?: unknown) => {
      kvPuts.push({ key, value, options });
      if (kvState.putError !== undefined) throw kvState.putError;
    }),
    delete: mock(async (_key: string) => {}),
  };

  const queueState = { attempts: 1 };
  const messageRetryCalls: ConsumerHarness["messageRetryCalls"] = [];
  const messageAckCalls: ConsumerHarness["messageAckCalls"] = [];

  async function makeEnv(envOverrides: Partial<PipelineEnv> = {}): Promise<PipelineEnv> {
    return {
      DB: envOverrides.DB ?? ((await createSeededTestD1()) as never),
      IDEMPOTENCY_KV: kv as never,
      SANDBOX: {} as never,
      DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
      ...envOverrides,
    };
  }

  function makeBatch(payload: ReviewJobPayload): MessageBatch<ReviewJobPayload> {
    registerGitOpsCommands(sandbox, payload);
    return {
      queue: "review-queue",
      messages: [
        {
          id: "m1",
          timestamp: new Date(),
          attempts: queueState.attempts,
          body: payload,
          retry: (options?: { delaySeconds?: number }) => {
            messageRetryCalls.push({ attempts: queueState.attempts, delaySeconds: options?.delaySeconds });
          },
          ack: () => {
            messageAckCalls.push({ attempts: queueState.attempts });
          },
        },
      ],
    } as unknown as MessageBatch<ReviewJobPayload>;
  }

  async function expectFailureRedacted(
    consumer: (batch: MessageBatch<ReviewJobPayload>) => Promise<void>,
    db: TestD1,
    { secret, tail }: { secret: string; tail: string },
  ): Promise<string> {
    const message = await consumer(makeBatch(makePayload())).then(
      () => {
        throw new Error("the scripted stage was expected to fail");
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(message).toContain(tail);
    expect(message).not.toContain(secret);
    expect(failureRows(db)).toHaveLength(1);
    expect(String(failureRows(db)[0]!.error)).not.toContain(secret);
    return message;
  }

  return {
    fakeSandbox,
    sandbox,
    commenterCalls,
    commenterState,
    fakeCommenter,
    overrides,
    successorEnqueues,
    logLines,
    testLog,
    kvState,
    kvPuts,
    queueState,
    messageRetryCalls,
    messageAckCalls,
    makeEnv,
    makeBatch,
    expectFailureRedacted,
  };
}


export function makePayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: TEST_INSTALLATION_ID,
    owner: TEST_OWNER,
    repo: TEST_REPO,
    pr_number: TEST_PR_NUMBER,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    botRef: { appId: TEST_APP_ID },
    targetId: `target-${TEST_APP_ID}`,
    ...overrides,
  };
}

/** All rows of the review_failures table in the real D1 double. */
export function failureRows(db: TestD1): Array<Record<string, unknown>> {
  return db.raw.query("SELECT * FROM review_failures ORDER BY rowid").all() as Array<Record<string, unknown>>;
}

/** The §7.10 coverage line's four numbers. */
export type CoverageNumbers = {
  assessed: number;
  selected: number;
  invalidOutput: number;
  omitted: number;
};

/**
 * The exact published coverage sentence for these numbers — the ONE place the
 * wording is spelled, so a suite pins the user-visible text without restating
 * it (and a wording change edits this helper, not every assertion).
 */
export function coverageLine(coverage: CoverageNumbers): string {
  return (
    `Reassessed ${coverage.assessed}/${coverage.selected} prior finding(s) this round` +
    ` · ${coverage.invalidOutput} invalid-output · ${coverage.omitted} omitted`
  );
}

/**
 * The published §7.10 coverage line's numbers, so a test can assert the
 * partition identity `assessed + invalid-output + omitted === selected` as
 * arithmetic instead of restating the line's literals. `null` when the body
 * carries no such line (a round with no prior finding renders `none`).
 */
export function coverageLineNumbers(body: string): CoverageNumbers | null {
  const match =
    /Reassessed (\d+)\/(\d+) prior finding\(s\) this round · (\d+) invalid-output · (\d+) omitted/.exec(body);
  if (match === null) return null;
  return {
    assessed: Number(match[1]),
    selected: Number(match[2]),
    invalidOutput: Number(match[3]),
    omitted: Number(match[4]),
  };
}
