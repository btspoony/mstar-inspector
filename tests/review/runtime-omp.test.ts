import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realSdkRoot from "@oh-my-pi/pi-coding-agent";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
  buildOutputValidator,
  type OutputValidator,
} from "@oh-my-pi/pi-coding-agent/tools/output-schema-validator";
import * as realStructuredSubagent from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { PR_REVIEW_NUDGE_CADENCE, PR_REVIEW_TIER_BUDGETS, synthesizeReview, validateMstarReviewV1 } from "@mstar-harness/engine";

import { RUNNER_MAX_BUDGET_MS, type AgentRuntime, type AgentRuntimeRunInput, type ReviewLevel, type ReviewRunResult } from "../../packages/shared/src/runtime";
import { RunnerBudgetExhausted } from "../../packages/shared/src/budget-exhausted-wire";
import { servedModel, type SupervisedSeat } from "../../packages/runner/src/runtime-omp";
import { anchorRecheckDeadline, RECHECK_OUTPUT_SCHEMA, remainingOuterMs, remainingSoftMinutes, resetRecheckAnchor } from "../../packages/runner/src/recheck";
import { REPORT_OUTPUT_SCHEMA } from "../../packages/runner/src/report";
import type { ReportDoc } from "../../packages/shared/src/report-wire";
import { RECHECK_STATUS_ERROR_MAX_CHARS, type RecheckDoc, type RecheckInput } from "../../packages/shared/src/recheck-wire";
import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";

const TEST_WORKTREE = mkdtempSync(join(tmpdir(), "omp-review-worktree-"));

afterAll(() => {
  rmSync(TEST_WORKTREE, { recursive: true, force: true });
});

const createdOptions: Record<string, unknown>[] = [];
let seatResults: Array<{
  error?: string;
  status?: string;
  data?: unknown;
  stderr?: string;
  aborted?: boolean;
  abortReason?: string;
  reject?: string;
  rejectWith?: unknown;
  awaitAbort?: boolean;
  readDiff?: boolean;
  firstTurnAfterMs?: number;
  requests?: number;
}> = [];
let installedSeatAgent: string | null = null;
let installedAgentFiles: string[] | null = null;
let installedSeatDefs: Record<string, string> | null = null;
let ghTokenAtCreation: string | undefined;
let githubTokenAtCreation: string | undefined;
let disposeCalls = 0;
const subagentRequests: Record<string, unknown>[] = [];
const reservedSeatIds: Array<string | undefined> = [];
const promptTexts: string[] = [];
let parentYields: unknown[] = [];
let parentYieldErrors: string[] = [];
let parentRejectedYields: unknown[] = [];
let parentPromptThrow: string | null = null;
let parentAgentEnd: unknown[] | null = null;
let parentParkedEnd: unknown[] | null = null;
let parentResumeYields: unknown[] = [];
let parentResumeEnd: unknown[] | null = null;
let disposeCallsAtResume: number | null = null;
let parentParkedEndObserved: (() => void) | null = null;
const yieldListeners: Array<(event: unknown) => void> = [];

const PARENT_SESSION_ID = "review-parent";

const nudgeCalls: Array<{ id: string; deliverAs: string; text: string }> = [];

const registryRefs = new Map<string, { id: string; status: string; session: unknown }>();

let parentStreaming = true;
let parentPromptStarted: (() => void) | null = null;
let parentPromptRelease: Promise<void> | null = null;
let holdSeats = false;
let seatReleases: Array<() => void> = [];
let seatDispatchQueue: Array<() => void> = [];

const parentAbortReasons: Array<{ reason?: string }> = [];
let parentTurnAborted = false;
let resolveParentTurn: (() => void) | null = null;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSeatSession(id: string): { isStreaming: boolean } & Record<string, unknown> {
  return {
    isStreaming: true,
    prompt: mock(async (text: string, options?: { streamingBehavior?: string }) => {
      nudgeCalls.push({ id, deliverAs: options?.streamingBehavior ?? "turn", text });
      return true;
    }),
    steer: mock(async (text: string) => {
      nudgeCalls.push({ id, deliverAs: "steer", text });
    }),
  };
}

function registerSeat(id: string): { isStreaming: boolean } & Record<string, unknown> {
  const session = fakeSeatSession(id);
  registryRefs.set(id, { id, status: "running", session });
  return session;
}

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  ...realSdkRoot,
  createAgentSession: mock(async (options: Record<string, unknown>) => {
    createdOptions.push(options);
    disposeCalls = 0;
    const installed = join(options.cwd as string, ".omp", "agents", "mstar-review-seat.md");
    installedSeatAgent = existsSync(installed) ? readFileSync(installed, "utf8") : null;
    const agentsDir = join(options.cwd as string, ".omp", "agents");
    installedAgentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).sort() : null;
    installedSeatDefs = null;
    if (installedAgentFiles !== null && !installedAgentFiles.includes("mstar-review-seat.md")) {
      installedSeatDefs = {};
      for (const name of installedAgentFiles) {
        installedSeatDefs[name] = readFileSync(join(agentsDir, name), "utf8");
      }
    }
    ghTokenAtCreation = process.env.GH_TOKEN;
    githubTokenAtCreation = process.env.GITHUB_TOKEN;
    return {
      session: {
        getAgentId: mock(() => PARENT_SESSION_ID),
        sessionManager: options.sessionManager,
        dispose: mock(async () => {
          disposeCalls += 1;
        }),
        get isStreaming() {
          return parentStreaming;
        },
        steer: mock(async (text: string) => {
          nudgeCalls.push({ id: PARENT_SESSION_ID, deliverAs: "steer", text });
        }),
        subscribe: mock((listener: (event: unknown) => void) => {
          yieldListeners.push(listener);
          return () => {};
        }),
        abort: mock(async (options?: { reason?: string }) => {
          parentAbortReasons.push({ reason: options?.reason });
          parentTurnAborted = true;
          resolveParentTurn?.();
        }),
        prompt: mock(async (text: string, options?: { streamingBehavior?: string }) => {
          if (options?.streamingBehavior !== undefined) {
            nudgeCalls.push({ id: PARENT_SESSION_ID, deliverAs: options.streamingBehavior, text });
            return true;
          }
          promptTexts.push(text);
          parentPromptStarted?.();
          const turnGate = deferred();
          resolveParentTurn = turnGate.resolve;
          if (parentPromptRelease === null) queueMicrotask(turnGate.resolve);
          await Promise.race([parentPromptRelease ?? turnGate.promise, turnGate.promise]);
          if (parentTurnAborted) {
            parentStreaming = false;
            return true;
          }
          const listener = yieldListeners[yieldListeners.length - 1];
          parentRejectedYields.forEach((data, index) => {
            listener?.({
              type: "tool_execution_end",
              toolCallId: `yield-rejected-${index}`,
              toolName: "yield",
              isError: true,
              result: { content: [], details: { data, status: "success" } },
            });
          });
          parentYields.forEach((data, index) => {
            listener?.({
              type: "tool_execution_end",
              toolCallId: `yield-${index}`,
              toolName: "yield",
              isError: false,
              result: { content: [], details: { data, status: "success", type: undefined } },
            });
          });
          parentYieldErrors.forEach((error, index) => {
            listener?.({
              type: "tool_execution_end",
              toolCallId: `yield-error-${index}`,
              toolName: "yield",
              isError: false,
              result: { content: [], details: { data: undefined, status: "aborted", error } },
            });
          });
          if (parentParkedEnd !== null) {
            listener?.({
              type: "agent_pause",
              messages: parentParkedEnd,
              yielded: true,
              awaiting: false,
            });
            parentParkedEndObserved?.();
            const resumedYields = parentResumeYields;
            const resumedEnd = parentResumeEnd;
            const resumedFrames: Array<() => void> = resumedYields.map((data, index) => {
              return () => {
                listener?.({
                  type: "tool_execution_end",
                  toolCallId: `resume-yield-${index}`,
                  toolName: "yield",
                  isError: false,
                  result: { content: [], details: { data, status: "success", type: undefined } },
                });
              };
            });
            if (resumedEnd !== null) {
              resumedFrames.push(() => {
                listener?.({
                  type: "agent_end",
                  messages: resumedEnd,
                });
              });
            }
            const deliverResumed = (index: number): void => {
              setImmediate(() => {
                if (index === 0) disposeCallsAtResume = disposeCalls;
                resumedFrames[index]?.();
                if (index + 1 < resumedFrames.length) deliverResumed(index + 1);
              });
            };
            deliverResumed(0);
          }
          if (parentAgentEnd !== null) {
            listener?.({
              type: "agent_end",
              messages: parentAgentEnd,
            });
          }
          if (parentPromptThrow !== null) {
            throw new Error(parentPromptThrow);
          }
          return true;
        }),
      },
    };
  }),
  SessionManager: {
    inMemory: mock((cwd?: string) => ({ kind: "in-memory", cwd })),
  },
  Settings: {
    isolated: mock((overrides?: Record<string, unknown>) => ({ kind: "isolated", overrides })),
  },
  loadSkillsFromDir: mock(async () => ({
    skills: [{ name: "mstar-audit" }, { name: "other-skill" }],
    warnings: [],
  })),
  AgentRegistry: {
    global: mock(() => ({
      get: mock((id: string) => registryRefs.get(id)),
    })),
  },
}));

mock.module("@oh-my-pi/pi-coding-agent/task/structured-subagent", () => ({
  ...realStructuredSubagent,
  runStructuredSubagent: mock(async (request: Record<string, unknown>) => {
    subagentRequests.push(request);
    const identity = request.identity as { id?: string } | undefined;
    reservedSeatIds.push(identity?.id);
    seatDispatchQueue.shift()?.();
    const plan = seatResults.shift() ?? {};
    // The SDK monitor reports `status: "running"` before any model call (a
    // label or session event), so every seat emits that LABEL snapshot first.
    // Only a snapshot with `requests >= 1` is a real model turn, and that is
    // what starts the runner's budget clock: the delay simulates setup cost
    // (session creation, skill load) and must never be charged.
    const progressHook = request.onProgress as
      | ((progress: { status: string; requests: number }) => void)
      | undefined;
    progressHook?.({ status: "running", requests: 0 });
    if (plan.firstTurnAfterMs !== undefined) {
      const delay = plan.firstTurnAfterMs;
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      progressHook?.({ status: "running", requests: 1 });
    }
    if (holdSeats) {
      await new Promise<void>((resolve) => seatReleases.push(resolve));
    }
    if (plan.awaitAbort) {
      const signal = request.signal as AbortSignal;
      await new Promise<void>((resolve, reject) => {
        // why: The real executor converts a cap abort into a settled result
        // whose abortReason carries the cap vocabulary; the runner's watchdog
        // stamps that reason onto the signal, so the test double resolves the
        // same settled shape instead of rejecting with a bare AbortError.
        const settleAborted = (): void => {
          const reason = signal.reason instanceof Error ? signal.reason.message : "aborted";
          resolve();
          plan.aborted = true;
          plan.abortReason = reason;
          plan.status = "absent";
        };
        if (signal.aborted) {
          settleAborted();
          return;
        }
        signal.addEventListener("abort", settleAborted, { once: true });
      });
    }
    if (plan.reject !== undefined) throw new Error(plan.reject);
    if ("rejectWith" in plan) throw plan.rejectWith;
    const status = plan.status ?? "valid";
    // A seat test double whose only tool surface is a file read: readDiff
    // mirrors the real seat — parse the pinned snapshot path out of its own
    // assignment, read that file, and conclude from what it sees there.
    const data = plan.readDiff === true ? diffDrivenFindings(request.assignment as string) : plan.data;
    return {
      result: {
        index: 0,
        id: `seat-${subagentRequests.length}`,
        agent: "mstar-review-seat",
        exitCode: plan.error ? 1 : 0,
        output: "",
        stderr: plan.stderr ?? "",
        error: plan.error,
        aborted: plan.aborted,
        abortReason: plan.abortReason,
        requests: plan.requests ?? 0,
        structuredOutput:
          status === "absent"
            ? undefined
            : { source: "caller", mode: "strict", status, data },
      },
      policy: {},
      mergeSummary: "",
      changesApplied: null,
      artifactsDir: "/tmp/fake-artifacts",
      temporaryArtifacts: true,
    };
  }),
}));

const RUNTIME_OMP_SPEC = "../../packages/runner/src/runtime-omp.ts?test=runtime-omp";
const {
  ompAgentRuntime,
  superviseSeats,
  seatDeadlineMs,
  seatStopLine,
  seatStartStage,
  seatDoneStage,
  seatGapStage,
  seatFailedStage,
  seatTraceId,
  startsFirstTurn,
  recheckStage,
  reportStage,
  reportSkipStage,
  reportFailedStage,
  reportEligibility,
  SUMMARY_MD_BUDGET,
  SEAT_GAP_MAX_CHARS,
} = (await import(RUNTIME_OMP_SPEC)) as {
  ompAgentRuntime: AgentRuntime;
  superviseSeats: (opts: {
    seats: readonly SupervisedSeat[];
    level: ReviewLevel;
    done: Promise<void>;
  }) => Promise<void>;
  seatDeadlineMs: (nowMs: number, firstTurnMs: number, level: ReviewLevel) => number;
  startsFirstTurn: (progress: { status: string; requests?: number }) => boolean;
  seatTraceId: (index: number, id: string) => string;
  reportSkipStage: (reason: string) => string;
  reportFailedStage: (cause: string | undefined) => string;
  reportEligibility: (
    input: AgentRuntimeRunInput,
    envelope: { incomplete?: unknown; target?: { head_sha?: string } },
    signal?: AbortSignal,
  ) => { ok: true; headSha: string } | { ok: false; reason: string };
  seatStopLine: (seat: string, reason: string | undefined) => string;
  seatStartStage: (seat: string) => string;
  seatDoneStage: (seat: string, turns: number | undefined) => string;
  seatGapStage: (seat: string, reason: string | undefined, turns?: number) => string;
  seatFailedStage: (seat: string, cause: string | undefined) => string;
  recheckStage: (result: {
    doc: unknown;
    status: { outcome: string; reason?: string };
    usage?: { requests?: number };
  }) => string;
  reportStage: (report: unknown, turns: number | undefined) => string;
  SUMMARY_MD_BUDGET: number;
  SEAT_GAP_MAX_CHARS: number;
};

function seatPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    findings: [
      {
        mergeClass: "must-fix",
        title: "Unbounded loop",
        body: "The loop never terminates on empty input.",
        file_path: "src/a.ts",
        line_start: 10,
        line_end: 20,
      },
    ],
    ...overrides,
  };
}

function deepEnvelope(): unknown {
  return {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "## Review\n\nOne should-fix finding.",
    findings: [
      {
        mergeClass: "should-fix",
        title: "Missing null check",
        body: "The handler assumes the payload is always present.",
        file_path: "lib/c.ts",
        line_start: 4,
      },
    ],
    target: { owner: "acme", repo: "widgets", pr: 7, head_sha: HEAD_SHA },
  };
}

function stoppedTurn(text: string, errorMessage?: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: errorMessage === undefined ? "stop" : "aborted",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function toolOnlyTurn(errorMessage?: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "task", arguments: {} }],
    stopReason: errorMessage === undefined ? "stop" : "aborted",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

const HEAD_SHA = "abc1234567890abcdef1234567890abcdef12";

async function flushMicrotasks(rounds = 50): Promise<void> {
  // why: microtask-only flushes cannot reach real fs/timer completions the
  // runtime awaits before dispatch (readFile/writeFile macrotasks); the
  // setImmediate turns let the event loop deliver them between rounds.
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const TWO_CLUSTER_FACTS = [
  "acme/widgets#7",
  `head ${HEAD_SHA}`,
  "10\t2\tsrc/a.ts",
  "5\t0\tsrc/b.ts",
  "8\t1\tlib/c.ts",
];

/** The `src/` cluster's seat scope, in the order the fan-out sorts it. */
const RECON_SRC_SCOPE = ["src/a.ts", "src/b.ts"];

const AGENT_DIR = "/tmp/omp-agent-test";

const TEST_AUTH_STORAGE = { close: () => {}, kind: "in-memory-credential-store" } as never;

const BASE_INPUT = {
  level: "default" as const,
  worktreePath: TEST_WORKTREE,
  reconFacts: TWO_CLUSTER_FACTS,
  modelSelectors: ["ark/deepseek-v4-flash", "ark/backup-model"],
  agentDir: AGENT_DIR,
  authStorage: TEST_AUTH_STORAGE,
};

const DEEP_INPUT = { ...BASE_INPUT, level: "deep" as const };

afterEach(() => {
  createdOptions.length = 0;
  subagentRequests.length = 0;
  reservedSeatIds.length = 0;
  seatResults = [];
  installedSeatAgent = null;
  installedAgentFiles = null;
  installedSeatDefs = null;
  ghTokenAtCreation = undefined;
  githubTokenAtCreation = undefined;
  disposeCalls = 0;
  promptTexts.length = 0;
  parentYields = [];
  parentYieldErrors = [];
  parentRejectedYields = [];
  parentPromptThrow = null;
  parentAgentEnd = null;
  parentParkedEnd = null;
  parentResumeYields = [];
  parentResumeEnd = null;
  disposeCallsAtResume = null;
  parentParkedEndObserved = null;
  parentAbortReasons.length = 0;
  parentTurnAborted = false;
  resolveParentTurn = null;
  yieldListeners.length = 0;
  nudgeCalls.length = 0;
  registryRefs.clear();
  parentStreaming = true;
  parentPromptStarted = null;
  parentPromptRelease = null;
  holdSeats = false;
  seatReleases = [];
  seatDispatchQueue = [];
  jest.useRealTimers();
  delete process.env.OMP_REVIEW_MODEL;
  resetRecheckAnchor();
});

describe("ompAgentRuntime.runReview — parent session", () => {
  test("keeps the M1 isolation set and drops appendSystemPrompt", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(createdOptions).toHaveLength(1);
    const options = createdOptions[0]!;
    expect(options.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...BASE_INPUT.modelSelectors] },
      },
    });
    expect(options.restrictToolNames).toBe(true);
    expect(options.toolNames).toEqual(["read", "grep", "glob"]);
    expect(options.requireYieldTool).toBe(false);
    expect(options.outputSchema).toBeUndefined();
    expect(options.enableMCP).toBe(false);
    expect(options.appendSystemPrompt).toBeUndefined();
    expect(options.additionalExtensionPaths).toEqual([PLUGIN_ROOT_FIXTURE]);
    expect(options.skills).toEqual([{ name: "mstar-audit" }, { name: "other-skill" }]);
  });

  test("session cwd is input.worktreePath, never a throwaway temp dir", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(createdOptions[0]!.cwd).toBe(TEST_WORKTREE);
    expect(subagentRequests).toHaveLength(2);
    for (const request of subagentRequests) {
      const seatSession = request.session as { cwd: unknown };
      expect(seatSession.cwd).toBe(TEST_WORKTREE);
    }
  });

  test("parent model + fallback chain come from input.modelSelectors, never re-parsed from env", async () => {
    process.env.OMP_REVIEW_MODEL = "ark/env-only-model";
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    const options = createdOptions[0]!;
    expect(options.modelPattern).toBe(BASE_INPUT.modelSelectors[0]);
    expect(options.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...BASE_INPUT.modelSelectors] },
      },
    });
  });

  test("empty modelSelectors fails loud instead of inventing a provider", async () => {
    seatResults = [{ data: seatPayload() }];
    await expect(
      ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", modelSelectors: [] }),
    ).rejects.toThrow(/no model selector/);
    expect(createdOptions).toHaveLength(0);
    expect(subagentRequests).toHaveLength(0);
  });

  test("installs seat-agent.md into the PR clone at .omp/agents/ and removes it afterwards", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(installedSeatAgent).toBe(readFileSync(join(import.meta.dir, "../../packages/runner/src/seat-agent.md"), "utf8"));
    expect(installedSeatAgent).toContain("name: mstar-review-seat");
    expect(installedSeatAgent).toContain("tools: [read, grep, glob]");
    expect(installedSeatAgent).not.toMatch(/^spawns:/m);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
    expect(disposeCalls).toBe(1);
  });
});

function statedMinutes(prompt: string): Array<{ minutes: number; over: boolean }> {
  return [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*min\w*(\s+\w+)?/gi)].map(([, value, marker]) => ({
    minutes: Number(value),
    over: /^over/i.test((marker ?? "").trim()),
  }));
}

function statedRemainder(prompt: string, capMinutes: number): number {
  const fact = statedMinutes(prompt).find((entry) => entry.minutes !== capMinutes || entry.over);
  if (fact === undefined) {
    throw new Error("rendered seat prompt states no shared-clock remainder");
  }
  return fact.over ? -fact.minutes : fact.minutes;
}

describe("ompAgentRuntime.runReview — seat fan-out", () => {
  test("default level fans out exactly two seats via runStructuredSubagent", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(subagentRequests).toHaveLength(2);
    for (const request of subagentRequests) {
      expect(request.invocationKind).toBe("task");
      expect(request.agent).toBe("mstar-review-seat");
      expect(request.schemaMode).toBe("strict");
      expect(request.outputSchema).toBeDefined();
      expect(request.model).toEqual([...BASE_INPUT.modelSelectors]);
      expect(request.enableLsp).toBe(false);
      expect(request.enableIrc).toBe(false);
    }
    const assignments = subagentRequests.map((request) => request.assignment as string);
    expect(assignments[0]).toContain("changeset-1-src");
    expect(assignments[1]).toContain("changeset-2-lib");
    expect(reservedSeatIds).toEqual(["changeset-1-src", "changeset-2-lib"]);
  });

  test("seat assignment is engine prReviewSeatPrompt output carrying worktree + scope", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    const first = subagentRequests[0]!.assignment as string;
    expect(first).toContain(TEST_WORKTREE);
    expect(first).toContain(`${PLUGIN_ROOT_FIXTURE}/skills/mstar-audit`);
    expect(first).toContain("acme/widgets#7");
    expect(first).toContain("src/a.ts");
    expect(first.toLowerCase()).toContain("merge class");
  });

  test("each dispatch states the SHARED remainder — never a fresh full allowance", async () => {
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    const dispatch = async (elapsedMinutes: number): Promise<string> => {
      anchorRecheckDeadline(Date.now() - elapsedMinutes * 60_000, "default");
      seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
      const before = subagentRequests.length;
      await ompAgentRuntime.runReview(BASE_INPUT);
      return subagentRequests[before]!.assignment as string;
    };

    const fourIn = await dispatch(4);
    expect(fourIn).toContain(String(PR_REVIEW_TIER_BUDGETS.default.fileOpenCap));
    expect(statedMinutes(fourIn)).toContainEqual({ minutes: cap, over: false });
    expect(statedRemainder(fourIn, cap)).toBe(cap - 4);

    const sevenIn = await dispatch(7);
    expect(statedRemainder(sevenIn, cap)).toBe(cap - 7);
    expect(statedRemainder(sevenIn, cap)).toBeLessThan(statedRemainder(fourIn, cap));

    const overCap = await dispatch(cap + 3);
    expect(statedMinutes(overCap)).toContainEqual({ minutes: 3, over: true });
    expect(statedRemainder(overCap, cap)).toBe(-3);
  });

  test("quick level fans out exactly one seat", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    expect(subagentRequests).toHaveLength(1);
    expect(subagentRequests[0]!.agent).toBe("mstar-review-seat");
  });

  test("rejects a non-delivered level instead of silently degrading", async () => {
    await expect(
      ompAgentRuntime.runReview({ ...BASE_INPUT, level: "nope" as never }),
    ).rejects.toThrow(/unsupported review level/);
    expect(subagentRequests).toHaveLength(0);
    expect(promptTexts).toHaveLength(0);
  });

  test("propagates SDK execution failures while the wave still has a review to publish", async () => {
    seatResults = [{ error: "provider boom" }, { data: seatPayload() }];
    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(
      /review seat 0 .*failed: provider boom/,
    );
    expect(disposeCalls).toBe(1);
  });

  test("a strict schema violation with no usable output reports the wave incomplete, never a clean verdict", async () => {
    seatResults = [{ status: "invalid", data: { findings: [{ mergeClass: "critical" }] } }];
    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(envelope.incomplete?.reason).toMatch(
      /^no dispatched seat produced a usable payload: .+/,
    );
    expect(envelope.incomplete?.unscanned).toEqual([expect.stringContaining("full-diff-combined")]);
  });

  test("an absent structured output with no usable output reports the wave incomplete", async () => {
    seatResults = [{ status: "absent" }];
    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(envelope.incomplete?.unscanned).toEqual([expect.stringContaining("full-diff-combined")]);
  });
});

/**
 * The seat test double's whole tool surface: parse the pinned snapshot path
 * out of the seat's own assignment, read that file, and report the guard a
 * REMOVED line carried — a finding that cannot exist without the diff text,
 * since the checkout only holds the file's head state.
 */
function diffDrivenFindings(assignment: string): unknown {
  const path = assignment.match(/Read the pinned diff snapshot FIRST: `([^`]+)`/)?.[1];
  if (path === undefined) throw new Error("assignment carries no pinned diff snapshot");
  const diffText = readFileSync(path, "utf8");
  const removedGuard = diffText
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---") && line.includes("throw"))
    .map((line) => line.slice(1).trim());
  return {
    findings: removedGuard.map((guard) => ({
      mergeClass: "must-fix",
      title: "Removed guard",
      body: `The diff deletes a guard: ${guard}`,
      file_path: "src/a.ts",
      line_start: 1,
    })),
  };
}

const GUARD_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,5 +10,4 @@",
  " export function handle(user) {",
  "-  if (!user) throw new Error(\"unauthenticated\");",
  "   return user.name;",
  " }",
  "",
].join("\n");

describe("ompAgentRuntime.runReview — the seat receives the pinned diff", () => {
  function pinDiff(): string {
    const path = join(tmpdir(), `omp-test-diff-${crypto.randomUUID()}.diff`);
    writeFileSync(path, GUARD_DIFF);
    process.env.MSTAR_REVIEW_DIFF_PATH = path;
    return path;
  }

  afterEach(() => {
    delete process.env.MSTAR_REVIEW_DIFF_PATH;
  });

  test("the seat assignment carries the snapshot path and the prompt's read-first line names it", async () => {
    const pinned = pinDiff();
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    for (const request of subagentRequests) {
      const assignment = request.assignment as string;
      expect(assignment).toContain(`Read the pinned diff snapshot FIRST: \`${pinned}\``);
      expect(assignment).toContain("read it before opening files");
    }
  });

  test("no pinned file: the assignment omits the diff ingredient entirely", async () => {
    delete process.env.MSTAR_REVIEW_DIFF_PATH;
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    for (const request of subagentRequests) {
      // why: The engine's file-open-cap prose mentions the snapshot
      // unconditionally; only the read-first ingredient is diffFile-driven.
      expect(request.assignment as string).not.toContain("Read the pinned diff snapshot FIRST");
    }
  });

  test("a seat whose only tools are reads produces a finding that requires a removed line", async () => {
    pinDiff();
    seatResults = [{ readDiff: true }];
    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    expect(envelope.verdict).not.toBe("incomplete");
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.findings[0]!.title).toBe("Removed guard");
    expect(envelope.findings[0]!.body).toContain("unauthenticated");
  });
});

