/**
 * Runtime harness shared by the consumer pipeline suites: the injected sandbox,
 * commenter and KV doubles, the queue-message builder, the test log sink and
 * the job/payload builders. ONE copy — the main consumer suite and the recheck
 * suite's per-concern files each import it, so `reset()` clears exactly the
 * same state in every one of them.
 *
 * The `cloudflare:workers` shim and the DYNAMIC consumer import live here: a
 * test file must never import consumer.ts before the workerd builtin is
 * stubbed, and keeping both in one module makes that ordering structural.
 */
import { mock } from "bun:test";
import type { MessageBatch } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { PipelineEnv } from "../../src/pipeline/consumer";
import type { TestD1 } from "../store/helpers";
import type { CommenterCall } from "./review-commenter";
import { createFakeCommenter, initialFakeCommenterState } from "./review-commenter";
import {
  createFakeSandbox,
  createSeededTestD1,
  createTestLog,
  registerGitOpsCommands,
  resetFakeSandboxState,
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

// --- sandbox fake (injected via createReviewConsumer overrides) -------------
export const fakeSandbox = createFakeSandbox();
export const sandbox = fakeSandbox.state;

// --- commenter fake (injected via createReviewConsumer overrides) -----------
export const commenterCalls: CommenterCall[] = [];
export const commenterState = initialFakeCommenterState();
export const fakeCommenter = createFakeCommenter(commenterState, commenterCalls);

// Injected into every consumer under test (DI replaces mock.module).
export const testOverrides = {
  createAppCommenter: () => fakeCommenter,
  getSandbox: async () => fakeSandbox,
};

// --- consumer under test (dynamic import: mocks must be registered first) ---
// The module handle lives here so every suite reaches the consumer through
// this ONE loader (a static import would run before the workerd shim above).
export const {
  createReviewConsumer,
  runnerTimeoutMs,
  reviewGuardTtlSeconds,
  guardRetryDelaysSeconds,
  DIFF_PREFETCH_MAX_BYTES,
  INLINE_RESOLVE_MAX_ENTRIES,
  CHECK_HOOK_TIMEOUT_MS,
} = await import("../../src/pipeline/consumer");

// --- test log sink (injected via the consumer's optional log param) --------
export const { lines: logLines, log: testLog } = createTestLog();

// --- helpers ----------------------------------------------------------------
/** Per-case KV behaviour: the stored completion marker, and a failing write. */
export const kvState: { getValue: string | null; putError: Error | undefined } = {
  getValue: null,
  putError: undefined,
};
/** Every KV write, in order (the idempotency/completion contract). */
export const kvPuts: Array<{ key: string; value: string; options?: unknown }> = [];
const kv = {
  get: mock(async (_key: string) => kvState.getValue),
  put: mock(async (key: string, value: string, options?: unknown) => {
    kvPuts.push({ key, value, options });
    if (kvState.putError !== undefined) throw kvState.putError;
  }),
  delete: mock(async (_key: string) => {}),
};

/** Delivery attempt the next `makeBatch` reports (the retry/DLQ counter). */
export const queueState = { attempts: 1 };
/** Every ack/retry the consumer asked of the batch, in order. */
export const messageRetryCalls: Array<{ attempts: number; delaySeconds?: number }> = [];
export const messageAckCalls: Array<{ attempts: number }> = [];

export async function makeEnv(overrides: Partial<PipelineEnv> = {}): Promise<PipelineEnv> {
  return {
    DB: (await createSeededTestD1()) as never,
    IDEMPOTENCY_KV: kv as never,
    SANDBOX: {} as never,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    ...overrides,
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
    appRef: { appId: TEST_APP_ID },
    ...overrides,
  };
}

export function makeBatch(payload: ReviewJobPayload): MessageBatch<ReviewJobPayload> {
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

/** Clear every per-case knob before a test seeds its own. */
export function reset(): void {
  resetFakeSandboxState(sandbox);
  commenterCalls.length = 0;
  Object.assign(commenterState, initialFakeCommenterState());
  logLines.length = 0;
  kvPuts.length = 0;
  kvState.getValue = null;
  kvState.putError = undefined;
  queueState.attempts = 1;
  messageRetryCalls.length = 0;
  messageAckCalls.length = 0;
}

/** All rows of the review_failures table in the real D1 double. */
export function failureRows(db: TestD1): Array<Record<string, unknown>> {
  return db.raw.query("SELECT * FROM review_failures ORDER BY rowid").all() as Array<Record<string, unknown>>;
}
