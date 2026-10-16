/**
 * Unit tests for the omp AgentRuntime adapter.
 *
 * Both omp SDK surfaces are mocked (same technique as the former
 * session.test.ts): the root entry (createAgentSession / SessionManager /
 * Settings / loadSkillsFromDir) and the `/task/structured-subagent` subpath
 * (runStructuredSubagent) — so the tests are deterministic. Contracts under
 * test:
 *   - parent session isolation: fetch.enabled=false, restrictToolNames +
 *     read/grep/glob, additionalExtensionPaths=[fixture root], explicit
 *     skills, retry fallback chain — and NO appendSystemPrompt;
 *   - the session cwd IS input.worktreePath (never a throwaway temp dir):
 *     seat-agent.md is installed into the PR clone at
 *     .omp/agents/mstar-review-seat.md (name/tools frontmatter, no spawns)
 *     and removed again when the run ends;
 *   - quick → 1 seat, default → 2 seats, Promise.all fan-out, agent
 *     "mstar-review-seat", strict schema, model = selector chain (default pattern when the chain is empty);
 *   - seat assignment is engine prReviewSeatPrompt output (zero harness
 *     copies here) carrying the worktree path and the seat file scope;
 *   - strict seat output → merge → synthesizeReview → validateMstarReviewV1
 *     envelope; any failure throws (never an M1-shaped success);
 * - level "deep" drives the parent-session path: the
 *     parent session (cwd = worktreePath, read/grep/glob + `task`, strict
 *     output schema) is prompted once, the harness review command is loaded
 *     from the plugin-root fixture at runtime, the deep seat roles are
 *     installed into <worktree>/.omp/agents/ as OMP-native read-only seat
 *     definitions (bodies from the fixture, `tools: [read, grep, glob]`
 *     frontmatter) for the run and removed after, the LAST successful yield
 *     is re-validated against the engine vocab, and
 *     partitionSeats/runStructuredSubagent are never called — quick/default
 *     keep the Bun fan-out untouched;
 *   - a non-delivered level is rejected at the port;
 * - per-role model overrides: quick/default applies the
 *     `mstar-review-seat` override at the seatModels synthesis (explicit
 *     model replaces the global chain verbatim; NO settings key), deep writes
 *     the map into the isolated settings as `task.agentModelOverrides` with
 *     exact agent names; absent/empty map = today's options byte-for-byte.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { PR_REVIEW_NUDGE_CADENCE, PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";

import type { AgentRuntime, ReviewLevel } from "../../src/review/runtime";
import type { SupervisedSeat } from "../../src/review/runtime-omp";
import { anchorRecheckDeadline, RECHECK_OUTPUT_SCHEMA, remainingOuterMs, remainingSoftMinutes } from "../../src/review/recheck";
import type { RecheckDoc, RecheckInput } from "../../src/contracts/recheck";
import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";

/**
 * Real temp dir standing in for the PR clone: installSeatAgent performs real
 * writes under <worktree>/.omp/agents/, and the cwd regression assertions
 * compare against this exact path.
 */
const TEST_WORKTREE = mkdtempSync(join(tmpdir(), "omp-review-worktree-"));

afterAll(() => {
  rmSync(TEST_WORKTREE, { recursive: true, force: true });
});

/** Captured createAgentSession options (one entry per runReview call). */
const createdOptions: Record<string, unknown>[] = [];
/** Scripted per-seat settlements in dispatch order; `aborted` models a seat a cap stopped. */
let seatResults: Array<{
  error?: string;
  status?: string;
  data?: unknown;
  stderr?: string;
  aborted?: boolean;
  abortReason?: string;
}> = [];
/** Definition content snapshotted from the PR-clone cwd at session creation. */
let installedSeatAgent: string | null = null;
/** Agents-dir listing snapshotted from the PR-clone cwd at session creation. */
let installedAgentFiles: string[] | null = null;
/** Per-file contents of the installed deep seat definitions, snapshotted at session creation. */
let installedSeatDefs: Record<string, string> | null = null;
/** GH_TOKEN/GITHUB_TOKEN seen in process.env at session creation (must be stripped on deep). */
let ghTokenAtCreation: string | undefined;
let githubTokenAtCreation: string | undefined;
/** Count of fake session.dispose() calls since the last createAgentSession. */
let disposeCalls = 0;
/** Captured runStructuredSubagent requests, in dispatch order. */
const subagentRequests: Record<string, unknown>[] = [];
/** Reserved identity id per seat dispatch, in dispatch order (`undefined` = none passed). */
const reservedSeatIds: Array<string | undefined> = [];
/** Captured parent-session prompt texts (deep path, in call order). */
const promptTexts: string[] = [];
/** Structured yield payloads / errors the fake parent emits to its subscriber during prompt. */
let parentYields: unknown[] = [];
let parentYieldErrors: string[] = [];
/** Yield attempts the SDK rejects (tool_execution_end with isError) before a later success. */
let parentRejectedYields: unknown[] = [];
/** When set, the fake prompt throws this message AFTER emitting the queued yields. */
let parentPromptThrow: string | null = null;
/** Session event listeners registered by the runtime (one per deep run). */
const yieldListeners: Array<(event: unknown) => void> = [];

/** The parent session's registry id (the deep path addresses the turn by it). */
const PARENT_SESSION_ID = "review-parent";

/**
 * Nudges the runtime delivered, in call order: the target id, the delivery
 * strength, and the text. Recorded by the fake seat sessions and the fake
 * parent session — the delivery sequence IS the supervision contract.
 */
const nudgeCalls: Array<{ id: string; deliverAs: string; text: string }> = [];

/** Fake live refs the supervision path resolves a seat's session through, by reserved id. */
const registryRefs = new Map<string, { id: string; status: string; session: unknown }>();

/** Whether the fake parent session reports a turn in flight (`isStreaming`). */
let parentStreaming = true;
/** Called when the parent turn is entered; lets a test drive the clock mid-turn. */
let parentPromptStarted: (() => void) | null = null;
/** When set, the parent turn blocks on it until the test releases the turn. */
let parentPromptRelease: Promise<void> | null = null;
/** When true, every fan-out seat stays running until the test releases it. */
let holdSeats = false;
/** Release resolvers of the held fan-out seats, in dispatch order. */
let seatReleases: Array<() => void> = [];
/** Called once per fan-out dispatch (test barrier: "this seat is running"). */
let seatDispatchQueue: Array<() => void> = [];

/** A promise a test resolves on its own schedule (turn gates, dispatch barriers). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A fake live seat session: it records the nudges the runtime delivers to it. */
function fakeSeatSession(id: string): { isStreaming: boolean } & Record<string, unknown> {
  return {
    isStreaming: true,
    sendUserMessage: mock(async (text: string, options?: { deliverAs?: string }) => {
      nudgeCalls.push({ id, deliverAs: options?.deliverAs ?? "turn", text });
    }),
    steer: mock(async (text: string) => {
      nudgeCalls.push({ id, deliverAs: "steer", text });
    }),
  };
}

