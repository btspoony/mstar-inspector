/**
 * GitOps command builder tests (QC fix round 1 / qc2 F-001) — the
 * shell-injection surface. Every payload-derived field (owner/repo/prNumber/
 * cloneDir) must be allowlisted and single-quoted before interpolation; any
 * metacharacter fails closed with a descriptive error BEFORE a shell string
 * is built. Pure functions — no mocks, static imports.
 *
 * Wave A (bugbot A2): the clone now checks out the LIVE PR head
 * (`pull/<n>/head`) instead of a pinned sha — the authoritative sha is read
 * back with checkedOutShaCommand, so clone/diff/commit_id always agree.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildGitOpsCommands,
  checkedOutShaCommand,
  cloneCommand,
  diffCommand,
  numstatCommand,
  readRecheckCommand,
  runnerCommand,
  writeJsonCommand,
} from "../../src/pipeline/gitops";
import { shellCommand } from "../../src/pipeline/shell-command";

describe("gitops command builders", () => {
  test("valid inputs produce single-quoted, allowlisted commands", () => {
    expect(cloneCommand("acme", "widgets", 42, "/workspace/repo")).toBe(
      shellCommand(
        [
          "rm -rf '/workspace/repo'",
          "git init '/workspace/repo'",
          "cd '/workspace/repo'",
          "git remote add origin 'https://github.com/acme/widgets.git'",
          "git fetch --depth 1 origin 'pull/42/head'",
          "git checkout FETCH_HEAD",
        ].join(" && "),
      ),
    );
    expect(checkedOutShaCommand("/workspace/repo")).toBe(shellCommand("git -C '/workspace/repo' rev-parse HEAD"));
    expect(diffCommand("acme", "widgets", 42, "/workspace/pr.diff")).toBe(
      shellCommand("gh pr diff '42' --repo 'acme/widgets' > '/workspace/pr.diff'"),
    );
    // the runner consumes the runtime envelope path — --level +
    // --input reconFacts JSON; the diff feeds the numstat partition universe.
    expect(numstatCommand("/workspace/pr.diff")).toBe(shellCommand("git apply --numstat '/workspace/pr.diff'"));
    expect(writeJsonCommand("/workspace/review-input.json", "eyJhIjoxfQ==")).toBe(
      shellCommand("printf '%s' 'eyJhIjoxfQ==' | base64 -d > '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "default", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/src/review/runner.ts' --level 'default' --input '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "quick", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/src/review/runner.ts' --level 'quick' --input '/workspace/review-input.json'"),
    );
  });

  test("writeJsonCommand rejects non-base64 content before any shell string is built", () => {
    expect(() => writeJsonCommand("/workspace/review-input.json", "a'; rm -rf / #")).toThrow(
      /unsafe base64 content/,
    );
    expect(() => writeJsonCommand("/workspace/review-input.json", "ey Jh")).toThrow(/unsafe base64 content/);
  });

  test("readRecheckCommand bounds the read at 262,144 bytes and probes for overflow", () => {
    // Fixed audited path shape: head stops the content stream at the bound,
    // tail probes byte bound+1 → last line 1 = overflow, 0 = exact fit.
    expect(readRecheckCommand("/tmp/mstar-recheck.json")).toBe(
      shellCommand(
        "head -c '262144' '/tmp/mstar-recheck.json' && printf '\\n' && " +
          "tail -c '+262145' '/tmp/mstar-recheck.json' | head -c '1' | wc -c",
      ),
    );
  });

  test("readRecheckCommand rejects metacharacter-laden and relative paths fail-closed", () => {
    for (const evil of [
      "/tmp/x; rm -rf /",
      "/tmp/$(id)",
      "/tmp/a b",
      "/tmp/recheck'",
      "relative/recheck.json",
      "",
    ]) {
      expect(() => readRecheckCommand(evil)).toThrow(/unsafe recheck output path/);
    }
  });

  test("readRecheckCommand's REAL stdout is content + newline + newline-terminated flag (P67-QC-006)", async () => {
    // The parser and the Worker's test double both assume the shipped command
    // emits a NEWLINE-TERMINATED overflow flag (`wc -c` writes its own trailing
    // newline). Running the built string through a local POSIX shell against
    // real files turns that assumption into evidence — no network, no GitHub.
    const dir = await mkdtemp(join(tmpdir(), "mstar-recheck-read-"));
    try {
      const fit = join(dir, "fit.json");
      const overflow = join(dir, "overflow.json");
      const fitText = JSON.stringify({ schema: "mstar.recheck/v1", headSha: "x", results: [] });
      await Bun.write(fit, fitText);
      await Bun.write(overflow, "b".repeat(262_145));

      for (const [file, flag, content] of [
        [fit, "0", fitText],
        [overflow, "1", "b".repeat(262_144)],
      ] as const) {
        const proc = Bun.spawn(["sh", "-c", readRecheckCommand(file)]);
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        // The stream is newline-terminated and the flag is its LAST LINE;
        // `wc -c` may left-pad the count (BSD) or not (GNU), so the parser
        // trims. A parser that required the flag as the final BYTE — the
        // reviewed defect — fails on every platform and on neither fixture.
        expect(stdout.endsWith("\n")).toBe(true);
        const trimmed = stdout.trimEnd();
        expect(trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim()).toBe(flag);
        expect(trimmed.slice(0, trimmed.lastIndexOf("\n"))).toBe(content);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runnerCommand appends the optional --recheck-out flag quoted", () => {
    expect(
      runnerCommand("/opt/runner/src/review/runner.ts", "quick", "/workspace/review-input.json", "/tmp/mstar-recheck.json"),
    ).toBe(
      shellCommand(
        "bun run '/opt/runner/src/review/runner.ts' --level 'quick' --input '/workspace/review-input.json' " +
          "--recheck-out '/tmp/mstar-recheck.json'",
      ),
    );
  });

  test("buildGitOpsCommands accepts dotted/dashed GitHub names and a high pr number", () => {
    const cmds = buildGitOpsCommands({
      owner: "my-org.example",
      repo: "repo_name-2",
      prNumber: 7,
      cloneDir: "/workspace/repo",
      diffPath: "/workspace/pr.diff",
      runnerPath: "/opt/runner/src/review/runner.ts",
      level: "default",
      inputPath: "/workspace/review-input.json",
    });
    expect(cmds.clone).toContain("origin 'https://github.com/my-org.example/repo_name-2.git'");
    expect(cmds.clone).toContain("origin 'pull/7/head'");
    expect(cmds.checkedOutSha).toBe(shellCommand("git -C '/workspace/repo' rev-parse HEAD"));
    expect(cmds.diff).toBe(shellCommand("gh pr diff '7' --repo 'my-org.example/repo_name-2' > '/workspace/pr.diff'"));
    expect(cmds.numstat).toBe(shellCommand("git apply --numstat '/workspace/pr.diff'"));
    expect(cmds.runner).toBe(
      shellCommand("bun run '/opt/runner/src/review/runner.ts' --level 'default' --input '/workspace/review-input.json'"),
    );
  });

  describe("injection rejection (fail closed before any shell string is built)", () => {
    const evilOwners = [
      "acme;rm -rf /",
      "acme$(id)",
      "acme`id`",
      "ac me",
      "acme'",
      "acme&&echo pwned",
      "acme|cat /etc/passwd",
    ];
    const evilRepos = ["widgets;echo pwned", "widgets$(id)", "widgets`id`", "my repo", "widgets'", "widgets|sh"];
    const evilPrs = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const owner of evilOwners) {
      test(`cloneCommand rejects owner ${JSON.stringify(owner)}`, () => {
        expect(() => cloneCommand(owner, "widgets", 42, "/workspace/repo")).toThrow(/unsafe owner/);
      });
      test(`diffCommand rejects owner ${JSON.stringify(owner)}`, () => {
        expect(() => diffCommand(owner, "widgets", 42, "/workspace/pr.diff")).toThrow(/unsafe owner/);
      });
    }
    for (const repo of evilRepos) {
      test(`cloneCommand rejects repo ${JSON.stringify(repo)}`, () => {
        expect(() => cloneCommand("acme", repo, 42, "/workspace/repo")).toThrow(/unsafe repo/);
      });
      test(`diffCommand rejects repo ${JSON.stringify(repo)}`, () => {
        expect(() => diffCommand("acme", repo, 42, "/workspace/pr.diff")).toThrow(/unsafe repo/);
      });
    }
    for (const pr of evilPrs) {
      test(`cloneCommand rejects prNumber ${String(pr)}`, () => {
        expect(() => cloneCommand("acme", "widgets", pr, "/workspace/repo")).toThrow(/unsafe prNumber/);
      });
    }

    test("buildGitOpsCommands rejects a metacharacter-laden owner before any command is built", () => {
      expect(() =>
        buildGitOpsCommands({
          owner: "acme;rm -rf /",
          repo: "widgets",
          prNumber: 42,
          cloneDir: "/workspace/repo",
          diffPath: "/workspace/pr.diff",
          runnerPath: "/opt/runner/src/review/runner.ts",
          level: "quick",
          inputPath: "/workspace/review-input.json",
        }),
      ).toThrow(/unsafe owner/);
    });

    test("buildGitOpsCommands rejects a non-positive prNumber", () => {
      expect(() =>
        buildGitOpsCommands({
          owner: "acme",
          repo: "widgets",
          prNumber: -1,
          cloneDir: "/workspace/repo",
          diffPath: "/workspace/pr.diff",
          runnerPath: "/opt/runner/src/review/runner.ts",
          level: "quick",
          inputPath: "/workspace/review-input.json",
        }),
      ).toThrow(/unsafe prNumber/);
    });
  });
});
