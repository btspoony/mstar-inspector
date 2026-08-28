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
 *     from the plugin-root fixture at runtime, harness agents/*.md are
 *     installed into <worktree>/.omp/agents/ for the run and removed after,
 *     the strict yield payload is re-validated against the engine vocab, and
 *     partitionSeats/runStructuredSubagent are never called — quick/default
 *     keep the Bun fan-out untouched;
 *   - a non-delivered level is rejected at the port.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
/** GH_TOKEN seen in process.env at session creation (must be stripped on deep). */
let ghTokenAtCreation: string | undefined;
/** Count of fake session.dispose() calls since the last createAgentSession. */
let disposeCalls = 0;
/** Captured runStructuredSubagent requests, in dispatch order. */
const subagentRequests: Record<string, unknown>[] = [];
/** Captured parent-session prompt texts (deep path, in call order). */
const promptTexts: string[] = [];
/** Structured yield payloads / errors the fake parent emits to its subscriber during prompt. */
let parentYields: unknown[] = [];
let parentYieldErrors: string[] = [];
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
    // Same creation-time snapshots for the deep path: the full installed
    // agents listing (harness role agents) and the GH_TOKEN strip window.
    const agentsDir = join(options.cwd as string, ".omp", "agents");
    installedAgentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).sort() : null;
    ghTokenAtCreation = process.env.GH_TOKEN;
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
          // The parent turn emits each queued yield (success payload, then
          // error) to the listener the runtime registered before prompting.
          const listener = yieldListeners[yieldListeners.length - 1];
          parentYields.forEach((data, index) => {
            listener?.({
              type: "tool_execution_start",
              toolCallId: `yield-${index}`,
              toolName: "yield",
              args: { result: { data } },
            });
          });
          parentYieldErrors.forEach((error, index) => {
            listener?.({
              type: "tool_execution_start",
              toolCallId: `yield-error-${index}`,
              toolName: "yield",
              args: { result: { error } },
            });
          });
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
  ghTokenAtCreation = undefined;
  disposeCalls = 0;
  promptTexts.length = 0;
  parentYields = [];
  parentYieldErrors = [];
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

  test("installs harness agents into the PR clone for the run and removes them after", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    // Snapshotted from the clone at session creation: exactly the fixture
    // role agents (no seat-agent.md on the deep path).
    expect(installedAgentFiles).toEqual(["code-reviewer.md", "frontend-dev.md"]);
    expect(installedSeatAgent).toBeNull();
    // The clone is caller-owned: installed definitions are cleaned up, the
    // worktree itself must survive.
    expect(existsSync(join(TEST_WORKTREE, ".omp", "agents"))).toBe(false);
    expect(existsSync(join(TEST_WORKTREE, ".omp"))).toBe(false);
    expect(existsSync(TEST_WORKTREE)).toBe(true);
    expect(disposeCalls).toBe(1);
  });

  test("assignment loads the review command from the plugin root at runtime (zero copy)", async () => {
    parentYields = [deepEnvelope()];
    await ompAgentRuntime.runReview(DEEP_INPUT);

    // The fixture marker text only exists in $HARNESS_PLUGIN_ROOT — its
    // presence in the prompt proves the runtime loaded the command from the
    // plugin root instead of a pasted copy in src/.
    expect(promptTexts[0]).toContain("Fixture marker for the pinned 3.5.0 command.");
  });

  test("GH_TOKEN never reaches the deep parent env and is restored after success", async () => {
    process.env.GH_TOKEN = "test-installation-token";
    parentYields = [deepEnvelope()];
    try {
      await ompAgentRuntime.runReview(DEEP_INPUT);
      expect(ghTokenAtCreation).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("test-installation-token");
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  test("GH_TOKEN is restored even when the deep run fails", async () => {
    process.env.GH_TOKEN = "test-installation-token";
    try {
      await expect(ompAgentRuntime.runReview(DEEP_INPUT)).rejects.toThrow(/no structured yield/);
      expect(ghTokenAtCreation).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("test-installation-token");
    } finally {
      delete process.env.GH_TOKEN;
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