/** Address `id` through the fake registry as a seat that is currently running. */
function registerSeat(id: string): { isStreaming: boolean } & Record<string, unknown> {
  const session = fakeSeatSession(id);
  registryRefs.set(id, { id, status: "running", session });
  return session;
}

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  createAgentSession: mock(async (options: Record<string, unknown>) => {
    createdOptions.push(options);
    disposeCalls = 0;
    // The seat agent definition is installed into the PR-clone cwd BEFORE
    // session creation — snapshot it here, the runtime removes it afterwards.
    const installed = join(options.cwd as string, ".omp", "agents", "mstar-review-seat.md");
    installedSeatAgent = existsSync(installed) ? readFileSync(installed, "utf8") : null;
    // Same creation-time snapshots for the deep path: the installed seat
    // definitions (name → content, for the SDK parseAgent assertion) and the
    // GitHub-token strip window.
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
        dispose: mock(async () => {
          disposeCalls += 1;
        }),
        // Nudge surface the supervision path uses on the deep parent: recorded
        // exactly as the runtime delivers it, and honest about whether a turn is
        // actually in flight.
        get isStreaming() {
          return parentStreaming;
        },
        sendUserMessage: mock(async (text: string, options?: { deliverAs?: string }) => {
          nudgeCalls.push({ id: PARENT_SESSION_ID, deliverAs: options?.deliverAs ?? "turn", text });
        }),
        steer: mock(async (text: string) => {
          nudgeCalls.push({ id: PARENT_SESSION_ID, deliverAs: "steer", text });
        }),
        subscribe: mock((listener: (event: unknown) => void) => {
          yieldListeners.push(listener);
          return () => {};
        }),
        prompt: mock(async (text: string) => {
          promptTexts.push(text);
          // The turn is live: a test can now drive the clock and later release
          // it (no gate → returns as before).
          parentPromptStarted?.();
          if (parentPromptRelease !== null) await parentPromptRelease;
          // The parent turn emits each queued yield to the listener the
          // runtime registered before prompting — as tool_execution_end
          // events (the shape the runtime captures): rejected attempts first
          // (isError), then successes (details.status "success"), then
          // aborted error yields (details.error).
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
  // The registry the quick/default supervisor resolves a running seat's live
  // session through, by the id the dispatch reserved for that seat.
  AgentRegistry: {
    global: mock(() => ({
      get: mock((id: string) => registryRefs.get(id)),
    })),
  },
}));

mock.module("@oh-my-pi/pi-coding-agent/task/structured-subagent", () => ({
  runStructuredSubagent: mock(async (request: Record<string, unknown>) => {
    subagentRequests.push(request);
    // The dispatch's reserved identity id — what the SDK registers the seat
    // under and what the supervisor addresses the running seat by. One named
    // cast at this mock boundary: the record is a plain object bag, and the
    // SDK contract here is `identity?: { id?: string }`.
    const identity = request.identity as { id?: string } | undefined;
    reservedSeatIds.push(identity?.id);
    seatDispatchQueue.shift()?.();
    if (holdSeats) {
      // The seat stays running until the test releases it (dispatch order).
      await new Promise<void>((resolve) => seatReleases.push(resolve));
    }
    const plan = seatResults.shift() ?? {};
    const status = plan.status ?? "valid";
    return {
      result: {
        index: 0,
        id: `seat-${subagentRequests.length}`,
        agent: "mstar-review-seat",
        exitCode: plan.error ? 1 : 0,
        output: "",
        stderr: plan.stderr ?? "",
        error: plan.error,
        // The SDK's settled abort surface: a cap stop and a provider/session
        // abort both set `aborted`, and only the reason separates them.
        aborted: plan.aborted,
        abortReason: plan.abortReason,
        structuredOutput:
          status === "absent"
            ? undefined
            : { source: "caller", mode: "strict", status, data: plan.data },
      },
      policy: {},
      mergeSummary: "",
      changesApplied: null,
      artifactsDir: "/tmp/fake-artifacts",
      temporaryArtifacts: true,
    };
  }),
}));

// Dynamic import is REQUIRED here: mock.module must be registered before the
// module under test evaluates its omp SDK imports, and static imports hoist
// above the mock calls. (Bun mock.module + module-loading test boundary.)
//
// The `?test=runtime-omp` query is REQUIRED as well: bun's mock.module
// registry is process-global and leaks across test files in one `bun test`
// run, keyed by resolved specifier. tests/review/runner.test.ts mocks this
// very module ("../../src/review/runtime-omp"), and test-file execution order
// is filesystem-dependent — Linux CI (bun 1.4.0) ran runner.test.ts first, so
// this import bound runner's stub and every createAgentSession /
// runStructuredSubagent assertion saw zero calls (13 failures). The query
// suffix gives this file a distinct registry key: the REAL module always loads
// here, while its own omp SDK imports still resolve through the mocks above.
// The specifier goes through a const so tsc never resolves the query-suffixed
// path (non-literal dynamic imports are untyped, hence the cast).
const RUNTIME_OMP_SPEC = "../../src/review/runtime-omp.ts?test=runtime-omp";
const { ompAgentRuntime, superviseSeats, SUMMARY_MD_BUDGET, SEAT_GAP_MAX_CHARS } = (await import(RUNTIME_OMP_SPEC)) as {
  ompAgentRuntime: AgentRuntime;
  superviseSeats: (opts: {
    seats: readonly SupervisedSeat[];
    level: ReviewLevel;
    done: Promise<void>;
  }) => Promise<void>;
  /** The body budget the coverage notes are fitted into. */
  SUMMARY_MD_BUDGET: number;
  /** The per-note character cap. */
  SEAT_GAP_MAX_CHARS: number;
};

/** A valid strict seat payload the engine vocab accepts. */
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
    unverified: ["flag A"],
    ...overrides,
  };
}

/** A complete mstar.review/v1 envelope a deep parent would yield. */
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
    target: { owner: "acme", repo: "widgets", pr: 7 },
  };
}

/** reconFacts with numstat lines spanning two top-level dirs. */
const TWO_CLUSTER_FACTS = [
  "acme/widgets#7",
  "head abc1234567890abcdef1234567890abcdef12",
  "10\t2\tsrc/a.ts",
  "5\t0\tsrc/b.ts",
  "8\t1\tlib/c.ts",
];

/** The synthesized per-review models dir (REQUIRED on every run). */
const AGENT_DIR = "/tmp/omp-agent-test";

/**
 * The run's in-memory credential store. The omp SDK root is mocked in this
 * file, so `AuthStorage` is not importable here; the runtime only hands the
 * instance through to `createAgentSession`, so an identity sentinel is the
 * exact contract under test (the SDK's own type is nominal — a structural stub
 * could never be passed for real).
 */
const TEST_AUTH_STORAGE = { close: () => {}, kind: "in-memory-credential-store" } as never;

const BASE_INPUT = {
  level: "default" as const,
  worktreePath: TEST_WORKTREE,
  reconFacts: TWO_CLUSTER_FACTS,
  modelSelectors: ["ark-plan/deepseek-v4-flash", "ark-plan/backup-model"],
  agentDir: AGENT_DIR,
  authStorage: TEST_AUTH_STORAGE,
};

/** The deep-tier input: same clone/facts/models, level deep. */
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
  yieldListeners.length = 0;
  nudgeCalls.length = 0;
  registryRefs.clear();
  parentStreaming = true;
  parentPromptStarted = null;
  parentPromptRelease = null;
  holdSeats = false;
  seatReleases = [];
  seatDispatchQueue = [];
  // Supervision tests install fake timers; every other test runs on the real clock.
  jest.useRealTimers();
  delete process.env.OMP_REVIEW_MODEL;
});

