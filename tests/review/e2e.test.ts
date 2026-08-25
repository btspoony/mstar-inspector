/**
 * End-to-end tests for reviewDiff + CLI (plan 02 Task 3).
 *
 * The @oh-my-pi/pi-coding-agent SDK boundary is mocked (same technique as
 * session.test.ts) so the tests are deterministic: the fake session returns
 * a controllable raw assistant text. Contract under test:
 *   - reviewDiff(sample-pr.diff) → mode "structured" and parseReviewOutput ok
 *   - unparseable raw (non-JSON / missing fields / empty) → mode "summary"
 *     with verdict "comment", findings [], non-empty summary_md, no throw
 *   - CLI main(): exit 0, stdout is ONLY the ReviewOutput JSON (no
 *     {mode, result} envelope); usage error → 2; unreadable file → 1
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Raw assistant text the fake session returns; set per test. */
let rawOutput = "";

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  createAgentSession: mock(async () => ({
    session: {
      prompt: mock(async () => true),
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

import { parseReviewOutput, type ReviewOutput } from "../../src/review/schema";
import { reviewDiff } from "../../src/review/review";
import { main as cliMain } from "../../src/review/run";

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

/** Capture console.log / console.error while a CLI main() call runs. */
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
    const code = await cliMain(argv);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
}

afterEach(() => {
  rawOutput = "";
});

describe("reviewDiff", () => {
  test("sample-pr.diff with valid raw output → structured, parseReviewOutput ok", async () => {
    rawOutput = JSON.stringify(VALID_OUTPUT);
    const { mode, result } = await reviewDiff(sampleDiff);

    expect(mode).toBe("structured");
    expect(result).toEqual(VALID_OUTPUT);
    // The structured result must itself pass parseReviewOutput.
    const parsed = parseReviewOutput(JSON.stringify(result));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.output).toEqual(VALID_OUTPUT);
    }
  });

  test("non-JSON raw output → summary mode, no throw", async () => {
    rawOutput = "I reviewed the diff. Everything looks fine, no blocking issues.";
    const { mode, result } = await reviewDiff(sampleDiff);

    expect(mode).toBe("summary");
    expect(result.verdict).toBe("comment");
    expect(result.findings).toEqual([]);
    expect(result.summary_md.length).toBeGreaterThan(0);
    expect(result.summary_md).toBe(rawOutput);
  });

  test("JSON missing required fields → summary mode, no throw", async () => {
    // Missing summary_md (schema requires it) — valid JSON, invalid ReviewOutput.
    rawOutput = JSON.stringify({ verdict: "comment", findings: [] });
    const { mode, result } = await reviewDiff(sampleDiff);

    expect(mode).toBe("summary");
    expect(result.verdict).toBe("comment");
    expect(result.findings).toEqual([]);
    expect(result.summary_md.length).toBeGreaterThan(0);
    expect(result.summary_md).toBe(rawOutput);
  });

  test("empty raw output → summary mode with fixed fallback text", async () => {
    rawOutput = "";
    const { mode, result } = await reviewDiff(sampleDiff);

    expect(mode).toBe("summary");
    expect(result.verdict).toBe("comment");
    expect(result.findings).toEqual([]);
    expect(result.summary_md).toBe("Review output could not be parsed.");
  });

  test("fixture contains at least one diff --git block", () => {
    expect(sampleDiff).toContain("diff --git");
  });
});

describe("CLI (src/review/run.ts)", () => {
  test("--diff <file> exits 0 and prints ONLY the ReviewOutput JSON", async () => {
    rawOutput = JSON.stringify(VALID_OUTPUT);
    const { code, stdout, stderr } = await runCli(["--diff", FIXTURE]);

    expect(code).toBe(0);
    // stdout is exactly one ReviewOutput JSON object — no {mode, result} envelope.
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("mode");
    expect(parsed).toHaveProperty("verdict");
    expect(parsed).toHaveProperty("summary_md");
    expect(parsed).toHaveProperty("findings");
    expect(parsed.verdict).toBe("request_changes");
    // Diagnostics go to stderr, not stdout.
    expect(stderr).toContain("review mode: structured");
  });

  test("summary mode still exits 0 with a valid ReviewOutput on stdout", async () => {
    rawOutput = "not json at all";
    const { code, stdout, stderr } = await runCli(["--diff", FIXTURE]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as ReviewOutput;
    expect(parsed.verdict).toBe("comment");
    expect(parsed.findings).toEqual([]);
    expect(parsed.summary_md.length).toBeGreaterThan(0);
    expect(stderr).toContain("review mode: summary");
  });

  test("missing --diff flag → usage error, exit 2", async () => {
    const { code, stdout, stderr } = await runCli([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: bun run review --diff <file>");
  });

  test("unreadable diff file → exit 1", async () => {
    const { code, stdout, stderr } = await runCli(["--diff", "/nonexistent/diff.patch"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot read diff file");
  });
});
