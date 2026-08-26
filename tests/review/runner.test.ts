/**
 * Unit tests for the container review-runner entry (plan 06 Task 2).
 *
 * The @oh-my-pi/pi-coding-agent SDK boundary is mocked (same technique as
 * e2e.test.ts) so the tests are deterministic. Contract under test:
 *   - runner.ts reuses the M0 CLI main (src/review/run.ts) — identity pin so
 *     the container entry can never drift from the reviewed CLI semantics;
 *   - main() via the runner: valid diff → exit 0, stdout is ONLY the
 *     ReviewOutput JSON (no {mode, result} envelope); unparseable raw →
 *     summary mode still exits 0 with a valid ReviewOutput; usage error → 2;
 *     unreadable diff file → 1; session failure → 1 with empty stdout.
 *
 * The container-specific pieces (HARNESS_PLUGIN_ROOT=/opt/mstar-harness
 * resolution, fetch.enabled=false isolation, read/grep/glob whitelist) are
 * covered by session.test.ts — they are inherited here unchanged.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Raw assistant text the fake session returns; set per test. */
let rawOutput = "";
/** When set, the fake session's prompt throws (simulates SDK/provider failure). */
let sessionError: Error | undefined;

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  createAgentSession: mock(async () => ({
    session: {
      prompt: mock(async () => {
        if (sessionError) throw sessionError;
        return true;
      }),
      getLastAssistantMessage: mock(() => ({
        role: "assistant",
        content: [{ type: "text", text: rawOutput }],
      })),
      dispose: mock(async () => {}),
    },
  })),
  SessionManager: {
    inMemory: mock((cwd?: string) => ({ kind: "in-memory", cwd })),
  },
  Settings: {
    isolated: mock((overrides: Record<string, unknown>) => ({
      kind: "isolated",
      overrides,
      get: (path: string) => overrides[path],
    })),
  },
  loadSkillsFromDir: mock(async () => ({
    skills: [
      {
        name: "mstar-audit",
        description: "Morning Star codebase audit",
        filePath: "/virtual/mstar-harness/skills/mstar-audit/SKILL.md",
        baseDir: "/virtual/mstar-harness/skills/mstar-audit",
        source: "mstar-harness",
      },
    ],
    warnings: [],
  })),
}));

import { main as runMain } from "../../src/review/run";
import { main as runnerMain } from "../../src/review/runner";
import { parseReviewOutput, type ReviewOutput } from "../../src/review/schema";

const FIXTURE = new URL("../../tests/fixtures/sample-pr.diff", import.meta.url).pathname;
const sampleDiff = readFileSync(FIXTURE, "utf8");

const VALID_OUTPUT: ReviewOutput = {
  verdict: "request_changes",
  summary_md: "Two issues found in the diff.",
  findings: [
    {
      severity: "warning",
      category: "logic",
      file_path: "src/auth.ts",
      line_start: 21,
      line_end: 21,
      title: "Fractional expiry comparison",
      body: "`claims.exp < Date.now() / 1000` compares against a fractional value.",
    },
  ],
};

/** Capture console.log / console.error while a runner main() call runs. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = mock((...args: unknown[]) => stdout.push(args.map(String).join(" ")));
  const err = mock((...args: unknown[]) => stderr.push(args.map(String).join(" ")));
  const prevLog = console.log;
  const prevErr = console.error;
  console.log = log as typeof console.log;
  console.error = err as typeof console.error;
  try {
    const code = await runnerMain(argv);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
}

afterEach(() => {
  rawOutput = "";
  sessionError = undefined;
});

describe("runner entry (src/review/runner.ts)", () => {
  test("reuses the M0 CLI main — identity pin against run.ts", () => {
    // The container entry must stay byte-identical to the reviewed M0 CLI
    // semantics (exit codes + stdout purity). If this pin breaks, the runner
    // has drifted from the reviewed contract.
    expect(runnerMain).toBe(runMain);
  });

  test("--diff <file> exits 0 and prints ONLY the ReviewOutput JSON", async () => {
    rawOutput = JSON.stringify(VALID_OUTPUT);
    const { code, stdout, stderr } = await runCli(["--diff", FIXTURE]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("mode");
    expect(parsed).toHaveProperty("verdict");
    expect(parsed).toHaveProperty("summary_md");
    expect(parsed).toHaveProperty("findings");
    expect(parsed.verdict).toBe("request_changes");
    // Diagnostics go to stderr, not stdout.
    expect(stderr).toContain("review mode: structured");
  });

  test("summary fallback still exits 0 with a valid ReviewOutput on stdout", async () => {
    rawOutput = "not json at all";
    const { code, stdout, stderr } = await runCli(["--diff", FIXTURE]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as ReviewOutput;
    expect(parsed.verdict).toBe("comment");
    expect(parsed.findings).toEqual([]);
    expect(parsed.summary_md.length).toBeGreaterThan(0);
    expect(stderr).toContain("review mode: summary");
  });

  test("the structured stdout itself passes parseReviewOutput", async () => {
    rawOutput = JSON.stringify(VALID_OUTPUT);
    const { stdout } = await runCli(["--diff", FIXTURE]);

    const parsed = parseReviewOutput(stdout);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output).toEqual(VALID_OUTPUT);
    }
  });

  test("missing --diff flag → usage error, exit 2", async () => {
    const { code, stdout, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: bun run review --diff <file>");
  });

  test("unreadable diff file → exit 1 with empty stdout", async () => {
    const { code, stdout, stderr } = await runCli(["--diff", "/nonexistent/diff.patch"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot read diff file");
  });

  test("session rejection → exit 1, empty stdout, stderr diagnostic", async () => {
    sessionError = new Error("provider boom");
    const { code, stdout, stderr } = await runCli(["--diff", FIXTURE]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("review: session failed:");
    expect(stderr).toContain("provider boom");
  });
});