describe("ompAgentRuntime.runReview — parent session", () => {
  test("keeps the M1 isolation set and drops appendSystemPrompt", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    expect(createdOptions).toHaveLength(1);
    const options = createdOptions[0]!;
    // toEqual (not toMatchObject): dotted keys are literal here — bun's
    // toMatchObject interprets them as paths.
    expect(options.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...BASE_INPUT.modelSelectors] },
      },
    });
    expect(options.restrictToolNames).toBe(true);
    // quick/default keep the Bun fan-out tool set: no `task`, no yield schema.
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

    // Parent session cwd…
    expect(createdOptions[0]!.cwd).toBe(TEST_WORKTREE);
    // …and the ToolSession handed to every seat reports the same cwd — SDK
    // buildExecutorOptions derives each seat's tool cwd from session.cwd, so
    // relative read/grep/glob paths resolve against the PR clone.
    expect(subagentRequests).toHaveLength(2);
    for (const request of subagentRequests) {
      // Our own shim proxy erases to unknown in the mock record; the SDK
      // reads members by property access (the get trap), so probe the same
      // way — `in` would hit the default has trap and miss the shim.
      const seatSession = request.session as { cwd: unknown };
      expect(seatSession.cwd).toBe(TEST_WORKTREE);
    }
  });

  test("parent model + fallback chain come from input.modelSelectors, never re-parsed from env", async () => {
    process.env.OMP_REVIEW_MODEL = "ark-plan/env-only-model";
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });

    // A conflicting env value must NOT leak into the session (split-brain
    // guard): the runner parses OMP_REVIEW_MODEL once, into modelSelectors.
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

  test("empty modelSelectors falls back to the default model pattern", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", modelSelectors: [] });

    const options = createdOptions[0]!;
    expect(options.modelPattern).toBe("ark-plan/deepseek-v4-flash");
    expect(options.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [] },
      },
    });
    // The seat receives the same default the parent gets — never an empty
    // (truthy) model list (PR #4 Bugbot High: `model: []` reaches the SDK).
    expect(subagentRequests[0]!.model).toEqual(["ark-plan/deepseek-v4-flash"]);
  });

  test("installs seat-agent.md into the PR clone at .omp/agents/ and removes it afterwards", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    // The definition was snapshotted from the clone at session creation (the
    // runtime removes it again when the run resolves).
    expect(installedSeatAgent).toBe(readFileSync(join(import.meta.dir, "../../src/review/seat-agent.md"), "utf8"));
    expect(installedSeatAgent).toContain("name: mstar-review-seat");
    expect(installedSeatAgent).toContain("tools: [read, grep, glob]");
    expect(installedSeatAgent).not.toMatch(/^spawns:/m);
    // The clone is caller-owned: only the installed definition is cleaned up;
    // the worktree itself must survive.
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
    expect(disposeCalls).toBe(1);
  });
});

/**
 * The minute figures a rendered seat prompt states, with the direction the
 * engine attached to each. Reads the number, the minute unit and the direction
 * word only — no sentence shape, punctuation or dispatch phrasing is pinned, so
 * harmless engine rewording cannot fail the suite.
 */
function statedMinutes(prompt: string): Array<{ minutes: number; over: boolean }> {
  return [...prompt.matchAll(/(\d+(?:\.\d+)?)\s*min\w*(\s+\w+)?/gi)].map(([, value, marker]) => ({
    minutes: Number(value),
    over: /^over/i.test((marker ?? "").trim()),
  }));
}

/**
 * The signed shared-clock remainder a prompt states: the minute figure that is
 * neither the tier cap nor positive-time-left. Throws when the prompt states no
 * such figure — a fresh full-cap allowance states the cap as its own remainder
 * and lands here.
 */
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
    // Domains per the deterministic partition rule (src + lib clusters).
    const assignments = subagentRequests.map((request) => request.assignment as string);
    expect(assignments[0]).toContain("changeset-1-src");
    expect(assignments[1]).toContain("changeset-2-lib");
    // Each dispatch reserves its registry id up front — the same
    // `<domain>-<seat>` slug the prompt mandates — so the supervisor can
    // address THAT seat by id while it runs, instead of racing the SDK for an
    // id it never reports back.
    expect(reservedSeatIds).toEqual(["changeset-1-src", "changeset-2-lib"]);
  });

  test("seat assignment is engine prReviewSeatPrompt output carrying worktree + scope", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    const first = subagentRequests[0]!.assignment as string;
    expect(first).toContain(TEST_WORKTREE);
    expect(first).toContain(`${PLUGIN_ROOT_FIXTURE}/skills/mstar-audit`);
    // Per-seat recon facts: shared facts + the seat's file scope.
    expect(first).toContain("acme/widgets#7");
    expect(first).toContain("src/a.ts");
    // The shared tier wording comes from the engine (tier: default here).
    expect(first.toLowerCase()).toContain("merge class");
  });

  test("each dispatch states the SHARED remainder — never a fresh full allowance", async () => {
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    /** Dispatch at a controlled elapsed interval; returns that run's rendered assignment. */
    const dispatch = async (elapsedMinutes: number): Promise<string> => {
      anchorRecheckDeadline(Date.now() - elapsedMinutes * 60_000, "default");
      seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
      const before = subagentRequests.length;
      await ompAgentRuntime.runReview(BASE_INPUT);
      return subagentRequests[before]!.assignment as string;
    };

    // The inspected string is the REAL engine seat prompt (the SDK is mocked,
    // the engine is not): these minute figures can only come from its rendered
    // budget head.
    const fourIn = await dispatch(4);
    expect(fourIn).toContain(String(PR_REVIEW_TIER_BUDGETS.default.fileOpenCap));
    // Known nonzero elapsed interval: the head states the whole-review cap AND
    // a remainder of cap minus that interval. A fresh per-seat allowance would
    // state the cap as its own remainder, so no `cap - 4` would appear.
    expect(statedMinutes(fourIn)).toContainEqual({ minutes: cap, over: false });
    expect(statedRemainder(fourIn, cap)).toBe(cap - 4);

    // A LATER dispatch states a strictly smaller remainder.
    const sevenIn = await dispatch(7);
    expect(statedRemainder(sevenIn, cap)).toBe(cap - 7);
    expect(statedRemainder(sevenIn, cap)).toBeLessThan(statedRemainder(fourIn, cap));

    // Past the cap the stated remainder flips direction: an overrun, not time
    // left — and it keeps the signed magnitude.
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

  test("propagates SDK preflight/execution failures", async () => {
    seatResults = [{ error: "provider boom" }];
    await expect(ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" })).rejects.toThrow(
      /review seat 0 .*failed: provider boom/,
    );
    // The parent session is still disposed.
    expect(disposeCalls).toBe(1);
  });

  test("strict schema violations are fatal — no envelope is produced", async () => {
    seatResults = [{ status: "invalid", data: { findings: [{ mergeClass: "critical" }] } }];
    await expect(ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" })).rejects.toThrow(
      /no valid structured output/,
    );
  });

  test("an absent structured output is fatal", async () => {
    seatResults = [{ status: "absent" }];
    await expect(ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" })).rejects.toThrow(
      /no valid structured output/,
    );
  });
});