describe("ompAgentRuntime.runReview — hard seat cap (collected vs uncollected)", () => {
  const softCapMs = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes * 60_000;
  const TAIL_MS = 60_000;

  test("the SDK wall-clock timer is disabled: the watchdog owns the cap, anchored at the first model turn", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    anchorRecheckDeadline(Date.now() + 3_600_000, "default");
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(subagentRequests[0]!.maxRuntimeMs).toBe(0);
    expect(subagentRequests[1]!.maxRuntimeMs).toBe(0);
    expect(subagentRequests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(false);
  });

  test("every seat's window is the FULL tier ceiling, bounded only by the absolute deadline", () => {
    const level = "default" as const;
    const ceiling = RUNNER_MAX_BUDGET_MS.default;
    const turn = Date.now();
    anchorRecheckDeadline(turn, level, turn + 3_600_000);

    // One seat or many, early turn or late turn: the window is the ceiling.
    expect(seatDeadlineMs(turn, turn, level) - turn).toBe(ceiling);
    expect(seatDeadlineMs(turn + 400_000, turn, level) - turn).toBe(ceiling);

    // The attempt's absolute deadline (less the publication tail) is the only
    // thing that can shorten it — and nothing can widen it.
    anchorRecheckDeadline(turn, level, turn + 250_000 + TAIL_MS);
    expect(seatDeadlineMs(turn + 1, turn, level)).toBe(turn + 250_000);
  });

  test("two concurrent seats each get the whole ceiling — neither dies at half the window", async () => {
    jest.useFakeTimers();
    const ceiling = RUNNER_MAX_BUDGET_MS.default;
    anchorRecheckDeadline(Date.now(), "default", Date.now() + 3_600_000);
    const dispatched = [deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [
      { firstTurnAfterMs: 0, awaitAbort: true },
      { firstTurnAfterMs: 0, awaitAbort: true },
    ];

    const run = ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error);
    await Promise.all([dispatched[0]!.promise, dispatched[1]!.promise]);
    await flushMicrotasks();

    // WHY this assertion is the fix's proof: the discarded design divided the
    // ceiling across seats, so both would die just past ceiling/2 here.
    jest.advanceTimersByTime(Math.ceil(ceiling / 2) + 5_000);
    await flushMicrotasks();
    for (const request of subagentRequests) {
      expect((request.signal as AbortSignal).aborted).toBe(false);
    }

    // Each seat aborts on its OWN ceiling, not on a share.
    jest.advanceTimersByTime(Math.ceil(ceiling / 2) + 5_000);
    await flushMicrotasks();
    for (const request of subagentRequests) {
      expect((request.signal as AbortSignal).aborted).toBe(true);
      expect(String((request.signal as AbortSignal).reason as Error)).toMatch(
        new RegExp(`task\\.maxRuntimeMs=${ceiling}`),
      );
    }
    await run;
  });

  test("a seat's clock starts at its first REAL model turn, not at the running label", async () => {
    jest.useFakeTimers();
    const level = "quick" as const;
    const ceiling = RUNNER_MAX_BUDGET_MS.quick;
    // Setup longer than the whole ceiling: if the clock started at dispatch —
    // or at the monitor's initial `running` label — the seat would already be
    // dead by the first assertion.
    const setupMs = ceiling + 50_000;
    anchorRecheckDeadline(Date.now(), level, Date.now() + 3_600_000);
    const dispatched = [deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ firstTurnAfterMs: setupMs, awaitAbort: true }];

    const run = ompAgentRuntime.runReview({ ...BASE_INPUT, level }).catch((error: unknown) => error);
    await dispatched[0]!.promise;
    await flushMicrotasks();

    jest.advanceTimersByTime(ceiling + 1_000);
    await flushMicrotasks();
    const signal = subagentRequests[0]!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // Past the first real turn, the seat owns a fresh full ceiling.
    jest.advanceTimersByTime(setupMs - ceiling);
    await flushMicrotasks();
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(ceiling + 1_000);
    await flushMicrotasks();
    expect(signal.aborted).toBe(true);
    await run;
  });

  test("a seat that never emits a model turn is still bounded — the absolute deadline stops it", async () => {
    jest.useFakeTimers();
    // A wedged child: no progress snapshot at all, so no first turn. Disabling
    // the SDK timer may not leave its signal unbounded.
    anchorRecheckDeadline(Date.now(), "default", Date.now() + 2_000);
    const dispatched = [deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ awaitAbort: true }];

    const run = ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" }).catch((error: unknown) => error);
    await dispatched[0]!.promise;
    await flushMicrotasks();
    jest.advanceTimersByTime(3_000);
    await flushMicrotasks();

    const signal = subagentRequests[0]!.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason as Error)).toMatch(/Subagent runtime limit exceeded/);
    await run;
  });

  test("a spent outer budget still bounds the seat — the watchdog aborts at the first tick after its first turn", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now() - 700_000, "default");
    const dispatched = [deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [
      { firstTurnAfterMs: 0, awaitAbort: true },
      { firstTurnAfterMs: 0, data: seatPayload({ findings: [] }) },
    ];

    const run = ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error);
    // Await the seats' own dispatch — the fan-out's fs setup is real I/O a
    // fixed flush count cannot guarantee under fake timers.
    await Promise.all([dispatched[0]!.promise, dispatched[1]!.promise]);

    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();

    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(true);
    // The sibling completed, so the round delivers a partial review rather
    // than a budget stop — the watchdog's abort is still the capped seat's.
    const result = (await run) as ReviewRunResult;
    expect(result).not.toBeInstanceOf(RunnerBudgetExhausted);
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
  });

  test("a full wave is collected with full coverage: findings land, stoppedReason null, nothing unreviewed", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    const { envelope, coverage } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(envelope).not.toHaveProperty("summary_md");
    expect(envelope).not.toHaveProperty("incomplete");
    expect(coverage).toEqual({ seatsTotal: 2, seatsCompleted: 2, stoppedReason: null, unreviewed: [] });
  });

  test("one capped seat and one completed seat deliver the completed findings with coverage naming 1/2 and the stopped scope", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)" },
      { data: seatPayload() },
    ];
    const result = await ompAgentRuntime.runReview(BASE_INPUT);

    // The delivered review is the completed seat's review — never a failure.
    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(result.envelope).not.toHaveProperty("incomplete");
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
    // The runner's log line names the seat and its abort reason verbatim.
    expect(seatStopLine("changeset-1-part-1", "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)")).toBe(
      "review seat changeset-1-part-1 stopped by cap: Subagent runtime limit exceeded (task.maxRuntimeMs=540000)",
    );
  });

  test("a cap that fires after the seat collected something delivers that payload but never counts the seat as reviewed", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      seatResults = [
        {
          aborted: true,
          abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)",
          data: {
            findings: [
              {
                mergeClass: "should-fix",
                title: "Missing null check",
                body: "The handler assumes the payload is always present.",
                file_path: "lib/c.ts",
                line_start: 4,
              },
            ],
          },
        },
        { data: seatPayload({ findings: [] }) },
      ];
      result = await ompAgentRuntime.runReview(BASE_INPUT);
    } finally {
      spy.mockRestore();
    }

    // what the seat found before the cap is delivered (the sibling found none)…
    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Missing null check"]);
    // …but the cut-off seat's scope is honestly reported as not reviewed.
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
  });

  test("an abort the runtime limit did not cause stays fatal — the flag alone is not coverage", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: "Provider stream closed unexpectedly" },
      { data: seatPayload() },
    ];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/no valid structured output/);
  });

  test("an aborted seat with no reason at all stays fatal — never an inferred cap", async () => {
    seatResults = [{ status: "absent", aborted: true }, { data: seatPayload() }];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/no valid structured output/);
  });

  test("an SDK error without a cap stays fatal while the wave still has usable output", async () => {
    seatResults = [{ error: "provider exploded" }, { data: seatPayload() }];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/review seat 0 .*failed:/);
  });

  test("a payload the strict schema rejected without a cap stays fatal — invalid is not absent", async () => {
    seatResults = [
      {
        status: "invalid",
        data: { findings: [{ mergeClass: "must-fix", title: "Rejected payload", body: "x" }] },
      },
      { data: seatPayload() },
    ];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/no valid structured output/);
  });

  test("both seats capped before producing anything is still a failure: no envelope, no report, the reason named", async () => {
    const CAP = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let stop: unknown;
    try {
      seatResults = [
        { status: "absent", aborted: true, abortReason: CAP },
        { status: "absent", aborted: true, abortReason: CAP },
      ];
      stop = await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error);
    } finally {
      spy.mockRestore();
    }

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    const exhausted = stop as RunnerBudgetExhausted;
    expect(exhausted.seatsDispatched).toBe(2);
    expect(exhausted.seatsStopped).toBe(2);
    // Nothing was reviewed, so nothing is invented: no report seat, no envelope.
    expect(subagentRequests).toHaveLength(2);
    expect(exhausted.report).toBeNull();
    // The failure text names each seat and its reason (the same line the
    // runner writes to stderr); the module-bound console is not spyable here.
    expect(seatStopLine("changeset-1-part-1", CAP)).toBe(
      `review seat changeset-1-part-1 stopped by cap: ${CAP}`,
    );
    expect(seatStopLine("changeset-2-part-2", CAP)).toBe(
      `review seat changeset-2-part-2 stopped by cap: ${CAP}`,
    );
  });

  test("a partial delivery still runs the report seat, and a failed report never discards the found findings", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      seatResults = [
        { status: "absent", aborted: true, abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)" },
        { data: seatPayload() },
        { error: "model unavailable" },
      ];
      result = await ompAgentRuntime.runReview({
        ...BASE_INPUT,
        prContext: { prBody: "Closes #7", issues: [] },
      });
    } finally {
      spy.mockRestore();
    }

    // The report seat WAS dispatched (third request) and its failure is only
    // narrative loss — the coverage and the findings stand.
    expect(subagentRequests).toHaveLength(3);
    expect(result.report).toBeNull();
    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
  });
});

describe("ompAgentRuntime.runReview — a stopped wave: budget stops signal, other losses stay incomplete", () => {
  const CAP_REASON = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";

  test("a wave the cap stopped with no usable output reports the signal, every dispatched seat counted", async () => {
    seatResults = [{ status: "absent", aborted: true, abortReason: CAP_REASON }];

    const stop = (await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(1);
    expect(stop.seatsStopped).toBe(1);
  });

  test("both seats capped before any output: the wave is a budget stop and counts both seats", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON },
      { status: "absent", aborted: true, abortReason: CAP_REASON },
    ];

    const stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(2);
    expect(stop.seatsStopped).toBe(2);
  });

  test("a nothing-usable round is an actionable incomplete envelope: no coverage, and no report seat invented", async () => {
    // QC F-001: a zero-completed coverage block would fail the runner's own
    // transport guard and replace this failure with a shape error.
    seatResults = [{ status: "absent" }, { status: "absent" }];
    const result = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      prContext: { prBody: "Closes #7", issues: [] },
    });

    expect(result.envelope.verdict).toBe("incomplete");
    expect(result.envelope.incomplete?.reason).toMatch(/^no dispatched seat produced a usable payload/);
    expect(result.coverage).toBeUndefined();
    // No report seat was dispatched: there is nothing to narrate.
    expect(subagentRequests).toHaveLength(2);
    expect(result.report).toBeNull();
  });

  test("a wave that produced nothing usable without any cap is delivered incomplete, every seat listed", async () => {
    seatResults = [{ status: "absent" }, { status: "absent" }];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.incomplete?.reason).toMatch(
      /^no dispatched seat produced a usable payload: .+/,
    );
    expect(envelope.incomplete?.unscanned).toEqual([
      expect.stringContaining("changeset-1-src"),
      expect.stringContaining("changeset-2-lib"),
    ]);
  });

  test("a whole wave of SDK errors with no usable output is delivered incomplete too", async () => {
    seatResults = [{ error: "provider boom" }];

    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(envelope.incomplete?.reason).toMatch(
      /^no dispatched seat produced a usable payload: .+/,
    );
    expect(envelope.incomplete?.unscanned).toEqual([expect.stringContaining("full-diff-combined")]);
  });

  test("every seat promise rejected: the wave is incomplete and lists every dispatched seat", async () => {
    seatResults = [{ reject: "provider boom" }, { reject: "provider boom" }];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.incomplete?.reason).toMatch(
      /^no dispatched seat produced a usable payload: provider boom$/,
    );
    expect(envelope.incomplete?.unscanned).toEqual([
      expect.stringContaining("changeset-1-src"),
      expect.stringContaining("changeset-2-lib"),
    ]);
  });

  test("a seat promise rejected with null keeps its cause as a fact, not an empty string", async () => {
    seatResults = [{ rejectWith: null }, { reject: "provider boom" }];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe("no dispatched seat produced a usable payload: null");
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
  });

  test("a cap over an SDK error in one seat no longer sinks the sibling's review", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON, error: CAP_REASON },
      { data: seatPayload() },
    ];

    const result = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(result.coverage?.seatsCompleted).toBe(1);
    expect(result.coverage?.stoppedReason).toBe("cap");
  });

  test("a cap over a schema-rejected payload delivers the sibling and never the refused payload", async () => {
    seatResults = [
      {
        status: "invalid",
        aborted: true,
        abortReason: CAP_REASON,
        data: {
          findings: [
            {
              mergeClass: "must-fix",
              title: "Rejected payload finding",
              body: "The strict schema refused this payload.",
              file_path: "src/z.ts",
              line_start: 1,
            },
          ],
        },
      },
      { data: seatPayload() },
    ];

    const result = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
  });

  test("one stopped seat of two: the sibling's findings are delivered with 1/2 coverage", async () => {
    seatResults = [{ status: "absent", aborted: true, abortReason: CAP_REASON }, { data: seatPayload() }];

    const result = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(result.envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(result.envelope.incomplete).toBeUndefined();
    expect(result.coverage).toEqual({
      seatsTotal: 2,
      seatsCompleted: 1,
      stoppedReason: "cap",
      unreviewed: [{ seat: "changeset-1-src", scope: RECON_SRC_SCOPE }],
    });
  });

  test("no stopped seat: the envelope is the engine's own synthesis, fact and notes absent", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.incomplete).toBeUndefined();
    expect(envelope).toEqual(
      synthesizeReview({
        findings: [
          {
            mergeClass: "must-fix",
            title: "Unbounded loop",
            body: "The loop never terminates on empty input.",
            file_path: "src/a.ts",
            line_start: 10,
            line_end: 20,
          },
        ],
        target: { owner: "acme", repo: "widgets", pr: 7, head_sha: "abc1234567890abcdef1234567890abcdef12" },
      }),
    );
  });
});

