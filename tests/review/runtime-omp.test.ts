/**
 * Unit tests for the omp AgentRuntime adapter (plan 07 Task 2).
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
 *   - level "deep" drives the parent-session path (plan 09 Task 2): the
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
 *   - per-role model overrides (plan 17 B6): quick/default applies the
 *     `mstar-review-seat` override at the seatModels synthesis (explicit
 *     model replaces the global chain verbatim; NO settings key), deep writes
 *     the map into the isolated settings as `task.agentModelOverrides` with
 *     exact agent names; absent/empty map = today's options byte-for-byte.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

import type { AgentRuntime } from "../../src/review/runtime";
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
let seatResults: Array<{ error?: string; status?: string; data?: unknown; stderr?: string }> = [];
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
        dispose: mock(async () => {
          disposeCalls += 1;
        }),
        subscribe: mock((listener: (event: unknown) => void) => {
          yieldListeners.push(listener);
          return () => {};
        }),
        prompt: mock(async (text: string) => {
          promptTexts.push(text);
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
}));

mock.module("@oh-my-pi/pi-coding-agent/task/structured-subagent", () => ({
  runStructuredSubagent: mock(async (request: Record<string, unknown>) => {
    subagentRequests.push(request);
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
const { ompAgentRuntime } = (await import(RUNTIME_OMP_SPEC)) as { ompAgentRuntime: AgentRuntime };

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

const BASE_INPUT = {
  level: "default" as const,
  worktreePath: TEST_WORKTREE,
  reconFacts: TWO_CLUSTER_FACTS,
  modelSelectors: ["ark-plan/deepseek-v4-flash", "ark-plan/backup-model"],
};

/** The deep-tier input: same clone/facts/models, level deep. */
const DEEP_INPUT = { ...BASE_INPUT, level: "deep" as const };

afterEach(() => {
  createdOptions.length = 0;
  subagentRequests.length = 0;
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

describe("ompAgentRuntime.runReview — per-role model overrides (plan 17 B6)", () => {
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

describe("ompAgentRuntime.runReview — deep parent path (plan 09 T2)", () => {
  test("drives the parent session: one prompt, zero seat fan-out", async () => {
    parentYields = [deepEnvelope()];
    const envelope = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(promptTexts).toHaveLength(1);
    expect(subagentRequests).toHaveLength(0);
    // The assignment carries the review tree and the recon facts.
    expect(promptTexts[0]).toContain(TEST_WORKTREE);
    expect(promptTexts[0]).toContain("acme/widgets#7");
    expect(envelope.schema).toBe("mstar.review/v1");
    expect(disposeCalls).toBe(1);
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
    const envelope = await ompAgentRuntime.runReview(DEEP_INPUT);

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
    const envelope = await ompAgentRuntime.runReview(DEEP_INPUT);

    expect(envelope.schema).toBe("mstar.review/v1");
    expect(envelope.verdict).toBe("needs fixes");
  });

  test("the LAST successful yield wins over an earlier accepted one (qc3 S-001)", async () => {
    parentYields = [
      { schema: "mstar.review/v1", verdict: "ship it", summary_md: "earlier", findings: [] },
      deepEnvelope(),
    ];
    const envelope = await ompAgentRuntime.runReview(DEEP_INPUT);

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
      const envelope = await ompAgentRuntime.runReview(DEEP_INPUT);
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
      // `tools:` object map) lands here as tools: undefined (an empty
      // whitelist under the parent's restrictToolNames — the yield-only
      // blind seat).
      const agent = parseAgent(name, content, "project");
      expect(agent.name).toBe(name.replace(/\.md$/, ""));
      expect(agent.tools).toEqual(["read", "grep", "glob", "yield"]);
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

    const envelope = await ompAgentRuntime.runReview(BASE_INPUT);

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
describe("ompAgentRuntime.runReview — per-review agentDir threading (plan 23 Task 3, AL-23-1)", () => {
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

  test("absent agentDir keeps today's options byte-for-byte (no agentDir key)", async () => {
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick" });
    const quick = JSON.stringify(createdOptions[0]);
    expect(JSON.stringify(Object.keys(createdOptions[0]!))).not.toContain('"agentDir"');

    createdOptions.length = 0;
    seatResults = [{ data: seatPayload() }];
    await ompAgentRuntime.runReview({ ...BASE_INPUT, level: "quick", agentDir: undefined });
    expect(JSON.stringify(createdOptions[0])).toBe(quick);
  });
});