describe("ompAgentRuntime.runReview — hard seat cap (collected vs uncollected)", () => {
  /** The tier's soft cap in ms — the engine's figure, never a re-typed minute count. */
  const softCapMs = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes * 60_000;
  /**
   * FROZEN PIN, deliberately a literal rather than a read of the source
   * constant: the reserved tail is a contract value — the hard cap must stay
   * clear of the outer exec guard so the runner can still merge, synthesize and
   * validate after the last seat stops. Reading it back from the module would
   * move with it and pin nothing; a deliberate change to that tail must fail
   * here and update this line.
   */
  const TAIL_MS = 60_000;

  test("the seat call is capped by min(soft cap × 2, outer budget − 60s) — never the soft remainder", async () => {
    jest.useFakeTimers();
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];

    // The outer guard still an hour ahead: the DOUBLED soft cap is the tighter
    // term, so the cap is exactly that figure — while the shared soft remainder
    // (a convergence target, counting that same hour) is nothing like it.
    anchorRecheckDeadline(Date.now() + 3_600_000, "default");
    await ompAgentRuntime.runReview(BASE_INPUT);

    const cap = subagentRequests[0]!.maxRuntimeMs as number;
    expect(cap).toBe(softCapMs * 2);
    expect(cap).toBe(subagentRequests[1]!.maxRuntimeMs as number); // one figure for the wave

    // A fresh anchor: the OUTER budget is now the tighter term, and the cap is
    // that budget less the reserved tail — still not the remaining soft time.
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    anchorRecheckDeadline(Date.now(), "default");
    const before = subagentRequests.length;
    await ompAgentRuntime.runReview(BASE_INPUT);

    const outerCapped = subagentRequests[before]!.maxRuntimeMs as number;
    expect(outerCapped).toBe(remainingOuterMs(Date.now(), "default") - TAIL_MS);
    expect(outerCapped).toBeLessThan(softCapMs * 2);
    expect(outerCapped).not.toBe(remainingSoftMinutes(Date.now(), "default") * 60_000);
  });

  test("a spent outer budget still bounds the seat — never the SDK's 0 = no cap", async () => {
    // Anchored past the outer exec guard: there is no outer budget left at all.
    anchorRecheckDeadline(Date.now() - 700_000, "default");
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    // The closure above yields a negative budget; handing the SDK `0` (its
    // documented "no wall-clock limit") would remove the bound instead of
    // enforcing it, so the cap floors at 1ms.
    expect(subagentRequests[0]!.maxRuntimeMs as number).toBe(1);
  });

  test("a seat that returns inside its cap is collected: findings land, no coverage note", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    expect(envelope.summary_md).not.toContain("- notes:");
  });

  test("a seat stopped by its cap is uncollected: the review still lands and declares the gap", async () => {
    seatResults = [
      { status: "absent", aborted: true, abortReason: "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)" },
      { data: seatPayload() },
    ];
    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    // The capped seat contributed nothing — and did NOT fail the review: the
    // seat that did return is synthesized as usual.
    expect(envelope.findings.map((finding) => finding.title)).toEqual(["Unbounded loop"]);
    // The gap is reader-visible on the review body: which seat, which cap fired,
    // and the scope that was never scanned.
    expect(envelope.summary_md).toContain("- notes:");
    expect(envelope.summary_md).toContain("changeset-1-src");
    expect(envelope.summary_md).toContain("Subagent runtime limit exceeded (task.maxRuntimeMs=540000)");
    expect(envelope.summary_md).toContain("src/a.ts");
  });

  test("a cap that fires after the seat collected something keeps those findings and still declares the gap", async () => {
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
    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    // "Returned what it collected" is a different outcome from "returned
    // nothing": the partial payload still lands alongside the declared gap.
    expect(envelope.findings.map((finding) => finding.title)).toEqual(["Missing null check"]);
    expect(envelope.summary_md).toContain("- notes:");
    expect(envelope.summary_md).toContain("changeset-1-src");
  });

  test("an abort the runtime limit did not cause stays fatal — the flag alone is not coverage", async () => {
    // A provider/session abort with no valid output: `aborted` is set, but no
    // cap stopped this seat, so it must reject exactly as before.
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

  test("a cap over an SDK error stays fatal — an error is never just coverage", async () => {
    const reason = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
    seatResults = [
      { status: "absent", aborted: true, abortReason: reason, error: reason },
      { data: seatPayload() },
    ];

    // The cap reason does not excuse a seat that reported an error: the failure
    // wins, and no review is published from a wave that lost a seat.
    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/review seat 0 .*failed:/);
  });

  test("a cap over an explicitly invalid payload stays fatal — invalid is not absent", async () => {
    const reason = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
    seatResults = [
      { status: "invalid", aborted: true, abortReason: reason, data: { findings: [{ mergeClass: "critical" }] } },
      { data: seatPayload() },
    ];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(/no valid structured output/);
  });

  test("a wave with no usable output anywhere is incomplete — never synthesized", async () => {
    const reason = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
    // Its single seat stopped before producing anything: a zero-finding envelope
    // would report a clean verdict over a review that never happened.
    seatResults = [{ status: "absent", aborted: true, abortReason: reason }];

    await expect(ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" })).rejects.toThrow(
      /review incomplete.*full-diff-combined/,
    );
  });

  test("both seats capped before any output: the wave reports itself incomplete", async () => {
    const reason = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
    seatResults = [
      { status: "absent", aborted: true, abortReason: reason },
      { status: "absent", aborted: true, abortReason: reason },
    ];

    await expect(ompAgentRuntime.runReview(BASE_INPUT)).rejects.toThrow(
      /review incomplete.*changeset-1-src, changeset-2-lib/,
    );
  });
});