describe("ompAgentRuntime.runReview — the budget stop's facts and bounds", () => {
  const CAP_REASON = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";

  test("the signal reports ONLY the seat counts the runner observed (no completed seat)", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON },
      { status: "absent", aborted: true, abortReason: CAP_REASON },
    ];

    const stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(2);
    expect(stop.seatsStopped).toBe(2);
    expect(stop.signal()).toEqual({
      schema: "mstar.review-budget-exhausted/v1",
      seatsDispatched: 2,
      seatsStopped: 2,
    });
  });

  test("a wave mixing a cap stop with a cap-free loss is a budget stop, counting only the capped seat", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON },
      { status: "absent" },
    ];

    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let stop: RunnerBudgetExhausted;
    try {
      stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;
    } finally {
      spy.mockRestore();
    }

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(2);
    expect(stop.seatsStopped).toBe(1);
    const lost = errorCalls.map((call) => String(call[0])).filter((line) => line.includes("lost beside a cap stop"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("changeset-2-lib");
  });

  test("a cap stop outranks a sibling's non-cap error even while the wave holds usable output", async () => {
    seatResults = [
      { aborted: true, abortReason: CAP_REASON, data: seatPayload() },
      { error: "provider exploded" },
    ];
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let stop: RunnerBudgetExhausted;
    try {
      stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;
    } finally {
      spy.mockRestore();
    }

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(2);
    expect(stop.seatsStopped).toBe(1);
    const lost = errorCalls.map((call) => String(call[0])).filter((line) => line.includes("lost beside a cap stop"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("changeset-2-lib");
    expect(lost[0]).toContain("provider exploded");
  });

  test("a cap stop outranks a seat promise that rejected outright", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON },
      { reject: "provider boom" },
    ];
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let stop: RunnerBudgetExhausted;
    try {
      stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;
    } finally {
      spy.mockRestore();
    }

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(2);
    expect(stop.seatsStopped).toBe(1);
    const lost = errorCalls.map((call) => String(call[0])).filter((line) => line.includes("lost beside a cap stop"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("changeset-2-lib");
    expect(lost[0]).toContain("provider boom");
  });

  test("a null rejection reason rides the sibling-loss line, not an empty detail", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: CAP_REASON },
      { rejectWith: null },
    ];
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let stop: RunnerBudgetExhausted;
    try {
      stop = (await ompAgentRuntime.runReview(BASE_INPUT).catch((error: unknown) => error)) as RunnerBudgetExhausted;
    } finally {
      spy.mockRestore();
    }

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    const lost = errorCalls.map((call) => String(call[0])).filter((line) => line.includes("lost beside a cap stop"));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("changeset-2-lib");
    expect(lost[0]).toContain(": null");
  });

  test("a stopped deep turn still lands incomplete — no runner deadline evidence", async () => {
    parentAgentEnd = [{ role: "assistant", content: [{ type: "text", text: "partial notes" }] }];
    seatResults = [];

    const { envelope } = await ompAgentRuntime.runReview({ ...DEEP_INPUT });

    expect(envelope.verdict).toBe("incomplete");
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
  });

  test("a deep turn the runner's own deadline stops throws the signal", async () => {
    anchorRecheckDeadline(Date.now() - 60_000, "deep", Date.now() + 50);
    parentPromptRelease = new Promise(() => {});

    await expect(ompAgentRuntime.runReview({ ...DEEP_INPUT })).rejects.toBeInstanceOf(
      RunnerBudgetExhausted,
    );
    expect(parentAbortReasons).toEqual([{ reason: "runner deadline reached" }]);
  });

  test("a yield before the runner deadline does not outrank the stop that ends the turn", async () => {
    anchorRecheckDeadline(Date.now() - 60_000, "deep", Date.now() + 50);
    parentPromptStarted = () => {
      yieldListeners[yieldListeners.length - 1]?.({
        type: "tool_execution_end",
        toolCallId: "yield-early",
        toolName: "yield",
        isError: false,
        result: { content: [], details: { data: deepEnvelope(), status: "success", type: undefined } },
      });
    };
    parentPromptRelease = new Promise(() => {});

    const stop = (await ompAgentRuntime.runReview({ ...DEEP_INPUT }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(1);
    expect(stop.seatsStopped).toBe(1);
    expect(parentAbortReasons).toEqual([{ reason: "runner deadline reached" }]);
  });

  test("a parked turn that yielded before the pause still signals when its deadline stops the continuation", async () => {
    anchorRecheckDeadline(Date.now(), "deep", Date.now() + 50);
    parentYields = [deepEnvelope()];
    parentParkedEnd = [{ role: "user", content: [{ type: "text", text: "parked" }] }];
    parentResumeEnd = null;

    const stop = (await ompAgentRuntime.runReview({ ...DEEP_INPUT }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(1);
    expect(stop.seatsStopped).toBe(1);
    expect(parentAbortReasons.length).toBeGreaterThan(0);
    expect(parentAbortReasons.every((call) => call.reason === "runner deadline reached")).toBe(true);
  });

  test("an assignment read that blocks past the deadline declines the turn — 0/0 seats, never a dispatched 1/1", async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "mstar-harness-slow-"));
    cpSync(PLUGIN_ROOT_FIXTURE, pluginRoot, { recursive: true });
    const commandPath = join(pluginRoot, "commands", "amazing-pr-review.md");
    rmSync(commandPath);
    Bun.spawnSync(["mkfifo", commandPath]);
    const writer = Bun.spawn(
      ["sh", "-c", `sleep 0.15; printf 'fixture command' > ${commandPath}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    const previousRoot = process.env.HARNESS_PLUGIN_ROOT;
    process.env.HARNESS_PLUGIN_ROOT = pluginRoot;
    try {
      anchorRecheckDeadline(Date.now() - 60_000, "deep", Date.now() + 50);
      const stop = (await ompAgentRuntime.runReview({ ...DEEP_INPUT }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

      expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
      expect(stop.seatsDispatched).toBe(0);
      expect(stop.seatsStopped).toBe(0);
      expect(promptTexts).toHaveLength(0);
      expect(parentAbortReasons).toHaveLength(0);
    } finally {
      if (previousRoot === undefined) delete process.env.HARNESS_PLUGIN_ROOT;
      else process.env.HARNESS_PLUGIN_ROOT = previousRoot;
      writer.kill();
      rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  test("a read that resolves after the deadline declined the turn still counts 0/0", async () => {
    anchorRecheckDeadline(Date.now() - 60_000, "deep", Date.now() - 1);

    const stop = (await ompAgentRuntime.runReview({ ...DEEP_INPUT }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(0);
    expect(stop.seatsStopped).toBe(0);
    expect(promptTexts).toHaveLength(0);
    expect(parentAbortReasons).toHaveLength(0);
  });
});

describe("ompAgentRuntime.runReview — per-role model overrides", () => {
  test("quick/default: the mstar-review-seat override replaces the seat model chain verbatim", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      modelOverrides: { "mstar-review-seat": "ark/deepseek-v4-flash:high" },
    });

    expect(subagentRequests).toHaveLength(2);
    for (const request of subagentRequests) {
      expect(request.model).toEqual(["ark/deepseek-v4-flash:high"]);
    }
    expect(createdOptions[0]!.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...BASE_INPUT.modelSelectors] },
      },
    });
  });

  test("quick/default: the App chain stays the session-level retry fallback under a seat override", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      modelOverrides: { "mstar-review-seat": "ark/override-model" },
    });

    expect(createdOptions[0]!.modelPattern).toBe(BASE_INPUT.modelSelectors[0]);
    expect((createdOptions[0]!.settings as { overrides: Record<string, unknown> }).overrides[
      "retry.fallbackChains"
    ]).toEqual({ default: [...BASE_INPUT.modelSelectors] });
  });

  test("quick/default: a seat override cannot stand in for a missing global chain", async () => {
    seatResults = [{ data: seatPayload() }];
    await expect(
      ompAgentRuntime.runReview({
        ...BASE_INPUT,
        level: "quick",
        modelSelectors: [],
        modelOverrides: { "mstar-review-seat": "ark/override-model" },
      }),
    ).rejects.toThrow(/no model selector/);
    expect(createdOptions).toHaveLength(0);
  });

  test("quick/default: overrides for other seats and blank values leave today's synthesis untouched", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      modelOverrides: { "code-reviewer": "ark/other:high", "mstar-review-seat": "   " },
    });

    for (const request of subagentRequests) {
      expect(request.model).toEqual([...BASE_INPUT.modelSelectors]);
    }
  });

  test("quick/default: an empty overrides map is byte-compat with today's options and seat models", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    const baselineOptions = JSON.stringify(createdOptions[0]);
    const baselineModels = JSON.stringify(subagentRequests.map((request) => request.model));

    createdOptions.length = 0;
    subagentRequests.length = 0;
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", modelOverrides: {} });

    expect(JSON.stringify(createdOptions[0])).toBe(baselineOptions);
    expect(JSON.stringify(subagentRequests.map((request) => request.model))).toBe(baselineModels);
  });

  test("deep: the overrides map lands in the isolated settings as task.agentModelOverrides (exact agent names)", async () => {
    parentYields = [deepEnvelope()];
    const overrides = {
      "code-reviewer": "ark/deepseek-v4-flash:high",
      "fullstack-dev": "openai/gpt-5",
      "frontend-dev": "anthropic/claude-x:low",
    };
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, modelOverrides: overrides });

    expect(createdOptions[0]!.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...DEEP_INPUT.modelSelectors] },
        "task.agentModelOverrides": overrides,
      },
    });
    expect(createdOptions[0]!.modelPattern).toBe(DEEP_INPUT.modelSelectors[0]);
    expect(createdOptions[0]!.toolNames).toEqual(["read", "grep", "glob", "task"]);
    expect(createdOptions[0]!.requireYieldTool).toBe(true);
  });

  test("deep: an absent or empty overrides map keeps today's settings byte-for-byte", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);
    const baseline = JSON.stringify(createdOptions[0]);

    createdOptions.length = 0;
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, modelOverrides: {} });
    expect(JSON.stringify(createdOptions[0])).toBe(baseline);
  });

  test("deep: mapped settings = the no-map settings plus EXACTLY the overrides key (diff-of-one drift lock)", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);
    const baseOverrides = (createdOptions[0]!.settings as { overrides: Record<string, unknown> })
      .overrides;

    createdOptions.length = 0;
    parentYields = [deepEnvelope()];
    const overrides = { "code-reviewer": "ark/deepseek-v4-flash:high", "frontend-dev": "openai/gpt-5" };
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, modelOverrides: overrides });
    const mappedOverrides = (createdOptions[0]!.settings as { overrides: Record<string, unknown> })
      .overrides;

    expect(Object.keys(mappedOverrides)).toEqual([...Object.keys(baseOverrides), "task.agentModelOverrides"]);
    expect(JSON.stringify(mappedOverrides)).toBe(
      JSON.stringify({ ...baseOverrides, "task.agentModelOverrides": overrides }),
    );
  });
});

describe("ompAgentRuntime.runReview — deep parent path", () => {
  test("drives the parent session: one prompt, zero seat fan-out", async () => {
    parentYields = [deepEnvelope()];
    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(promptTexts).toHaveLength(1);
    expect(subagentRequests).toHaveLength(0);
    expect(promptTexts[0]).toContain(TEST_WORKTREE);
    expect(promptTexts[0]).toContain("acme/widgets#7");
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(disposeCalls).toBe(1);
  });

  test("the parent session is dispatched with the shared budget head before the role context", async () => {
    const cap = PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes;
    const elapsedMinutes = 5;
    anchorRecheckDeadline(Date.now() - elapsedMinutes * 60_000, "deep");
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    const prompt = promptTexts[0]!;
    const head = prompt.slice(0, prompt.indexOf(TEST_WORKTREE));
    expect(head.length).toBeGreaterThan(0);
    expect(head).toContain("deep");
    expect(head).toContain(`${cap} min`);
    expect(head).toContain(`${cap - elapsedMinutes} min`);
    expect(head).not.toContain(`${cap} min left`);
    expect(head).toMatch(/summari[sz]e/i);
    expect(head).toMatch(/return/i);
    expect(head).toMatch(/supervis/i);
  });

  test("parent session keeps the isolation set and adds the task tool + strict yield schema", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(createdOptions).toHaveLength(1);
    const options = createdOptions[0]!;
    expect(options.cwd).toBe(TEST_WORKTREE);
    expect(options.restrictToolNames).toBe(true);
    expect(options.toolNames).toEqual(["read", "grep", "glob", "task"]);
    expect(options.outputSchema).toBeDefined();
    expect(options.outputSchemaMode).toBe("strict");
    expect(options.requireYieldTool).toBe(true);
    expect(options.enableMCP).toBe(false);
    expect(options.appendSystemPrompt).toBeUndefined();
    expect(options.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...DEEP_INPUT.modelSelectors] },
      },
    });
  });

  test("returns the strict yield payload after engine re-validation", async () => {
    parentYields = [deepEnvelope()];
    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.findings[0]!.title).toBe("Missing null check");
  });

  test("a schema-rejected yield attempt is retried: the later success wins (qc2 F-002)", async () => {
    parentRejectedYields = [{ schema: "mstar.review/v1", verdict: "ship it", summary_md: "bad", findings: [] }];
    parentYields = [deepEnvelope()];
    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("needs fixes");
  });

  test("the LAST successful yield wins over an earlier accepted one (qc3 S-001)", async () => {
    parentYields = [
      { schema: "mstar.review/v1", verdict: "ship it", summary_md: "earlier", findings: [] },
      deepEnvelope(),
    ];
    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.findings).toHaveLength(1);
  });

  test("a prompt throw AFTER a successful yield is logged, not fatal (qc3 S-002)", async () => {
    parentYields = [deepEnvelope()];
    parentPromptThrow = "provider connection dropped after the yield";
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    try {
      const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);
      expect(envelope.schema).toBe("mstar.review/v1");
    } finally {
      spy.mockRestore();
    }
    // Trace stages share the console; the warning is its own call, not first.
    const raised = errorCalls.find((args) => String(args[0]).includes("deep parent turn raised"));
    expect(raised).toBeDefined();
    expect(String(raised![1])).toContain("provider connection dropped");
  });

  test("a prompt throw WITHOUT a yield rethrows the turn error", async () => {
    parentPromptThrow = "model provider exploded before any yield";
    await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(
      "model provider exploded before any yield",
    );
    expect(subagentRequests).toHaveLength(0);
  });

  test("a yield payload that fails engine validation is fatal", async () => {
    parentYields = [
      {
        schema: "mstar.review/v1",
        verdict: "ship it",
        summary_md: "x",
        findings: [{ mergeClass: "critical", title: "t", body: "b" }],
      },
    ];
    await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(
      /failed mstar\.review\/v1 validation/,
    );
    expect(promptTexts).toHaveLength(1);
  });

  test("a parent turn without a structured yield is fatal", async () => {
    await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(/no structured yield/);
    expect(promptTexts).toHaveLength(1);
    expect(subagentRequests).toHaveLength(0);
  });

  test("a yielded error result is fatal", async () => {
    parentYieldErrors = ["model refused"];
    await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(
      /deep parent yielded an error: model refused/,
    );
  });

  test("a stopped deep turn lands incomplete with its gathered summary and scope", async () => {
    parentAgentEnd = [stoppedTurn("## Findings so far\n\nlib/c.ts needs a null check.")];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.findings).toEqual([]);
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.incomplete).toEqual({
      reason: "deep parent turn produced no structured yield (mstar.review/v1 envelope)",
      unscanned: ["deep-parent: the whole diff"],
    });
    expect(envelope.tally?.incomplete).toEqual(envelope.incomplete);
    expect(envelope.summary_md).toContain("lib/c.ts needs a null check");
    expect(envelope.target).toEqual({
      owner: "acme",
      repo: "widgets",
      pr: 7,
      head_sha: "abc1234567890abcdef1234567890abcdef12",
    });
  });

  test("the gathered summary is bounded by the published body budget, its cut marked", async () => {
    parentAgentEnd = [stoppedTurn("x".repeat(SUMMARY_MD_BUDGET + 1))];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect((envelope.summary_md ?? "").length).toBeLessThanOrEqual(SUMMARY_MD_BUDGET);
    expect(envelope.summary_md).toContain("summary truncated");
  });

  test("a stop the SDK reported is the declared cause, one line, and no summary is fabricated", async () => {
    parentAgentEnd = [stoppedTurn("", "Deadline exceeded\nwhile streaming\n(the tier cap)")];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe("Deadline exceeded while streaming (the tier cap)");
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.summary_md).toBeUndefined();
    expect(envelope).not.toHaveProperty("summary_md");
  });

  test("a reported yield error is the cause of a stopped turn", async () => {
    parentAgentEnd = [stoppedTurn("I could not finish the review.")];
    parentYieldErrors = ["model refused"];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe("deep parent yielded an error: model refused");
  });

  test("a stopped turn whose prompt also threw states that failure as the cause", async () => {
    parentAgentEnd = [stoppedTurn("partial notes")];
    parentPromptThrow = "provider connection dropped";

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe("deep parent turn failed: provider connection dropped");
  });

  test("an end whose transcript carries no assistant message is still a stopped turn", async () => {
    parentAgentEnd = [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [] }];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe(
      "deep parent turn produced no structured yield (mstar.review/v1 envelope)",
    );
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
  });

  test("a tool-only terminal assistant entry does not erase the text an earlier entry gathered", async () => {
    parentAgentEnd = [
      stoppedTurn("## Findings so far\n\nlib/c.ts needs a null check."),
      toolOnlyTurn("Deadline exceeded while the seat ran"),
    ];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe("Deadline exceeded while the seat ran");
    expect(envelope.summary_md).toContain("lib/c.ts needs a null check");
  });

  test("a transcript whose assistant entries all lack text keeps the summary absent", async () => {
    parentAgentEnd = [toolOnlyTurn()];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete?.reason).toBe(
      "deep parent turn produced no structured yield (mstar.review/v1 envelope)",
    );
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.summary_md).toBeUndefined();
  });

  test("a turn that yielded is unchanged by the end event", async () => {
    parentAgentEnd = [stoppedTurn("wrapping up")];
    parentYields = [deepEnvelope()];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.findings[0]!.title).toBe("Missing null check");
    expect(envelope.summary_md).toBe("## Review\n\nOne should-fix finding.");
    expect(envelope.incomplete).toBeUndefined();
  });

  test("a parked end waits for the resumed terminal end and reports THAT stop", async () => {
    parentParkedEnd = [stoppedTurn("Interrupted mid-review.", "Deadline exceeded")];
    parentResumeEnd = [stoppedTurn("Resumed and wrapped up.", "Cancelled after the pause")];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.incomplete?.reason).toBe("Cancelled after the pause");
    expect(envelope.summary_md).toContain("Resumed and wrapped up.");
    expect(envelope.summary_md).not.toContain("Interrupted mid-review.");
    expect(disposeCallsAtResume).toBe(0);
    expect(disposeCalls).toBe(1);
  });

  test("a parked end that a resumed yield resolves returns the yielded envelope", async () => {
    parentParkedEnd = [stoppedTurn("Parked prose.", "Deadline exceeded")];
    parentResumeYields = [deepEnvelope()];
    parentResumeEnd = [stoppedTurn("Post-yield prose.")];

    const parkedDelivered = deferred();
    parentParkedEndObserved = parkedDelivered.resolve;
    const run = ompAgentRuntime.runReview(DEEP_INPUT);
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await parkedDelivered.promise;
    expect(settled).toBe(false);

    const { envelope } = await run;

    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.summary_md).toBe("## Review\n\nOne should-fix finding.");
    expect(envelope.incomplete).toBeUndefined();
    expect(disposeCallsAtResume).toBe(0);
    expect(disposeCalls).toBe(1);
  });

  test("a parked continuation's later corrected yield replaces the first", async () => {
    parentParkedEnd = [stoppedTurn("Parked prose.", "Deadline exceeded")];
    const corrected = {
      ...(deepEnvelope() as Record<string, unknown>),
      summary_md: "## Review\n\nCorrected after the first yield.",
    };
    parentResumeYields = [deepEnvelope(), corrected];
    parentResumeEnd = [stoppedTurn("Post-yield prose.")];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.summary_md).toBe("## Review\n\nCorrected after the first yield.");
    expect(envelope.summary_md).not.toContain("Post-yield prose.");
    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.incomplete).toBeUndefined();
    expect(disposeCalls).toBe(1);
  });

  test("a parked turn whose terminal end lands as the prompt settles reports that end, not a deadline stop", async () => {
    parentParkedEnd = [stoppedTurn("Interrupted mid-review.", "Deadline exceeded")];
    parentResumeEnd = null;
    parentAgentEnd = [stoppedTurn("Settled as the prompt unwound.", "Cancelled after the pause")];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.verdict).toBe("incomplete");
    expect(validateMstarReviewV1(envelope).ok).toBe(true);
    expect(envelope.incomplete?.reason).toBe("Cancelled after the pause");
    expect(envelope.summary_md).toContain("Settled as the prompt unwound.");
    expect(parentAbortReasons.every((call) => call.reason !== "runner deadline reached")).toBe(true);
    expect(disposeCalls).toBe(1);
  });

  test("a parked turn that never comes back expires its bounded wait into the budget signal", async () => {
    anchorRecheckDeadline(Date.now(), "deep", Date.now() + 50);
    parentParkedEnd = [{ role: "user", content: [{ type: "text", text: "parked" }] }];
    parentResumeEnd = null;

    const stop = (await ompAgentRuntime.runReview({ ...DEEP_INPUT }).catch((error: unknown) => error)) as RunnerBudgetExhausted;

    expect(stop).toBeInstanceOf(RunnerBudgetExhausted);
    expect(stop.seatsDispatched).toBe(1);
    expect(stop.seatsStopped).toBe(1);
  });

  test("installs the deep seat roles as OMP-native defs and removes them after", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(installedAgentFiles).toEqual(["code-reviewer.md", "frontend-dev.md", "fullstack-dev.md"]);
    expect(installedSeatAgent).toBeNull();
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
    expect(disposeCalls).toBe(1);
  });

  test("every installed seat parses as a read-only OMP agent via the SDK parser (qc2 F-001)", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(installedSeatDefs).not.toBeNull();
    for (const [name, content] of Object.entries(installedSeatDefs!)) {
      const agent = parseAgent(name, content, "project");
      expect(agent.name).toBe(name.replace(/\.md$/, ""));
      expect(agent.tools).toEqual(["read", "grep", "glob", "yield"]);
      expect(agent.structured).toBe(true);
      expect(agent.systemPrompt).toContain(`# fixture agent: ${agent.name}`);
    }
  });

  test("a partially-failed install cleans the seat files from the clone (qc1 F-002)", async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "mstar-harness-partial-"));
    cpSync(PLUGIN_ROOT_FIXTURE, pluginRoot, { recursive: true });
    const previousRoot = process.env.HARNESS_PLUGIN_ROOT;
    process.env.HARNESS_PLUGIN_ROOT = pluginRoot;
    try {
      rmSync(join(pluginRoot, "agents", "fullstack-dev.md"));
      await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(
        /missing the deep seat role agents\/fullstack-dev\.md/,
      );
    } finally {
      if (previousRoot === undefined) delete process.env.HARNESS_PLUGIN_ROOT;
      else process.env.HARNESS_PLUGIN_ROOT = previousRoot;
      rmSync(pluginRoot, { recursive: true, force: true });
    }
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
  });

  test("assignment loads the review command from the plugin root at runtime (zero copy)", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(promptTexts[0]).toContain("Fixture marker for the pinned 3.5.0 command.");
  });

  test("GitHub token aliases never reach the deep parent env and are restored after success", async () => {
    process.env.GH_TOKEN = "test-installation-token";
    process.env.GITHUB_TOKEN = "test-classic-token";
    parentYields = [deepEnvelope()];
    try {
      await ompAgentRuntime.runReview(DEEP_INPUT);
      expect(ghTokenAtCreation).toBeUndefined();
      expect(githubTokenAtCreation).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("test-installation-token");
      expect(process.env.GITHUB_TOKEN).toBe("test-classic-token");
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    }
  });

  test("GitHub token aliases are restored even when the deep run fails", async () => {
    process.env.GH_TOKEN = "test-installation-token";
    process.env.GITHUB_TOKEN = "test-classic-token";
    try {
      await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(/no structured yield/);
      expect(ghTokenAtCreation).toBeUndefined();
      expect(githubTokenAtCreation).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("test-installation-token");
      expect(process.env.GITHUB_TOKEN).toBe("test-classic-token");
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    }
  });
});

