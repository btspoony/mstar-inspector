/**
 * Runtime harness shared by the consumer pipeline suites: one `createConsumerHarness()`
 * per test owns the injected sandbox, commenter, KV and log doubles plus the
 * queue-message builders, so two suites — or two cases in one suite — can never
 * clear each other's recorders.
 *
 * The `cloudflare:workers` shim and the consumer load live here: a test file
 * must never import consumer.ts before the workerd builtin is stubbed, so
 * `loadConsumer()` is the only route to the module under test.
 */
import { expect, mock } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { ConsumerLog, PipelineEnv } from "../../src/pipeline/consumer";
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

// Load shim only: consumer.ts statically imports ./sandbox → the workerd
// builtin `cloudflare:workers` (unresolvable in Bun's test runner). The
// consumer never calls the sandbox — every test injects the fake via
// createReviewConsumer overrides.
import "./cloudflare-workers-mock";

// Type-only: erased at compile time, so this import cannot run before the
// workerd shim above. `loadConsumer()` is the only runtime route to the module.
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

// The diff bound lives with the command that enforces it (gitops), not on the
// consumer — the double reproduces that read, so it takes the same one.
export { DIFF_PREFETCH_MAX_BYTES } from "../../src/pipeline/gitops";

/** Every per-test double, recorder and builder one harness instance owns. */
export type ConsumerHarness = {
  /** The injected sandbox double and the mutable state it reads. */
  fakeSandbox: {
    state: FakeSandboxState;
    runCommand: (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    destroy: () => Promise<void>;
  };
  sandbox: FakeSandboxState;
  /** Every commenter op the round issued, in order. */
  commenterCalls: CommenterCall[];
  /** Per-test commenter behaviour switches. */
  commenterState: FakeCommenterState;
  /** The commenter double itself, injected through `overrides`. */
  fakeCommenter: ReviewCommenter;
  /** The per-call `createReviewConsumer` overrides this instance injects. */
  overrides: {
    createAppCommenter: () => ReviewCommenter;
    getSandbox: (binding: unknown, id: string) => Promise<ReviewSandbox>;
  };
  /** Every structured log line the round emitted, in order. */
  logLines: TestLogLine[];
  testLog: ConsumerLog;
  /** Per-case KV behaviour: absent-key answer, per-key claims, failing read/write. */
  kvState: {
    getValue: string | null;
    getError: Error | undefined;
    entries: Map<string, string>;
    putError: Error | undefined;
  };
  /** Every KV write, in order (the idempotency/completion contract). */
  kvPuts: Array<{ key: string; value: string; options?: unknown }>;
  /** Delivery attempt the next `makeBatch` reports (the retry/DLQ counter). */
  queueState: { attempts: number };
  /** Every ack/retry the consumer asked of this instance's batch, in order. */
  messageRetryCalls: Array<{ attempts: number; delaySeconds?: number }>;
  messageAckCalls: Array<{ attempts: number }>;
  /** The env this instance's KV double is wired into (DB default: a seeded D1). */
  makeEnv: (envOverrides?: Partial<PipelineEnv>) => Promise<PipelineEnv>;
  /** A batch whose acks/retries land on this instance and whose gitops commands are declared on this instance's sandbox. */
  makeBatch: (payload: ReviewJobPayload) => MessageBatch<ReviewJobPayload>;
  /** Run a scripted failing stage and prove the credential is redacted everywhere the round publishes. */
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
  // --- sandbox fake (injected via createReviewConsumer overrides) -----------
  const fakeSandbox = createFakeSandbox();
  const sandbox = fakeSandbox.state;

  // --- commenter fake (injected via createReviewConsumer overrides) --------
  const commenterCalls: CommenterCall[] = [];
  const commenterState = initialFakeCommenterState();
  const fakeCommenter = createFakeCommenter(commenterState, commenterCalls);

  // Injected into every consumer under test (DI replaces mock.module).
  const overrides = {
    createAppCommenter: () => fakeCommenter,
    getSandbox: async () => fakeSandbox,
  };

  // --- test log sink (injected via the consumer's optional log param) ------
  const { lines: logLines, log: testLog } = createTestLog();

  /**
   * Per-case KV behaviour: the answer for keys absent from `entries` (the
   * completion marker), per-key claims (what the worker wrote for ONE commit),
   * and a failing read/write.
   */
  const kvState: ConsumerHarness["kvState"] = {
    getValue: null,
    getError: undefined,
    entries: new Map(),
    putError: undefined,
  };
  /** Every KV write, in order (the idempotency/completion contract). */
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
      // `??` short-circuits, so the seeded double is built ONLY when the case
      // does not bring its own DB — every recheck suite seeds one and the
      // migrated + App-seeded default was pure cost there.
      DB: envOverrides.DB ?? ((await createSeededTestD1()) as never),
      IDEMPOTENCY_KV: kv as never,
      SANDBOX: {} as never,
      DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
      ...envOverrides,
    };
  }

  function makeBatch(payload: ReviewJobPayload): MessageBatch<ReviewJobPayload> {
    // Declare the payload's own commands before the consumer can exec them.
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

  /**
   * Run the consumer over a scripted failing stage and prove the exact
   * credential is gone from every surface the round publishes: the thrown
   * message — whose non-secret `tail` really arrived, so a redaction that
   * blanked the message cannot pass — and the failure row it wrote. Returns
   * the message for the case's own per-stage pin; a stage whose credential
   * rides another surface asserts it in the case itself.
   */
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

// --- pure helpers (no recorder, no shared mutable state) --------------------

export function makePayload(overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload {
  return {
    installation_id: TEST_INSTALLATION_ID,
    owner: TEST_OWNER,
    repo: TEST_REPO,
    pr_number: TEST_PR_NUMBER,
    head_sha: SHA,
    action: "opened",
    triggered_by: "pull_request",
    appRef: { appId: TEST_APP_ID },
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