describe("ompAgentRuntime.runReview — coverage note honesty and budget", () => {
  /** The SDK's own reason for a wall-clock stop, verbatim as its resolver emits it. */
  const CAP_REASON = "Subagent runtime limit exceeded (task.maxRuntimeMs=540000)";
  /** The `- notes:` lines of a rendered body, in order. */
  const noteLines = (summary: string): string[] =>
    summary.split("\n").filter((line) => line.startsWith("- notes: "));

  test("a capped seat that returned a finding never labels that scope unscanned", async () => {
    seatResults = [
      {
        aborted: true,
        abortReason: CAP_REASON,
        data: {
          findings: [
            {
              mergeClass: "must-fix",
              title: "Unbounded loop",
              body: "The loop never terminates on empty input.",
              file_path: "src/a.ts",
              line_start: 10,
            },
          ],
        },
      },
      { data: seatPayload({ findings: [] }) },
    ];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    // The retained finding and the coverage note describe the SAME assigned
    // scope: the note must report that coverage is incomplete, never that the
    // scope went unscanned — the contradiction the reviewer called out.
    const notes = noteLines(envelope.summary_md);
    expect(envelope.findings.map((finding) => finding.file_path)).toEqual(["src/a.ts"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("its assigned scope is not fully covered");
    expect(envelope.summary_md).not.toContain("unscanned");
  });

  test("a scope whose paths are long still fits the body, capped seats and all", async () => {
    // Paths of the length the reviewer's 8,000-char premise implies: the whole
    // assigned scope cannot be listed inside a bounded note.
    const facts = [
      ...Array.from({ length: 5 }, (_, index) => `5\t0\tsrc/file-${index}-${"x".repeat(1_600)}.ts`),
      ...Array.from({ length: 5 }, (_, index) => `1\t0\tlib/file-${index}-${"x".repeat(1_600)}.ts`),
    ];
    seatResults = [
      { aborted: true, abortReason: CAP_REASON, data: { findings: [] } },
      { aborted: true, abortReason: CAP_REASON, data: { findings: [] } },
    ];

    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, reconFacts: facts });

    const notes = noteLines(envelope.summary_md);
    // Every capped seat keeps its coverage line (a note is never dropped by a
    // sibling's length), each line is bounded by CHARACTERS, and the whole body
    // stays inside the budget the publisher truncates at — so nothing that
    // reaches the reader is cut off the end.
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note.length).toBeLessThanOrEqual(SEAT_GAP_MAX_CHARS);
    }
    expect(envelope.summary_md.length).toBeLessThanOrEqual(SUMMARY_MD_BUDGET);
    expect(envelope.summary_md).toContain("changeset-1-src");
    expect(envelope.summary_md).toContain("changeset-2-lib");
  });

  test("a cut scope list is marked explicitly, never silently", async () => {
    // Forty short paths: far more of the assigned scope than a bounded list can
    // name, so the note has to say how many it left out.
    const facts = Array.from({ length: 40 }, (_, index) => `1\t0\tsrc/file-${String(index).padStart(2, "0")}.ts`);
    seatResults = [{ aborted: true, abortReason: CAP_REASON, data: { findings: [] } }];

    const { envelope } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", reconFacts: facts });

    const notes = noteLines(envelope.summary_md);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("its assigned scope is not fully covered");
    expect(notes[0]).toMatch(/, and \d+ more$/);
    expect(notes[0]!.length).toBeLessThanOrEqual(SEAT_GAP_MAX_CHARS);
  });

  test("a summary at the body budget still cannot erase the capped seats' notes", async () => {
    // Each capped seat kept what it collected before the cap: enough findings
    // that the engine's own summary ALONE runs past the whole body budget.
    const findings = (prefix: string, dir: string) =>
      Array.from({ length: 200 }, (_, index) => ({
        mergeClass: "must-fix",
        title: `${prefix} ${String(index).padStart(3, "0")}`,
        body: "The handler assumes the payload is always present.",
        file_path: `${dir}/file-${index}.ts`,
        line_start: index + 1,
      }));
    seatResults = [
      { aborted: true, abortReason: CAP_REASON, data: { findings: findings("alpha", "src") } },
      { aborted: true, abortReason: CAP_REASON, data: { findings: findings("beta", "lib") } },
    ];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    const notesAt = envelope.summary_md.indexOf("\n\n- notes: ");
    const summaryPart = envelope.summary_md.slice(0, notesAt);
    const notes = noteLines(envelope.summary_md);
    // The engine summary was cut to hold the disclosure, and its cut is marked.
    expect(summaryPart).toContain("summary truncated");
    // Both capped seats keep their slug, the cause and the coverage statement.
    expect(notes).toHaveLength(2);
    for (const [index, slug] of ["changeset-1-src", "changeset-2-lib"].entries()) {
      expect(notes[index]).toContain(slug);
      expect(notes[index]).toContain(CAP_REASON);
      expect(notes[index]).toContain("its assigned scope is not fully covered");
    }
    // And the body the publisher receives stays inside the budget it truncates at.
    expect(envelope.summary_md.length).toBeLessThanOrEqual(SUMMARY_MD_BUDGET);
  });
});