function parentYieldValidator(): OutputValidator {
  const { validator, error } = buildOutputValidator(createdOptions[0]?.outputSchema);
  if (validator === undefined) {
    throw new Error(`parent output schema produced no validator: ${error ?? "unconstrained"}`);
  }
  return validator;
}

const INCOMPLETE_FACT = { reason: "seat budget exhausted", unscanned: ["lib/c.ts"] };

describe("ompAgentRuntime.runReview — strict parent yield schema (engine 4.0.4)", () => {
  test("an incomplete deep yield passes the strict schema and the engine gate", async () => {
    const payload = {
      ...(deepEnvelope() as Record<string, unknown>),
      verdict: "incomplete",
      incomplete: INCOMPLETE_FACT,
    };
    parentYields = [payload];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(parentYieldValidator().validate(payload).success).toBe(true);
    expect(envelope.verdict).toBe("incomplete");
    expect(envelope.incomplete).toEqual(INCOMPLETE_FACT);
  });

  test("a tally carrying band and the incomplete echo passes the strict schema", async () => {
    const payload = {
      ...(deepEnvelope() as Record<string, unknown>),
      verdict: "incomplete",
      incomplete: INCOMPLETE_FACT,
      tally: {
        verdict: "incomplete",
        scorePct: 82,
        band: "good",
        tally: { mustFix: 0, shouldFix: 1, nit: 0 },
        chatHeader: "should-fix: 1 | 82%",
        incomplete: INCOMPLETE_FACT,
      },
    };
    parentYields = [payload];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(parentYieldValidator().validate(payload).success).toBe(true);
    expect(envelope.tally?.band).toBe("good");
    expect(envelope.tally?.incomplete).toEqual(INCOMPLETE_FACT);
  });

  test("a three-token envelope is unchanged and the schema stays closed", async () => {
    const payload = deepEnvelope();
    parentYields = [payload];

    const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);
    const validator = parentYieldValidator();

    expect(validator.validate(payload).success).toBe(true);
    expect(envelope.verdict).toBe("needs fixes");
    expect(envelope.incomplete).toBeUndefined();
    expect(validator.validate({ ...(payload as Record<string, unknown>), stray: true }).success).toBe(false);
    expect(
      validator.validate({
        ...(payload as Record<string, unknown>),
        tally: {
          verdict: "needs fixes",
          scorePct: 82,
          band: "great",
          tally: { mustFix: 0, shouldFix: 1, nit: 0 },
          chatHeader: "h",
        },
      }).success,
    ).toBe(false);
  });
});

