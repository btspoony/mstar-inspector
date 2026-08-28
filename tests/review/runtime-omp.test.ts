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
 *   - seat-agent.md is copied into the throwaway session cwd at
 *     .omp/agents/mstar-review-seat.md (name/tools frontmatter, no spawns);
 *   - quick → 1 seat, default → 2 seats, Promise.all fan-out, agent
 *     "mstar-review-seat", strict schema, model = selector chain;
 *   - seat assignment is engine prReviewSeatPrompt output (zero harness
 *     copies here) carrying the worktree path and the seat file scope;
 *   - strict seat output → merge → synthesizeReview → validateMstarReviewV1
 *     envelope; any failure throws (never an M1-shaped success);
 *   - level "deep" is rejected at the port.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";

/** Captured createAgentSession options (one entry per runReview call). */
const createdOptions: Record<string, unknown>[] = [];
let seatResults: Array<{ error?: string; status?: string; data?: unknown; stderr?: string }> = [];
/** Definition content snapshotted from the throwaway cwd at session creation. */
let installedSeatAgent: string | null = null;
/** Count of fake session.dispose() calls since the last createAgentSession. */
let disposeCalls = 0;
/** Captured runStructuredSubagent requests, in dispatch order. */
const subagentRequests: Record<string, unknown>[] = [];

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  createAgentSession: mock(async (options: Record<string, unknown>) => {
    createdOptions.push(options);
    disposeCalls = 0;
    // The seat agent definition is copied into the throwaway cwd BEFORE
    // session creation — snapshot it here, the cwd is rm'd afterwards.
    const installed = join(options.cwd as string, ".omp", "agents", "mstar-review-seat.md");
    installedSeatAgent = existsSync(installed) ? readFileSync(installed, "utf8") : null;
    return {
      session: {
        dispose: mock(async () => {
          disposeCalls += 1;
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
const { ompAgentRuntime } = await import("../../src/review/runtime-omp");

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
  worktreePath: "/workspace/clone",
  reconFacts: TWO_CLUSTER_FACTS,
  modelSelectors: ["ark-plan/deepseek-v4-flash", "ark-plan/backup-model"],
};

afterEach(() => {
  createdOptions.length = 0;
  subagentRequests.length = 0;
  seatResults = [];
  installedSeatAgent = null;
  disposeCalls = 0;
});

describe("ompAgentRuntime.runReview — parent session", () => {
  test("keeps the M1 isolation set and drops appendSystemPrompt", async () => {
    process.env.OMP_REVIEW_MODEL = "ark-plan/deepseek-v4-flash, ark-plan/backup-model";
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
        "retry.fallbackChains": { default: ["ark-plan/deepseek-v4-flash", "ark-plan/backup-model"] },
      },
    });
    expect(options.toolNames).toEqual(["read", "grep", "glob"]);
    expect(options.additionalExtensionPaths).toEqual([PLUGIN_ROOT_FIXTURE]);
    expect(options.skills).toEqual([{ name: "mstar-audit" }, { name: "other-skill" }]);
    // The OMP_REVIEW_MODEL chain rode in as the retry fallback chain above.
    delete process.env.OMP_REVIEW_MODEL;
  });

  test("copies seat-agent.md into the throwaway cwd at .omp/agents/", async () => {
    seatResults = [{ data: seatPayload() }, { data: seatPayload({ findings: [] }) }];
    await ompAgentRuntime.runReview(BASE_INPUT);

    // The definition was snapshotted from the throwaway cwd at session
    // creation (the cwd itself is rm'd when the runtime resolves).
    expect(installedSeatAgent).toBe(readFileSync(join(import.meta.dir, "../../src/review/seat-agent.md"), "utf8"));
    expect(installedSeatAgent).toContain("name: mstar-review-seat");
    expect(installedSeatAgent).toContain("tools: [read, grep, glob]");
    expect(installedSeatAgent).not.toMatch(/^spawns:/m);
    // The throwaway cwd is disposed with the session.
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
    expect(first).toContain("/workspace/clone");
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
      ompAgentRuntime.runReview({ ...BASE_INPUT, level: "deep" as never }),
    ).rejects.toThrow(/unsupported review level/);
    expect(subagentRequests).toHaveLength(0);
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