describe("ompAgentRuntime.runReview — per-role model overrides", () => {
  test("quick/default: the mstar-review-seat override replaces the seat model chain verbatim", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      modelOverrides: { "mstar-review-seat": "ark-plan/deepseek-v4-flash:high" },
    });

    // L2: the override is applied at the seatModels synthesis — it REPLACES
    // the global chain as the explicit `model` param, sole verbatim entry
    // (no merge, `:thinking` suffix rides along).
    expect(subagentRequests).toHaveLength(2);
    for (const request of subagentRequests) {
      expect(request.model).toEqual(["ark-plan/deepseek-v4-flash:high"]);
    }
    // The settings key is a DEAD surface for quick/default (an explicit
    // request model beats task.agentModelOverrides in the SDK resolution
    // order) — the session settings must never carry it.
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
      modelOverrides: { "mstar-review-seat": "ark-plan/override-model" },
    });

    // The parent keeps the global chain (primary model + retry fallback) —
    // only the seat's explicit model is overridden.
    expect(createdOptions[0]!.modelPattern).toBe(BASE_INPUT.modelSelectors[0]);
    expect((createdOptions[0]!.settings as { overrides: Record<string, unknown> }).overrides[
      "retry.fallbackChains"
    ]).toEqual({ default: [...BASE_INPUT.modelSelectors] });
  });

  test("quick/default: the seat override wins even when the global chain falls back to the default pattern", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      level: "quick",
      modelSelectors: [],
      modelOverrides: { "mstar-review-seat": "ark-plan/override-model" },
    });

    expect(subagentRequests[0]!.model).toEqual(["ark-plan/override-model"]);
  });

  test("quick/default: overrides for other seats and blank values leave today's synthesis untouched", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview({
      ...BASE_INPUT,
      // An unmapped-for-this-path agent name is inert; a blank
      // mstar-review-seat value ≡ no override (L2).
      modelOverrides: { "code-reviewer": "ark-plan/other:high", "mstar-review-seat": "   " },
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
      "code-reviewer": "ark-plan/deepseek-v4-flash:high",
      "fullstack-dev": "openai/gpt-5",
      "frontend-dev": "anthropic/claude-x:low",
    };
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, modelOverrides: overrides });

    // L2: the deep task-tool dispatch passes NO explicit model, so the SDK
    // preflight resolves each spawned seat from this settings record per
    // agent name — the record carries EXACTLY the mapped names (unmapped
    // seats stay keyless → parent active model, today's behavior). The
    // values pass through verbatim (thinking suffixes included).
    expect(createdOptions[0]!.settings).toEqual({
      kind: "isolated",
      overrides: {
        "fetch.enabled": false,
        "retry.modelFallback": true,
        "retry.fallbackChains": { default: [...DEEP_INPUT.modelSelectors] },
        "task.agentModelOverrides": overrides,
      },
    });
    // The deep-only deltas and the parent's own model chain are unchanged.
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
    // Byte-compat gate: no `task.agentModelOverrides` key appears — the
    // serialized options are identical to the no-map run.
    expect(JSON.stringify(createdOptions[0])).toBe(baseline);
  });

  test("deep: mapped settings = the no-map settings plus EXACTLY the overrides key (diff-of-one drift lock)", async () => {
    // Phase 5 fix (PR #7 review): the deep-with-overrides record must be
    // DERIVED from the shared base isolation record, not re-declared — a
    // future isolation setting added to the base can never silently miss
    // this path. Derived expectation, not a re-declared pin: run the no-map
    // path, then require the mapped record to differ by exactly one key.
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);
    const baseOverrides = (createdOptions[0]!.settings as { overrides: Record<string, unknown> })
      .overrides;

    createdOptions.length = 0;
    parentYields = [deepEnvelope()];
    const overrides = { "code-reviewer": "ark-plan/deepseek-v4-flash:high", "frontend-dev": "openai/gpt-5" };
    await ompAgentRuntime.runReview({ ...DEEP_INPUT, modelOverrides: overrides });
    const mappedOverrides = (createdOptions[0]!.settings as { overrides: Record<string, unknown> })
      .overrides;

    // Exactly ONE added key, appended last; every other entry identical
    // (serialized equality against base + the one entry).
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
    // The assignment carries the review tree and the recon facts.
    expect(promptTexts[0]).toContain(TEST_WORKTREE);
    expect(promptTexts[0]).toContain("acme/widgets#7");
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(disposeCalls).toBe(1);
  });

  test("the parent session is dispatched with the shared budget head before the role context", async () => {
    const cap = PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes;
    const elapsedMinutes = 5;
    // Controlled clock: a known nonzero elapsed interval, so the dispatched
    // remainder provably differs from the full tier cap.
    anchorRecheckDeadline(Date.now() - elapsedMinutes * 60_000, "deep");
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    const prompt = promptTexts[0]!;
    // The head opens the assignment — before the role context (the worktree
    // landmark the runtime also puts in this prompt).
    const head = prompt.slice(0, prompt.indexOf(TEST_WORKTREE));
    expect(head.length).toBeGreaterThan(0);
    // It carries the tier, the whole-review cap and the SHARED remainder
    // (cap minus elapsed, computed here — a fresh allowance would be `cap`).
    expect(head).toContain("deep");
    expect(head).toContain(`${cap} min`);
    expect(head).toContain(`${cap - elapsedMinutes} min`);
    expect(head).not.toContain(`${cap} min left`);
    // ...plus a convergence instruction: stop and return what exists.
    expect(head).toMatch(/summari[sz]e/i);
    expect(head).toMatch(/return/i);
    // The parent owns supervising its own `task` seats (the caller cannot
    // address them) with this same clock.
    expect(head).toMatch(/supervis/i);
  });

  test("parent session keeps the isolation set and adds the task tool + strict yield schema", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(createdOptions).toHaveLength(1);
    const options = createdOptions[0]!;
    expect(options.cwd).toBe(TEST_WORKTREE);
    expect(options.restrictToolNames).toBe(true);
    // deep-only: the SDK built-in `task` tool joins the read-only whitelist.
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
    // First attempt ends with isError (the SDK yield tool rejected the
    // payload and the model retried) — it must not be captured even though
    // its args carried a payload; the corrected re-yield is the envelope.
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
      // The envelope was yielded and engine-validated before the throw —
      // returning it stands, but the turn error must stay observable.
      const { envelope } = await ompAgentRuntime.runReview(DEEP_INPUT);
      expect(envelope.schema).toBe("mstar.review/v1");
    } finally {
      spy.mockRestore();
    }
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(String(errorCalls[0]![1])).toContain("provider connection dropped");
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

  test("installs the deep seat roles as OMP-native defs and removes them after", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    // Snapshotted from the clone at session creation: exactly the deep seat
    // roles (no seat-agent.md, no other harness roles on the deep path).
    expect(installedAgentFiles).toEqual(["code-reviewer.md", "frontend-dev.md", "fullstack-dev.md"]);
    expect(installedSeatAgent).toBeNull();
    // The clone is caller-owned: installed definitions are cleaned up, the
    // worktree itself must survive.
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
      // parseAgent is the SDK's own pipeline for an installed agent file:
      // frontmatter parse + parseAgentFields — exactly what omp task
      // discovery runs. A regression to raw harness agents/*.md (OpenCode
      // `tools:` object map) lands here as tools: undefined — the SDK
      // parses a list only from an array or CSV string and appends `yield`
      // only to a list it parsed, so the seat would carry no tools at all.
      const agent = parseAgent(name, content, "project");
      expect(agent.name).toBe(name.replace(/\.md$/, ""));
      expect(agent.tools).toEqual(["read", "grep", "glob", "yield"]);
      // SDK >= 18.10.2 filters `yield` out again unless the definition opts
      // into the structured result contract (the deep parent's task tool
      // runs with `task.structured` off), so the seat must declare it.
      expect(agent.structured).toBe(true);
      // Zero-copy: the role BODY is the fixture marker loaded from the
      // plugin root at runtime, not a pasted copy.
      expect(agent.systemPrompt).toContain(`# fixture agent: ${agent.name}`);
    }
  });

  test("a partially-failed install cleans the seat files from the clone (qc1 F-002)", async () => {
    const rolePath = join(PLUGIN_ROOT_FIXTURE, "agents", "fullstack-dev.md");
    const original = readFileSync(rolePath, "utf8");
    rmSync(rolePath);
    try {
      // code-reviewer.md lands first, then the missing fullstack-dev.md
      // fails the install — cleanup must still remove what was written.
      await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(
        /missing the deep seat role agents\/fullstack-dev\.md/,
      );
    } finally {
      writeFileSync(rolePath, original);
    }
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
  });

  test("assignment loads the review command from the plugin root at runtime (zero copy)", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    // The fixture marker text only exists in $HARNESS_PLUGIN_ROOT — its
    // presence in the prompt proves the runtime loaded the command from the
    // plugin root instead of a pasted copy in src/.
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

describe("ompAgentRuntime.runReview — envelope", () => {
  test("merges, dedupes, synthesizes and validates the mstar.review/v1 envelope", async () => {
    seatResults = [
      {
        data: seatPayload({
          unverified: ["flag A", "flag B"],
        }),
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
            // Duplicate of seat 1's must-fix by composite fingerprint.
            {
              mergeClass: "must-fix",
              title: "Unbounded loop",
              body: "duplicate",
              file_path: "src/a.ts",
              line_start: 10,
            },
          ],
          unverified: ["flag A"],
        },
      },
    ];

    const { envelope } = await ompAgentRuntime.runReview(BASE_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    // A must-fix finding drives the engine tally → "blocked".
    expect(envelope.verdict).toBe("blocked");
    expect(envelope.findings).toHaveLength(2);
    expect(envelope.findings.map((finding) => finding.title).sort()).toEqual([
      "Missing null check",
      "Unbounded loop",
    ]);
    expect(envelope.tally?.tally.unverified).toBe(2);
    // recon facts fold into the envelope target.
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
    // The rest of the isolation set is untouched (agentDir is additive).
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
    // The credential store is the fix for the run's own tools reading the App's
    // key pool: the SDK's default is `discoverAuthStorage(agentDir)`, which
    // recreates `<agentDir>/agent.db` on disk. Omitting `authStorage` on ANY
    // call site silently undoes that, so each is asserted by identity on the
    // exact instance the runner loaded the pool into. The deep recheck session
    // — the third call site — is asserted in the recheck block below, where
    // both of that path's sessions are captured.
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
    // Guards the failure mode the SDK's own default would produce: the option
    // must be the caller's instance, not a fresh `discoverAuthStorage` result.
    const other = { close: () => {}, kind: "other-store" } as never;
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", authStorage: other });
    expect(createdOptions[0]!.authStorage).toBe(other);
    expect(createdOptions[0]!.authStorage).not.toBe(TEST_AUTH_STORAGE);
  });
});