describe("ompAgentRuntime.runReview — envelope", () => {
  test("merges, dedupes, synthesizes and validates the mstar.review/v1 envelope", async () => {
    seatResults = [
      {
        data: seatPayload(),
      },
      {
        data: {
          findings: [
            {
              mergeClass: "should-fix",
              title: "Missing null check",
              body: "b",
              file_path: "lib/c.ts",
              line_start: 4,
              fingerprint_hint: "fp-lib",
            },
            {
              mergeClass: "must-fix",
              title: "Unbounded loop",
              body: "duplicate",
              file_path: "src/a.ts",
              line_start: 10,
            },
          ],
        },
      },
    ];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("blocked");
    expect(envelope.findings).toHaveLength(2);
    expect(envelope.findings.map((finding) => finding.title).sort()).toEqual([
      "Missing null check",
      "Unbounded loop",
    ]);
    expect(envelope.tally?.tally).toEqual({ mustFix: 1, shouldFix: 1, mayFix: 0, nit: 0 });
    expect(envelope.target).toEqual({
      owner: "acme",
      repo: "widgets",
      pr: 7,
      head_sha: "abc1234567890abcdef1234567890abcdef12",
    });
  });
});
describe("ompAgentRuntime.runReview — per-review agentDir threading (AL-23-1; capability-host threading)", () => {
  test("quick/default: input.agentDir flows into createAgentSession options verbatim", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", agentDir: "/tmp/omp-agent-abc" });

    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]!.agentDir).toBe("/tmp/omp-agent-abc");
    expect(createdOptions[0]!.cwd).toBe(TEST_WORKTREE);
    expect(createdOptions[0]!.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...BASE_INPUT.modelSelectors] },
      },
    });
  });

  test("deep: input.agentDir flows into createAgentSession options verbatim", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, agentDir: "/tmp/omp-agent-deep-7" });

    expect(createdOptions[0]!.agentDir).toBe("/tmp/omp-agent-deep-7");
    expect(createdOptions[0]!.toolNames).toEqual(["read", "grep", "glob", "task"]);
  });

  test("agentDir is REQUIRED on every path — the options always carry it (no baked models.yml fallback)", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    expect(createdOptions[0]!.agentDir).toBe(AGENT_DIR);

    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);
    expect(createdOptions[0]!.agentDir).toBe(AGENT_DIR);
  });

  test("input.authStorage reaches the session options on EVERY path — no discoverAuthStorage fallback", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]!.authStorage).toBe(TEST_AUTH_STORAGE);

    createdOptions.length = 0;
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]!.authStorage).toBe(TEST_AUTH_STORAGE);
  });

  test("a distinct instance is passed through verbatim, never a re-created store", async () => {
    const other = { close: () => {}, kind: "other-store" } as never;
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", authStorage: other });
    expect(createdOptions[0]!.authStorage).toBe(other);
    expect(createdOptions[0]!.authStorage).not.toBe(TEST_AUTH_STORAGE);
  });
});

const RECHECK_SHA = "0123456789abcdef0123456789abcdef01234567";

function recheckInput(overrides: Partial<RecheckInput> = {}): RecheckInput {
  return {
    schema: "mstar.recheck-input/v1",
    headSha: RECHECK_SHA,
    targets: [
      {
        rowId: "row-1",
        findingId: "f-1",
        original: {
          title: "Unbounded recursion",
          body: "The reaper recurses without a depth bound.",
          filePath: "src/reaper.ts",
          lineStart: 8,
          lineEnd: 10,
          mergeClass: "must-fix",
          category: "logic",
          fingerprintHint: "fp-reaper",
        },
        firstSeenSha: RECHECK_SHA,
        lastAssessment: null,
        associationIds: ["assoc-1"],
      },
    ],
    evidence: [
      {
        id: "slice-1",
        headSha: RECHECK_SHA,
        baseSha: "b000000000000000000000000000000000000000",
        path: "src/reaper.ts",
        oldPath: null,
        kind: "hunk",
        oldStart: 8,
        oldLines: ["const a = 1;", "const b = 2;", "const c = 3;"],
        newStart: 8,
        newLines: ["const a = 1;", "const b = null ?? 2;", "const c = 3;"],
        addedNewLines: [9],
        oldBlobOid: "oid-old",
        headBlobOid: "oid-head",
        absentAtHead: false,
        complete: true,
      },
    ],
    discussion: { items: [], issueCoverage: "complete", issueModelCoverage: "complete", issueDigest: "d", capturedMs: 1, threads: [] },
    ...overrides,
  };
}

