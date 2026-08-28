/**
 * GitOps command builder tests (plan 06 QC fix round 1 / qc2 F-001) — the
 * shell-injection surface. Every payload-derived field (owner/repo/prNumber/
 * cloneDir) must be allowlisted and single-quoted before interpolation; any
 * metacharacter fails closed with a descriptive error BEFORE a shell string
 * is built. Pure functions — no mocks, static imports.
 *
 * Wave A (bugbot A2): the clone now checks out the LIVE PR head
 * (`pull/<n>/head`) instead of a pinned sha — the authoritative sha is read
 * back with checkedOutShaCommand, so clone/diff/commit_id always agree.
 */

import { describe, expect, test } from "bun:test";
import {
  buildGitOpsCommands,
  checkedOutShaCommand,
  cloneCommand,
  diffCommand,
  numstatCommand,
  runnerCommand,
  writeJsonCommand,
} from "../../src/pipeline/gitops";

describe("gitops command builders", () => {
  test("valid inputs produce single-quoted, allowlisted commands", () => {
    expect(cloneCommand("acme", "widgets", 42, "/workspace/repo")).toBe(
      [
        "rm -rf '/workspace/repo'",
        "git init '/workspace/repo'",
        "cd '/workspace/repo'",
        "git remote add origin 'https://github.com/acme/widgets.git'",
        "git fetch --depth 1 origin 'pull/42/head'",
        "git checkout FETCH_HEAD",
      ].join(" && "),
    );
    expect(checkedOutShaCommand("/workspace/repo")).toBe("git -C '/workspace/repo' rev-parse HEAD");
    expect(diffCommand("acme", "widgets", 42, "/workspace/pr.diff")).toBe(
      "gh pr diff '42' --repo 'acme/widgets' > '/workspace/pr.diff'",
    );
    // Plan 07 T5: the runner consumes the runtime envelope path — --level +
    // --input reconFacts JSON; the diff feeds the numstat partition universe.
    expect(numstatCommand("/workspace/pr.diff")).toBe("git apply --numstat '/workspace/pr.diff'");
    expect(writeJsonCommand("/workspace/review-input.json", "eyJhIjoxfQ==")).toBe(
      "printf '%s' 'eyJhIjoxfQ==' | base64 -d > '/workspace/review-input.json'",
    );
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "default", "/workspace/review-input.json")).toBe(
      "bun run '/opt/runner/src/review/runner.ts' --level 'default' --input '/workspace/review-input.json'",
    );
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "quick", "/workspace/review-input.json")).toBe(
      "bun run '/opt/runner/src/review/runner.ts' --level 'quick' --input '/workspace/review-input.json'",
    );
  });

  test("writeJsonCommand rejects non-base64 content before any shell string is built", () => {
    expect(() => writeJsonCommand("/workspace/review-input.json", "a'; rm -rf / #")).toThrow(
      /unsafe base64 content/,
    );
    expect(() => writeJsonCommand("/workspace/review-input.json", "ey Jh")).toThrow(/unsafe base64 content/);
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
    expect(cmds.checkedOutSha).toBe("git -C '/workspace/repo' rev-parse HEAD");
    expect(cmds.diff).toBe("gh pr diff '7' --repo 'my-org.example/repo_name-2' > '/workspace/pr.diff'");
    expect(cmds.numstat).toBe("git apply --numstat '/workspace/pr.diff'");
    expect(cmds.runner).toBe(
      "bun run '/opt/runner/src/review/runner.ts' --level 'default' --input '/workspace/review-input.json'",
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