describe("ompAgentRuntime.runReview — recheck seat (spec §7.8)", () => {
  const RECHECK_SHA = "0123456789abcdef0123456789abcdef01234567";

  /** Minimal trusted-catalog recheck input (shape mirrors the T1 fixtures). */
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
          oldBlobOid: "oid-old",
          headBlobOid: "oid-head",
          absentAtHead: false,
          complete: true,
        },
      ],
      discussion: { items: [], issueCoverage: "complete", issueDigest: "d", capturedMs: 1, threads: [] },
      ...overrides,
    };
  }

  /** A document validateRecheckDoc accepts against `recheckInput()`. */
  function validRecheckDoc(): RecheckDoc {
    return {
      schema: "mstar.recheck/v1",
      headSha: RECHECK_SHA,
      results: [
        { rowId: "row-1", disposition: "unverifiable", reason: "no-evidence", evidence: null, relatedCurrentFindingIndexes: [] },
      ],
    };
  }

  /** A stale document — validateRecheckDoc rejects it as a whole. */
  function staleRecheckDoc(): RecheckDoc {
    return { ...validRecheckDoc(), headSha: "ffffffffffffffffffffffffffffffffffffffff" };
  }

  beforeEach(() => {
    // Fresh far-future anchor per test: budget-equivalent to the unset state
    // (full 180s cap) AND immune to anchor state leaked from other test
    // files (bun's module registry is process-global — the runner's
    // anchorRecheckDeadline state is shared).
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
  });

  afterEach(() => {
    // Same neutralization for every describe that runs after this one.
    anchorRecheckDeadline(Date.now() + 3_600_000, "deep");
  });

  test("quick/default: the recheck child runs concurrently on the SAME read-only ToolSession", async () => {
    // Dispatch order: the recheck child is created BEFORE the review seats.
    seatResults = [{ data: validRecheckDoc() }, { data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    const { envelope, recheck } = await ompAgentRuntime.runReview({ ...BASE_INPUT, recheck: recheckInput() });

    // The validated doc rides the result; the envelope is untouched.
    expect(recheck).toEqual(validRecheckDoc());
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("blocked");

    expect(subagentRequests).toHaveLength(3);
    const request = subagentRequests[0]!;
    expect(request.agent).toBe("mstar-review-seat");
    // The ToolSession handed to the recheck child reports the PR-clone cwd
    // (probe by property access — the shim proxy erases to unknown, and
    // toMatchObject cannot see through the get trap).
    expect((request.session as { cwd: unknown }).cwd).toBe(TEST_WORKTREE);
    expect(request.outputSchema).toBe(RECHECK_OUTPUT_SCHEMA);
    expect(request.schemaMode).toBe("strict");
    expect(request.enableLsp).toBe(false);
    expect(request.enableIrc).toBe(false);
    // Unset (fresh far-future) anchor → the full 180s cap; the SDK abort
    // signal is wired.
    expect(request.maxRuntimeMs).toBe(180_000);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.model).toEqual([...BASE_INPUT.modelSelectors]);
    // The assignment labels the discussion untrusted and carries the
    // ORIGINAL concern body + trusted catalog.
    const assignment = request.assignment as string;
    expect(assignment).toContain("mstar.recheck-input/v1");
    expect(assignment).toContain(RECHECK_SHA);
    expect(assignment).toContain("The reaper recurses without a depth bound.");
    expect(assignment).toContain("UNTRUSTED");
    expect(assignment).toContain("mstar.recheck/v1");
    // The review seats keep their own assignments.
    expect(subagentRequests[1]!.assignment).toContain("changeset-1-src");
    expect(subagentRequests[2]!.assignment).toContain("changeset-2-lib");
  });

  test("invalid recheck payload → recheck null + stderr log; the envelope is untouched", async () => {
    seatResults = [{ data: staleRecheckDoc() }, { data: seatPayload() }];
    const errorCalls: unknown[][] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
    let result: Awaited<ReturnType<typeof ompAgentRuntime.runReview>>;
    try {
      result = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });
    } finally {
      spy.mockRestore();
    }
    // Seat failure/invalid payload never loses the review and never throws.
    expect(result.recheck).toBeNull();
    expect(result.envelope.schema).toBe("mstar.review/v1");
    expect(result.envelope.verdict).toBe("blocked");
    const logged = errorCalls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("recheck_seat_failed");
    expect(logged).toContain("stale document");
  });

  test("exhausted budget → the seat is skipped entirely (no child started)", async () => {
    anchorRecheckDeadline(Date.now() - 600_000, "quick"); // outer deadline already past → 0
    seatResults = [{ data: seatPayload() }];
    const { recheck } = await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() });

    expect(recheck).toBeNull();
    // Only the review seat ran — no recheck child was dispatched.
    expect(subagentRequests).toHaveLength(1);
    expect(subagentRequests[0]!.outputSchema).not.toBe(RECHECK_OUTPUT_SCHEMA);
  });

  test("a review failure aborts the recheck child and still rejects (never lose the review)", async () => {
    seatResults = [{ data: validRecheckDoc() }, { error: "provider boom" }];
    await expect(
      ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", recheck: recheckInput() }),
    ).rejects.toThrow(/provider boom/);

    // The recheck child was aborted through the shared controller; the
    // review seats carry no SDK signal — they ARE the work that settles.
    expect(subagentRequests).toHaveLength(2);
    expect((subagentRequests[0]!.signal as AbortSignal).aborted).toBe(true);
    expect(subagentRequests[1]!.signal).toBeUndefined();
  });

  test("deep: the recheck seat runs on a DEDICATED read-only session, not the parent's yield stream", async () => {
    parentYields = [deepEnvelope()];
    seatResults = [{ data: validRecheckDoc() }];
    const { envelope, recheck } = await ompAgentRuntime.runReview({ ...DEEP_INPUT, recheck: recheckInput() });

    // The deep parent envelope capture is uncontaminated by the recheck
    // session: exactly the yielded envelope, re-validated.
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.findings[0]!.title).toBe("Missing null check");
    expect(recheck).toEqual(validRecheckDoc());

    // TWO sessions: the deep parent + the dedicated recheck session.
    expect(createdOptions).toHaveLength(2);
    const parent = createdOptions[0]!;
    const recheckSessionOptions = createdOptions[1]!;
    expect(parent.toolNames).toEqual(["read", "grep", "glob", "task"]);
    expect(parent.requireYieldTool).toBe(true);
    // The recheck session: quick/default isolation — read/grep/glob only,
    // no `task` tool, no yield schema.
    expect(recheckSessionOptions.toolNames).toEqual(["read", "grep", "glob"]);
    expect(recheckSessionOptions.requireYieldTool).toBe(false);
    expect(recheckSessionOptions.outputSchema).toBeUndefined();
    expect(recheckSessionOptions.cwd).toBe(TEST_WORKTREE);
    expect(recheckSessionOptions.agentDir).toBe(AGENT_DIR);
    // Both deep-path sessions carry the run's credential store — the third of
    // the three call sites; omitting it would let the SDK recreate the
    // credential database on disk for the recheck session.
    expect(parent.authStorage).toBe(TEST_AUTH_STORAGE);
    expect(recheckSessionOptions.authStorage).toBe(TEST_AUTH_STORAGE);

    // Exactly one structured child: the recheck seat (never a second
    // prompt/yield stream on the parent session).
    expect(subagentRequests).toHaveLength(1);
    expect(subagentRequests[0]!.outputSchema).toBe(RECHECK_OUTPUT_SCHEMA);
    expect(subagentRequests[0]!.assignment).not.toContain("Fixture marker");
    expect(promptTexts).toHaveLength(1);

    // The shared mstar-review-seat definition joined the deep installs.
    expect(installedAgentFiles).toEqual([
      "code-reviewer.md",
      "frontend-dev.md",
      "fullstack-dev.md",
      "mstar-review-seat.md",
    ]);
    // Both sessions settle before the cleanup; the clone survives.
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
    // Cleanup still removed every installed definition (both sessions settled).
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
  });
});