function validRecheckDoc(): RecheckDoc {
  return {
    schema: "mstar.recheck/v1",
    headSha: RECHECK_SHA,
    results: [
      { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
    ],
  };
}

function staleRecheckDoc(): RecheckDoc {
  return { ...validRecheckDoc(), headSha: "ffffffffffffffffffffffffffffffffffffffff" };
}

describe("ompAgentRuntime.runReview — recheck seat (spec §7.8)", () => {
  beforeEach(() => {
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
  });

  afterEach(() => {
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
  });

  test("quick/default: the recheck child runs concurrently on the SAME read-only ToolSession", async () => {
    seatResults = [{ data: validRecheckDoc() }, { data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    const { envelope, recheck } = await ompAgentRuntime.runReview({ ...BASE_INPUT, recheck: recheckInput() });

    expect(recheck).toEqual(validRecheckDoc());
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("blocked");

    expect(subagentRequests).toHaveLength(3);
    const request = subagentRequests[0]!;
    expect(request.agent).toBe("mstar-review-seat");
    expect((request.session as { cwd: unknown }).cwd).toBe(TEST_WORKTREE);
    expect(request.outputSchema).toBe(RECHECK_OUTPUT_SCHEMA);
    expect(request.schemaMode).toBe("strict");
    expect(request.enableLsp).toBe(false);
    expect(request.enableIrc).toBe(false);
    expect(request.maxRuntimeMs).toBe(PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes * 60_000);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.model).toEqual([...BASE_INPUT.modelSelectors]);
    const assignment = request.assignment as string;
    expect(assignment).toContain("mstar.recheck-input/v1");
    expect(assignment).toContain(RECHECK_SHA);
    expect(assignment).toContain("The reaper recurses without a depth bound.");
    expect(assignment).toContain("UNTRUSTED");
    expect(assignment).toContain("mstar.recheck/v1");
    expect(subagentRequests[1]!.assignment).toContain("changeset-1-src");
    expect(subagentRequests[2]!.assignment).toContain("changeset-2-lib");
  });

  test("invalid recheck payload → recheck null + failed status (invalid-document); the envelope is untouched", async () => {
    seatResults = [{ data: staleRecheckDoc() }, { data: seatPayload() }];
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });
    } finally {
      spy.mockRestore();
    }
    expect(result.recheck).toBeNull();
    expect(result.envelope.schema).toBe("mstar.review/v1");
    expect(result.envelope.verdict).toBe("blocked");
    expect(result.recheckStatus).toEqual({
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_SHA,
      outcome: "failed",
      reason: "invalid-document",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: expect.stringContaining("stale document"),
    });
    const logged = errorCalls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("recheck_seat_failed");
    expect(logged).toContain("stale document");
  });

  test("exhausted budget → the seat is skipped entirely (no child started), status reason budget", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "quick", Date.now());
    seatResults = [{ data: seatPayload() }];
    const { recheck, recheckStatus } = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      recheck: recheckInput(),
    });

    expect(recheck).toBeNull();
    expect(recheckStatus).toEqual({
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_SHA,
      outcome: "skipped",
      reason: "budget",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: "recheck seat skipped (tail): the review's outer deadline left 0ms, the seat needs at least 90000ms",
    });
    expect(subagentRequests).toHaveLength(1);
    expect(subagentRequests[0]!.outputSchema).not.toBe(RECHECK_OUTPUT_SCHEMA);
  });

  test("a seat throw → recheck null + failed status (seat-failed) carrying the message", async () => {
    seatResults = [{ reject: "provider boom" }, { data: seatPayload() }];
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });
    } finally {
      spy.mockRestore();
    }

    expect(result.recheck).toBeNull();
    expect(result.recheckStatus?.outcome).toBe("failed");
    expect(result.recheckStatus?.reason).toBe("seat-failed");
    expect(result.recheckStatus?.error).toBe("provider boom");
  });

  test("a review that settles early lets the in-flight recheck finish and returns its document", async () => {
    holdSeats = true;
    const dispatched = [deferred(), deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ data: validRecheckDoc() }, { data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview({ ...BASE_INPUT, recheck: recheckInput() });
    await dispatched[2]!.promise;

    seatReleases[1]!();
    seatReleases[2]!();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();

    const signal = subagentRequests[0]!.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    seatReleases[0]!();
    const { recheck, recheckStatus } = await run;
    expect(recheck).toEqual(validRecheckDoc());
    expect(recheckStatus).toMatchObject({ outcome: "ok", reason: null });
  });

  test("the settle-time gate stays open near the floor: a seat that started is awaited, not aborted", async () => {
    anchorRecheckDeadline(Date.now(), "quick", Date.now() + 100_000);
    holdSeats = true;
    const dispatched = [deferred(), deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ data: validRecheckDoc() }, { data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview({ ...BASE_INPUT, recheck: recheckInput() });
    await dispatched[2]!.promise;
    seatReleases[1]!();
    seatReleases[2]!();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();

    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(false);
    seatReleases[0]!();
    const { recheck } = await run;
    expect(recheck).toEqual(validRecheckDoc());
  });

  test("an exhausted outer budget aborts the still-running recheck instead of blocking the run", async () => {
    holdSeats = true;
    const dispatched = [deferred(), deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ awaitAbort: true }, { data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview({ ...BASE_INPUT, recheck: recheckInput() });
    await dispatched[2]!.promise;

    anchorRecheckDeadline(Date.now() - 600_000, "quick");
    seatReleases[1]!();
    seatReleases[2]!();
    seatReleases[0]!();

    const { recheck, recheckStatus } = await run;
    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(true);
    expect(recheck).toBeNull();
    expect(recheckStatus).toEqual({
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_SHA,
      outcome: "skipped",
      reason: "aborted",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 0,
      error: null,
    });
  });

  test("a seat rejecting with a plain string still resolves failed — never throws out of the catch", async () => {
    seatResults = [{ rejectWith: "provider boom" }, { data: seatPayload() }];
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });
    } finally {
      spy.mockRestore();
    }

    expect(result.recheck).toBeNull();
    expect(result.recheckStatus).toMatchObject({
      outcome: "failed",
      reason: "seat-failed",
      error: "provider boom",
    });
  });

  test("a long secret-bearing seat error is redacted BEFORE it is truncated", async () => {
    const token = `AIza${"B".repeat(40)}`;
    const padding = "x".repeat(RECHECK_STATUS_ERROR_MAX_CHARS - 10);
    seatResults = [{ reject: `${padding} ${token} tail` }, { data: seatPayload() }];
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });
    } finally {
      spy.mockRestore();
    }

    const error = result.recheckStatus?.error ?? "";
    expect(error.length).toBeLessThanOrEqual(RECHECK_STATUS_ERROR_MAX_CHARS);
    expect(error).not.toContain("AIza");
    expect(error).toContain("[REDACT");
  });

  test("row-level drops are counted: when EVERY submitted row is dropped the round is failed/all-rows-rejected", async () => {
    const twoTargets = recheckInput({
      targets: [
        ...recheckInput().targets,
        {
          ...recheckInput().targets[0]!,
          rowId: "row-2",
          findingId: "f-2",
          associationIds: [],
        },
      ],
    });
    const docWithRejectedRows = {
      schema: "mstar.recheck/v1",
      headSha: RECHECK_SHA,
      results: [
        { rowId: "row-1", disposition: "addressed", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        { rowId: "row-2", disposition: "dismissed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
    seatResults = [{ data: docWithRejectedRows }, { data: seatPayload() }];
    const { recheck, recheckStatus } = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      recheck: twoTargets,
    });

    expect(recheck?.results).toEqual([]);
    expect(recheckStatus).toEqual({
      schema: "mstar.recheck-status/v1",
      headSha: RECHECK_SHA,
      outcome: "failed",
      rejected: 2,
      rejected_row_ids: ["row-1", "row-2"],
      rejected_unnamed: 0,
      reason: "all-rows-rejected",
      error: null,
    });
  });

  test("a partial drop keeps the round ok: surviving rows still make it a usable document", async () => {
    const twoTargets = recheckInput({
      targets: [
        ...recheckInput().targets,
        {
          ...recheckInput().targets[0]!,
          rowId: "row-2",
          findingId: "f-2",
          associationIds: [],
        },
      ],
    });
    const docWithOneRejectedRow = {
      schema: "mstar.recheck/v1",
      headSha: RECHECK_SHA,
      results: [
        { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        { rowId: "row-2", disposition: "dismissed", reason: "verified-fix", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
    seatResults = [{ data: docWithOneRejectedRow }, { data: seatPayload() }];
    const { recheckStatus } = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      recheck: twoTargets,
    });

    expect(recheckStatus).toMatchObject({
      outcome: "ok",
      reason: null,
      rejected: 1,
      rejected_row_ids: ["row-2"],
      rejected_unnamed: 0,
    });
  });

  test("a nameless row drop is counted in `rejected_unnamed`, and `rejected` stays the named count", async () => {
    const twoTargets = recheckInput({
      targets: [
        ...recheckInput().targets,
        {
          ...recheckInput().targets[0]!,
          rowId: "row-2",
          findingId: "f-2",
          associationIds: [],
        },
      ],
    });
    const docWithNamelessDrop = {
      schema: "mstar.recheck/v1",
      headSha: RECHECK_SHA,
      results: [
        { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
        { rowId: "", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
    seatResults = [{ data: docWithNamelessDrop }, { data: seatPayload() }];
    const { recheckStatus } = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      recheck: twoTargets,
    });

    expect(recheckStatus).toMatchObject({
      outcome: "ok",
      rejected: 0,
      rejected_row_ids: [],
      rejected_unnamed: 1,
    });
  });

  test("legacy input (no recheck document) → no status at all", async () => {
    seatResults = [{ data: seatPayload() }];
    const result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    expect(result.recheck).toBeNull();
    expect("recheckStatus" in result).toBe(false);
  });

  test("a review failure aborts the recheck child and still rejects (never lose the review)", async () => {
    seatResults = [{ data: validRecheckDoc() }, { data: seatPayload() }, { error: "provider boom" }];
    await expect(
      ompAgentRuntime.runReview({ ...BASE_INPUT, level: "default", recheck: recheckInput() }),
    ).rejects.toThrow(/provider boom/);

    expect(subagentRequests).toHaveLength(3);
    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(true);
    // The review seats carry their own watchdog signals — never the recheck's.
    expect((subagentRequests[1]!.signal as AbortSignal).aborted).toBe(false);
    expect((subagentRequests[2]!.signal as AbortSignal).aborted).toBe(false);
  });

  test("deep: the recheck seat runs on a DEDICATED read-only session, not the parent's yield stream", async () => {
    parentYields = [deepEnvelope()];
    seatResults = [{ data: validRecheckDoc() }];
    const { envelope, recheck } = await ompAgentRuntime.runReview({ ...DEEP_INPUT, recheck: recheckInput() });

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.findings[0]!.title).toBe("Missing null check");
    expect(recheck).toEqual(validRecheckDoc());

    expect(createdOptions).toHaveLength(2);
    const parent = createdOptions[0]!;
    const recheckSessionOptions = createdOptions[1]!;
    expect(parent.toolNames).toEqual(["read", "grep", "glob", "task"]);
    expect(parent.requireYieldTool).toBe(true);
    expect(recheckSessionOptions.toolNames).toEqual(["read", "grep", "glob"]);
    expect(recheckSessionOptions.requireYieldTool).toBe(false);
    expect(recheckSessionOptions.outputSchema).toBeUndefined();
    expect(recheckSessionOptions.cwd).toBe(TEST_WORKTREE);
    expect(recheckSessionOptions.agentDir).toBe(AGENT_DIR);
    expect(parent.authStorage).toBe(TEST_AUTH_STORAGE);
    expect(recheckSessionOptions.authStorage).toBe(TEST_AUTH_STORAGE);

    expect(subagentRequests).toHaveLength(1);
    expect(subagentRequests[0]!.outputSchema).toBe(RECHECK_OUTPUT_SCHEMA);
    expect(subagentRequests[0]!.assignment).not.toContain("Fixture marker");
    expect(promptTexts).toHaveLength(1);

    expect(installedAgentFiles).toEqual([
      "code-reviewer.md",
      "frontend-dev.md",
      "fullstack-dev.md",
      "mstar-review-seat.md",
    ]);
    expect(disposeCalls).toBe(2);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
  });

  test("deep: a parent-turn failure aborts the recheck child and still rejects", async () => {
    parentPromptThrow = "model provider exploded before any yield";
    seatResults = [{ data: validRecheckDoc() }];
    await expect(
      ompAgentRuntime.runReview({ ...DEEP_INPUT, recheck: recheckInput() }),
    ).rejects.toThrow("model provider exploded before any yield");

    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(true);
    expect(disposeCalls).toBe(2);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
  });
});

describe("ompAgentRuntime.runReview — every seat is visible in the trace", () => {
  const CAP = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
  const PR_CTX = { prBody: "Closes #7", issues: [{ number: 7, title: "Guard", body: "- reject expired tokens" }] };

  /** Capture the trace lines a run writes; returns them in emission order. */
  async function capturedTrace(run: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      for (const arg of args) if (typeof arg === "string") lines.push(arg);
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines
      .filter((line) => line.includes('"event":"review_stage"'))
      .map((line) => (JSON.parse(line) as { stage: string }).stage);
  }

  test("the stage builders name the seat, the stop reason and the turn count", () => {
    expect(seatStartStage("1-changeset-1-src")).toBe("seat_start:1-changeset-1-src");
    expect(seatDoneStage("1-changeset-1-src", 3)).toBe("seat_done:1-changeset-1-src:turns=3");
    expect(seatDoneStage("1-deep-parent", undefined)).toBe("seat_done:1-deep-parent");
    expect(seatGapStage("2-changeset-2-lib", CAP)).toBe("seat_gap:2-changeset-2-lib:cap:540000ms");
    expect(seatGapStage("2-changeset-2-lib", CAP, 7)).toBe("seat_gap:2-changeset-2-lib:cap:540000ms:turns=7");
    expect(seatGapStage("2-changeset-2-lib", "Provider stream closed unexpectedly")).toBe(
      "seat_gap:2-changeset-2-lib:Provider-str",
    );
    expect(seatFailedStage("1-changeset-1-src", "provider exploded")).toBe(
      "seat_failed:1-changeset-1-src:provider-exp",
    );
    expect(recheckStage({ doc: null, status: { outcome: "skipped", reason: "budget" } })).toBe(
      "recheck_gap:skipped-budget",
    );
    expect(recheckStage({ doc: {}, status: { outcome: "applied" }, usage: { requests: 4 } })).toBe(
      "recheck_done:turns=4",
    );
    expect(reportStage(null, undefined)).toBe("report_absent");
    expect(reportStage({}, 2)).toBe("report_done:turns=2");
    expect(reportSkipStage("no-pr-context")).toBe("report_skip:no-pr-context");
    expect(reportFailedStage("report boom")).toBe("report_failed:report-boom");
  });

  test("a long seat label keeps the reason and turn count inside the worker's 60-char field", () => {
    // 48-char labels are the reported overflow: `changeset-1-<label>` alone
    // already exceeded the field, dropping `:cap:…` / `:turns=…`.
    const longId = `changeset-1-${"verylongsegment-".repeat(4)}`;
    expect(longId.length).toBeGreaterThan(48);
    const traceId = seatTraceId(1, longId);
    expect(traceId.length).toBeLessThanOrEqual(24);
    const gap = seatGapStage(traceId, CAP, 1234);
    const done = seatDoneStage(traceId, 1234);
    expect(gap).toContain(":cap:540000ms");
    expect(gap).toContain(":turns=1234");
    expect(done).toContain(":turns=1234");
    expect(gap.length).toBeLessThanOrEqual(60);
    expect(done.length).toBeLessThanOrEqual(60);
  });

  test("a failing wave ends on the seat's gap stage, naming the seat and the cap reason", async () => {
    const trace = await capturedTrace(async () => {
      seatResults = [
        { status: "absent", aborted: true, abortReason: CAP },
        { status: "absent", aborted: true, abortReason: CAP },
      ];
      await ompAgentRuntime.runReview(BASE_INPUT).catch(() => undefined);
    });

    expect(trace).toContain("seat_start:1-changeset-1-src");
    expect(trace).toContain("seat_start:2-changeset-2-lib");
    expect(trace).toContain("seat_gap:1-changeset-1-src:cap:540000ms:turns=0");
    expect(trace).toContain("seat_gap:2-changeset-2-lib:cap:540000ms:turns=0");
    // The LAST stage the worker would print names a real seat stop.
    expect(trace.at(-1)).toMatch(/^seat_gap:[12]-changeset-[12]-(src|lib):cap:540000ms:turns=0$/);
  });

  test("a fulfilled seat carrying a provider error is traced as failed, never done", async () => {
    const trace = await capturedTrace(async () => {
      seatResults = [{ error: "provider exploded" }, { requests: 4, data: seatPayload() }];
      await ompAgentRuntime.runReview(BASE_INPUT).catch(() => undefined);
    });

    expect(trace.filter((stage) => stage.startsWith("seat_failed:"))).toHaveLength(1);
    expect(trace).toContain("seat_failed:1-changeset-1-src:provider-exp");
    expect(trace).toContain("seat_done:2-changeset-2-lib:turns=4");
    expect(trace.some((stage) => stage.startsWith("seat_done:1-"))).toBe(false);
  });

  test("a full success emits start and done with each seat's turn count", async () => {
    const trace = await capturedTrace(async () => {
      seatResults = [
        { requests: 3, data: seatPayload() },
        { requests: 5, data: seatPayload({ findings: [] }) },
      ];
      await ompAgentRuntime.runReview(BASE_INPUT).catch(() => undefined);
    });

    expect(trace).toContain("seat_start:1-changeset-1-src");
    expect(trace).toContain("seat_start:2-changeset-2-lib");
    expect(trace).toContain("seat_done:1-changeset-1-src:turns=3");
    expect(trace).toContain("seat_done:2-changeset-2-lib:turns=5");
    // No PR context: the report seat never starts, and the trace says why.
    expect(trace).toContain("report_skip:no-pr-context");
    expect(trace).not.toContain("report_start");
    expect(trace.at(-1)).toBe("report_skip:no-pr-context");
  });

  test("an attempted report seat with no document is absent; an eligible run starts it", async () => {
    const trace = await capturedTrace(async () => {
      seatResults = [
        { data: seatPayload() },
        { data: seatPayload({ findings: [] }) },
        { status: "absent" },
      ];
      await ompAgentRuntime.runReview({ ...BASE_INPUT, prContext: PR_CTX }).catch(() => undefined);
    });

    expect(trace).toContain("report_start");
    expect(trace).toContain("report_absent");
    expect(trace).not.toContain("report_skip:no-pr-context");
  });

  test("the deep parent is traced as the wave's single seat", async () => {
    const trace = await capturedTrace(async () => {
      parentYields = [deepEnvelope()];
      await ompAgentRuntime.runReview(DEEP_INPUT).catch(() => undefined);
    });

    const starts = trace.filter((stage) => stage.startsWith("seat_start:"));
    expect(starts).toHaveLength(1);
    const id = starts[0]!.slice("seat_start:".length);
    expect(trace).toContain(`seat_done:${id}`);
  });

  test("the seat ceiling is the runner's tier maximum for quick, not the engine's shorter wall clock", () => {
    const turn = Date.now();
    anchorRecheckDeadline(turn, "quick", turn + 3_600_000);
    const window = seatDeadlineMs(turn, turn, "quick") - turn;
    expect(window).toBe(RUNNER_MAX_BUDGET_MS.quick);
    // The engine table would give 300 s; that is the regression this pins.
    expect(window).not.toBe(PR_REVIEW_TIER_BUDGETS.quick.wallClockMinutes * 60_000);
    expect(window).toBeGreaterThan(PR_REVIEW_TIER_BUDGETS.quick.wallClockMinutes * 60_000);
    // default is unchanged (both sources agree) and deep keeps its ×2 headroom.
    anchorRecheckDeadline(turn, "default", turn + 3_600_000);
    expect(seatDeadlineMs(turn, turn, "default") - turn).toBe(RUNNER_MAX_BUDGET_MS.default);
    anchorRecheckDeadline(turn, "deep", turn + 3_600_000);
    expect(seatDeadlineMs(turn, turn, "deep") - turn).toBe(RUNNER_MAX_BUDGET_MS.deep * 2);
  });

  test("a delivered cap stop with no time left skips the report seat and never claims a start", async () => {
    // The round delivers (one completed seat), but its deadline is already
    // inside the report seat's publication margin: the seat cannot run.
    const CAP = "Subagent runtime limit exceeded (task.maxRuntimeMs=480000)";
    anchorRecheckDeadline(Date.now(), "default", Date.now() + 1_000);
    const trace = await capturedTrace(async () => {
      seatResults = [
        { status: "absent", aborted: true, abortReason: CAP },
        { data: seatPayload() },
      ];
      await ompAgentRuntime.runReview({ ...BASE_INPUT, prContext: PR_CTX });
    });

    expect(trace).toContain("report_skip:budget-exhausted");
    expect(trace).not.toContain("report_start");
  });

  test("a rejected report call is a failure, never a silent absent document", async () => {
    const trace = await capturedTrace(async () => {
      seatResults = [
        { data: seatPayload() },
        { data: seatPayload({ findings: [] }) },
        { rejectWith: new Error("report boom") },
      ];
      const result = await ompAgentRuntime.runReview({ ...BASE_INPUT, prContext: PR_CTX });
      // The review is never failed by its report (narrative only).
      expect(result.report).toBeNull();
      expect(result.envelope.verdict).toBe("blocked");
    });

    expect(trace).toContain("report_start");
    expect(trace).toContain("report_failed:report-boom");
    expect(trace).not.toContain("report_absent");
  });

  test("a torn-down run is ineligible for the report seat, with the reason named", () => {
    const envelope = synthesizeReview({
      findings: [],
      target: { owner: "acme", repo: "widgets", pr: 7, head_sha: HEAD_SHA },
    });
    const controller = new AbortController();
    controller.abort();
    anchorRecheckDeadline(Date.now(), "default", Date.now() + 3_600_000);
    const verdict = reportEligibility({ ...BASE_INPUT, prContext: PR_CTX }, envelope, controller.signal);
    expect(verdict).toEqual({ ok: false, reason: "aborted" });
  });

  test("the first-turn signal is the assistant request count, never the running label", () => {
    expect(startsFirstTurn({ status: "running", requests: 0 })).toBe(false);
    expect(startsFirstTurn({ status: "pending", requests: 5 })).toBe(false);
    expect(startsFirstTurn({ status: "running", requests: 1 })).toBe(true);
    expect(startsFirstTurn({ status: "running" })).toBe(false);
  });
});

describe("ompAgentRuntime.runReview — report seat (mstar.report/v1)", () => {
  const REPORT = {
    schema: "mstar.report/v1" as const,
    overview: "Adds an expiry guard.",
    linkedIssueAc: "none",
    verified: "none",
    rejected: "none",
    planToFix: "none",
  };
  const BOUND_REPORT: ReportDoc = { ...REPORT, headSha: HEAD_SHA };
  const PR_CONTEXT = {
    prBody: "Closes #7",
    issues: [{ number: 7, title: "Guard", body: "- reject expired tokens" }],
  };

  test("quick/default: a report seat runs SERIALLY after the settled review and its document rides the result", async () => {
    seatResults = [{ data: seatPayload() }, { data: REPORT }];
    const result = await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      prContext: PR_CONTEXT,
    });

    expect(result.report).toEqual(BOUND_REPORT);
    expect(result.envelope.verdict).toBe("blocked");
    expect(subagentRequests).toHaveLength(2);
    const request = subagentRequests[1]!;
    expect(request.outputSchema).toBe(REPORT_OUTPUT_SCHEMA);
    expect(request.schemaMode).toBe("strict");
    const assignment = request.assignment as string;
    expect(assignment).toContain('"schema":"mstar.review/v1"');
    expect(assignment).toContain('"verdict":"blocked"');
    expect(assignment).toContain("Closes #7");
    expect(assignment).toContain("reject expired tokens");
    expect(assignment).toContain("mstar.report/v1");
    expect(request.model).toEqual([...BASE_INPUT.modelSelectors]);
    const hostSessionManager = (request.session as { sessionManager: unknown }).sessionManager;
    expect(hostSessionManager).toBe(createdOptions[0]!.sessionManager);
  });

  test("without prContext no report seat is dispatched and the result is null", async () => {
    seatResults = [{ data: seatPayload() }];
    const result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    expect(result.report).toBeNull();
    expect(subagentRequests).toHaveLength(1);
  });

  test("a failed report seat resolves null — the review is untouched", async () => {
    seatResults = [{ data: seatPayload() }, { error: "model unavailable" }];
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", prContext: PR_CONTEXT });
    } finally {
      spy.mockRestore();
    }
    expect(result.report).toBeNull();
    expect(result.envelope.schema).toBe("mstar.review/v1");
    expect(result.envelope.verdict).toBe("blocked");
  });

  test("a report document that fails its own gate resolves null", async () => {
    seatResults = [
      { data: seatPayload() },
      { data: { ...REPORT, overview: "   " } },
    ];
    const spy = spyOn(console, "error").mockImplementation(() => {});
    let result: ReviewRunResult;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", prContext: PR_CONTEXT });
    } finally {
      spy.mockRestore();
    }
    expect(result.report).toBeNull();
  });

  test("deep: the report seat runs on its OWN session after the parent turn and the recheck seat settled", async () => {
    parentYields = [deepEnvelope()];
    seatResults = [{ data: REPORT }];
    const result = await ompAgentRuntime.runReview({ ...DEEP_INPUT, prContext: PR_CONTEXT });

    expect(result.envelope.schema).toBe("mstar.review/v1");
    expect(result.envelope.verdict).toBe("needs fixes");
    expect(result.report).toEqual(BOUND_REPORT);
    expect(subagentRequests).toHaveLength(1);

    expect(createdOptions).toHaveLength(2);
    const seatSessionManager = (subagentRequests[0]!.session as { sessionManager: unknown }).sessionManager;
    expect(seatSessionManager).toBe(createdOptions[1]!.sessionManager);
    expect(seatSessionManager).not.toBe(createdOptions[0]!.sessionManager);
    expect(createdOptions[1]!.toolNames).toEqual(["read", "grep", "glob"]);
    expect(createdOptions[1]!.requireYieldTool).toBe(false);
    expect(disposeCalls).toBe(2);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(false);
  });

  for (const [name, input] of [
    ["quick/default", { ...BASE_INPUT, level: "quick" as const }],
    ["deep", DEEP_INPUT],
  ] as const) {
    test(`${name}: a caller abort under the report seat is a cancellation — null, never a throw`, async () => {
      if (input.level === "deep") parentYields = [deepEnvelope()];
      const dispatch = deferred();
      seatDispatchQueue = input.level === "deep" ? [dispatch.resolve] : [() => {}, dispatch.resolve];
      seatResults =
        input.level === "deep" ? [{ awaitAbort: true }] : [{ data: seatPayload() }, { awaitAbort: true }];
      const controller = new AbortController();
      const errors: string[] = [];
      const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.join(" "));
      });
      let result: ReviewRunResult;
      try {
        const run = ompAgentRuntime.runReview({ ...input, prContext: PR_CONTEXT, signal: controller.signal });
        await dispatch.promise;
        controller.abort();
        result = await run;
      } finally {
        spy.mockRestore();
      }
      expect(result.report).toBeNull();
      expect(result.envelope.schema).toBe("mstar.review/v1");
      // Started, then cancelled: neither "absent" nor a failure.
      expect(errors.filter((line) => line.includes('"stage":"report_start"'))).toHaveLength(1);
      expect(errors.filter((line) => line.includes('"stage":"report_aborted"'))).toHaveLength(1);
      expect(errors.filter((line) => line.includes('"stage":"report_absent"'))).toHaveLength(0);
    });
  }

  test("a seat definition missing at dispatch degrades to no report — never a failed review", async () => {
    const clone = mkdtempSync(join(tmpdir(), "omp-review-missing-seat-"));
    const reviewDispatch = deferred();
    holdSeats = true;
    seatDispatchQueue = [reviewDispatch.resolve];
    seatResults = [{ data: seatPayload() }, { data: REPORT }];
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    let result: ReviewRunResult;
    try {
      const run = ompAgentRuntime.runReview({
        ...BASE_INPUT,
        level: "quick",
        worktreePath: clone,
        prContext: PR_CONTEXT,
      });
      await reviewDispatch.promise;
      rmSync(join(clone, ".omp", "agents", "mstar-review-seat.md"));
      seatReleases.shift()!();
      result = await run;
    } finally {
      spy.mockRestore();
      rmSync(clone, { recursive: true, force: true });
    }
    expect(result.report).toBeNull();
    expect(result.envelope.schema).toBe("mstar.review/v1");
    expect(errors.filter((line) => line.includes('"reason":"seat-definition-missing"'))).toHaveLength(1);
    expect(subagentRequests).toHaveLength(1);
  });

  for (const [tier, input] of [
    ["quick", { ...BASE_INPUT, level: "quick" as const }],
    ["default", BASE_INPUT],
    ["deep", DEEP_INPUT],
  ] as const) {
    for (const [name, over, wantsRecheck, wantsReport] of [
      ["recheck only", { recheck: recheckInput() }, true, false],
      ["report only", { prContext: PR_CONTEXT }, false, true],
      ["recheck + report", { recheck: recheckInput(), prContext: PR_CONTEXT }, true, true],
    ] as ReadonlyArray<readonly [string, Partial<AgentRuntimeRunInput>, boolean, boolean]>) {
      test(`${tier}: ${name} installs the seat definition before the session exists`, async () => {
        if (tier === "deep") parentYields = [deepEnvelope()];
        const seatCount = tier === "deep" ? 0 : tier === "quick" ? 1 : 2;
        seatResults = [
          ...(wantsRecheck ? [{ data: validRecheckDoc() }] : []),
          ...Array.from({ length: seatCount }, () => ({ data: seatPayload() })),
          ...(wantsReport ? [{ data: REPORT }] : []),
        ];

        const result = await ompAgentRuntime.runReview({ ...input, ...over });

        expect(installedAgentFiles).toContain("mstar-review-seat.md");
        expect(result.report).toEqual(wantsReport ? BOUND_REPORT : null);
        expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(false);
      });
    }
  }
});

describe("ompAgentRuntime.runReview — seat supervision (progress nudges)", () => {
  const normalTickMs = PR_REVIEW_NUDGE_CADENCE.normalSeconds * 1000;
  const overrunTickMs = PR_REVIEW_NUDGE_CADENCE.overrunSeconds * 1000;

  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  }

  test("one nudge per running seat per engine tick; a returned seat leaves the tick set", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "default");
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    const deliveries: Array<{ id: string; deliverAs: string; text: string }> = [];
    const running = new Set(["a", "b"]);
    const done = deferred();
    const supervision = superviseSeats({
      level: "default",
      done: done.promise,
      seats: ["a", "b"].map((id) => ({
        id,
        isRunning: () => running.has(id),
        deliver: async (nudge) => {
          deliveries.push({ id, ...nudge });
        },
      })),
    });

    jest.advanceTimersByTime(normalTickMs - 1);
    await flush();
    expect(deliveries).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await flush();
    expect(deliveries.map(({ id, deliverAs }) => ({ id, deliverAs }))).toEqual([
      { id: "a", deliverAs: "aside" },
      { id: "b", deliverAs: "aside" },
    ]);
    expect(deliveries[0]!.text).toContain(`${cap - PR_REVIEW_NUDGE_CADENCE.normalSeconds / 60} min left`);

    running.delete("a");
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(deliveries.slice(2).map(({ id }) => id)).toEqual(["b"]);

    done.resolve();
    await supervision;
    jest.advanceTimersByTime(normalTickMs * 3);
    await flush();
    expect(deliveries).toHaveLength(3);
  });

  test("past the soft cap the tick shortens and the nudge hardens to a steer", async () => {
    jest.useFakeTimers();
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    anchorRecheckDeadline(Date.now() - (cap * 60_000 + 60_000), "default");
    const deliveries: Array<{ deliverAs: string; text: string }> = [];
    const done = deferred();
    const supervision = superviseSeats({
      level: "default",
      done: done.promise,
      seats: [
        {
          id: "a",
          isRunning: () => true,
          deliver: async (nudge) => {
            deliveries.push({ ...nudge });
          },
        },
      ],
    });

    jest.advanceTimersByTime(overrunTickMs - 1);
    await flush();
    expect(deliveries).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await flush();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.deliverAs).toBe("steer");
    expect(deliveries[0]!.text).toMatch(/min over/i);

    jest.advanceTimersByTime(overrunTickMs);
    await flush();
    expect(deliveries).toHaveLength(2);

    done.resolve();
    await supervision;
  });

  test("quick/default: a running seat is nudged through its live registry session", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "default");
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    registerSeat("changeset-1-src");
    registerSeat("changeset-2-lib");
    holdSeats = true;
    const dispatched = [deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview(BASE_INPUT);
    await dispatched[1]!.promise;

    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.map(({ id, deliverAs }) => ({ id, deliverAs }))).toEqual([
      { id: "changeset-1-src", deliverAs: "aside" },
      { id: "changeset-2-lib", deliverAs: "aside" },
    ]);
    expect(nudgeCalls[0]!.text).toContain(`${cap - PR_REVIEW_NUDGE_CADENCE.normalSeconds / 60} min left`);

    seatReleases.shift()!();
    await flush();
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.slice(2).map(({ id }) => id)).toEqual(["changeset-2-lib"]);

    seatReleases.shift()!();
    const { envelope } = await run;
    expect(envelope.schema).toBe("mstar.review/v1");
    jest.advanceTimersByTime(normalTickMs * 3);
    await flush();
    expect(nudgeCalls).toHaveLength(3);
  });

  test("a failed seat cannot cut its siblings' supervision short (all-settled barrier)", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "default");
    registerSeat("changeset-1-src");
    registerSeat("changeset-2-lib");
    holdSeats = true;
    const dispatched = [deferred(), deferred()];
    seatDispatchQueue = dispatched.map((entry) => entry.resolve);
    seatResults = [{ error: "provider boom" }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview(BASE_INPUT);
    const outcome = run.then(
      () => null,
      (error: unknown) => error,
    );
    await dispatched[1]!.promise;

    seatReleases.shift()!();
    await flush();
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.map(({ id }) => id)).toEqual(["changeset-2-lib"]);
    expect(disposeCalls).toBe(0);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(true);

    seatReleases.shift()!();
    expect(String(await outcome)).toMatch(/review seat 0 .*failed: provider boom/);
    expect(disposeCalls).toBe(1);
    jest.advanceTimersByTime(normalTickMs * 3);
    await flush();
    expect(nudgeCalls.map(({ id }) => id)).toEqual(["changeset-2-lib"]);
  });

  test("deep: the running parent turn is nudged aside inside the cap, steered past it, then left alone", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "deep", Date.now() + 3_600_000);
    const cap = PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes;
    const started = deferred();
    const release = deferred();
    parentPromptStarted = started.resolve;
    parentPromptRelease = release.promise;
    parentYields = [deepEnvelope()];

    const run = ompAgentRuntime.runReview(DEEP_INPUT);
    await started.promise;

    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.map(({ id, deliverAs }) => ({ id, deliverAs }))).toEqual([
      { id: PARENT_SESSION_ID, deliverAs: "aside" },
    ]);
    expect(nudgeCalls[0]!.text).toContain(`${cap - PR_REVIEW_NUDGE_CADENCE.normalSeconds / 60} min left`);

    jest.advanceTimersByTime(cap * 60_000);
    await flush();
    expect(nudgeCalls).toHaveLength(2);
    expect(nudgeCalls[1]!.deliverAs).toBe("steer");
    expect(nudgeCalls[1]!.text).toMatch(/min over/i);

    release.resolve();
    const { envelope } = await run;
    expect(envelope.schema).toBe("mstar.review/v1");
    jest.advanceTimersByTime(cap * 60_000);
    await flush();
    expect(nudgeCalls).toHaveLength(2);
  });

  test("deep: a session with no turn in flight is never messaged (a returned seat is not restarted)", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "deep");
    const started = deferred();
    const release = deferred();
    parentPromptStarted = started.resolve;
    parentPromptRelease = release.promise;
    parentStreaming = false;
    parentYields = [deepEnvelope()];

    const run = ompAgentRuntime.runReview(DEEP_INPUT);
    await started.promise;
    jest.advanceTimersByTime(normalTickMs * 2);
    await flush();
    expect(nudgeCalls).toHaveLength(0);

    release.resolve();
    await run;
  });
});

describe("servedModel — the single applied-model rule", () => {
  test("servingModel wins over the configured model, and its modelIdentity is used verbatim", () => {
    expect(
      servedModel({
        model: { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
        servingModel: { modelIdentity: "opencode-go/deepseek-v4.1-flash", selector: "opencode-go/deepseek-v4.1-flash" },
      }),
    ).toBe("opencode-go/deepseek-v4.1-flash");
  });

  test("a session with no served turn falls back to its configured model", () => {
    expect(servedModel({ model: { provider: "arks", id: "m1" } })).toBe("arks/m1");
  });

  test("a session that never selected a model is ABSENT, not a guess", () => {
    expect(servedModel(undefined)).toBeUndefined();
    expect(servedModel(null)).toBeUndefined();
    expect(servedModel({})).toBeUndefined();
  });
});