/**
 * Seat supervision (progress nudges): while a seat runs it is told how much of
 * the shared review clock is left and asked to converge; a seat that returned is
 * never messaged again. The loop's ticks are driven through bun's FAKE CLOCK
 * (`jest.useFakeTimers`), so every tick, figure and delivery is deterministic.
 */
describe("ompAgentRuntime.runReview — seat supervision (progress nudges)", () => {
  /** The engine cadence this repo reads — never a re-typed number of seconds. */
  const normalTickMs = PR_REVIEW_NUDGE_CADENCE.normalSeconds * 1000;
  const overrunTickMs = PR_REVIEW_NUDGE_CADENCE.overrunSeconds * 1000;

  /** Let the supervision loop's pending microtasks run without moving the clock. */
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

    // Nothing before the tick — and the tick is the engine's.
    jest.advanceTimersByTime(normalTickMs - 1);
    await flush();
    expect(deliveries).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await flush();
    expect(deliveries.map(({ id, deliverAs }) => ({ id, deliverAs }))).toEqual([
      { id: "a", deliverAs: "aside" },
      { id: "b", deliverAs: "aside" },
    ]);
    // The figure is the live shared remainder, never the tier cap: the cap minus
    // the one tick elapsed since the anchor.
    expect(deliveries[0]!.text).toContain(`${cap - PR_REVIEW_NUDGE_CADENCE.normalSeconds / 60} min left`);

    // Seat `a` returned: it is never nudged again while the running seat keeps
    // its tick.
    running.delete("a");
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(deliveries.slice(2).map(({ id }) => id)).toEqual(["b"]);

    // The supervised work settled: the loop ends there — and only because the
    // pending tick was cleared (nothing advances the clock again), never a
    // detached timer left running.
    done.resolve();
    await supervision;
    jest.advanceTimersByTime(normalTickMs * 3);
    await flush();
    expect(deliveries).toHaveLength(3);
  });

  test("past the soft cap the tick shortens and the nudge hardens to a steer", async () => {
    jest.useFakeTimers();
    const cap = PR_REVIEW_TIER_BUDGETS.default.wallClockMinutes;
    // Anchored past the tier cap: the review is already over its shared clock.
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

    // The OVERRUN tick governs the wait — the normal tick would not have fired.
    jest.advanceTimersByTime(overrunTickMs - 1);
    await flush();
    expect(deliveries).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await flush();
    expect(deliveries).toHaveLength(1);
    // Over budget: the nudge interrupts the turn instead of riding the next step
    // boundary, and reports the overrun.
    expect(deliveries[0]!.deliverAs).toBe("steer");
    expect(deliveries[0]!.text).toMatch(/min over/i);

    // The overrun tick governs the NEXT wait too.
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
    // The reserved ids are the `<domain>-<seat>` slugs the dispatch mandates, so
    // the fake registry stands exactly where the SDK's would: addressable while
    // that seat runs.
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

    // The first seat returns: only the seat still running is nudged again.
    seatReleases.shift()!();
    await flush();
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.slice(2).map(({ id }) => id)).toEqual(["changeset-2-lib"]);

    // The second seat returns: the fan-out resolves, the review completes, and
    // the loop is gone with it.
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
    // Seat 0 fails (SDK execution error) while seat 1 is still running.
    seatResults = [{ error: "provider boom" }, { data: seatPayload({ findings: [] }) }];

    const run = ompAgentRuntime.runReview(BASE_INPUT);
    // Observe the eventual rejection without blocking the mid-flight assertions.
    const outcome = run.then(
      () => null,
      (error: unknown) => error,
    );
    await dispatched[1]!.promise;

    // Seat 0 returned (rejected): its sibling keeps its ticks, and nothing has
    // been torn down while that sibling still runs.
    seatReleases.shift()!();
    await flush();
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.map(({ id }) => id)).toEqual(["changeset-2-lib"]);
    expect(disposeCalls).toBe(0);
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents", "mstar-review-seat.md"))).toBe(true);

    // Seat 1 returns: the review fails with the ORIGINAL seat error — a
    // surviving seat never synthesizes a review on its own.
    seatReleases.shift()!();
    expect(String(await outcome)).toMatch(/review seat 0 .*failed: provider boom/);
    // Teardown happened only after the last settlement, and neither seat is
    // nudged again.
    expect(disposeCalls).toBe(1);
    jest.advanceTimersByTime(normalTickMs * 3);
    await flush();
    expect(nudgeCalls.map(({ id }) => id)).toEqual(["changeset-2-lib"]);
  });

  test("deep: the running parent turn is nudged aside inside the cap, steered past it, then left alone", async () => {
    jest.useFakeTimers();
    anchorRecheckDeadline(Date.now(), "deep");
    const cap = PR_REVIEW_TIER_BUDGETS.deep.wallClockMinutes;
    const started = deferred();
    const release = deferred();
    parentPromptStarted = started.resolve;
    parentPromptRelease = release.promise;
    parentYields = [deepEnvelope()];

    const run = ompAgentRuntime.runReview(DEEP_INPUT);
    await started.promise;

    // Inside the cap: a non-interrupting aside carrying the live remainder.
    jest.advanceTimersByTime(normalTickMs);
    await flush();
    expect(nudgeCalls.map(({ id, deliverAs }) => ({ id, deliverAs }))).toEqual([
      { id: PARENT_SESSION_ID, deliverAs: "aside" },
    ]);
    expect(nudgeCalls[0]!.text).toContain(`${cap - PR_REVIEW_NUDGE_CADENCE.normalSeconds / 60} min left`);

    // Past the soft cap: the next nudge interrupts and reports the overrun.
    jest.advanceTimersByTime(cap * 60_000);
    await flush();
    expect(nudgeCalls).toHaveLength(2);
    expect(nudgeCalls[1]!.deliverAs).toBe("steer");
    expect(nudgeCalls[1]!.text).toMatch(/min over/i);

    // The turn returns: the review resolves without waiting out a pending tick
    // (the timer was cleared), and the parent session is never touched again.
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
    // The turn is over; only the driver's settlement is still pending.
    parentStreaming = false;
    parentYields = [deepEnvelope()];

    const run = ompAgentRuntime.runReview(DEEP_INPUT);
    await started.promise;
    jest.advanceTimersByTime(normalTickMs * 2);
    await flush();
    // An aside here would start a fresh turn and a steer could resume one — a
    // seat that already returned must never be restarted.
    expect(nudgeCalls).toHaveLength(0);

    release.resolve();
    await run;
  });
});
