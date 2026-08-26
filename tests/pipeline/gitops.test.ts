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
  runnerCommand,
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
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "/workspace/pr.diff")).toBe(
      "bun run '/opt/runner/src/review/runner.ts' --diff '/workspace/pr.diff'",
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
    });
    expect(cmds.clone).toContain("origin 'https://github.com/my-org.example/repo_name-2.git'");
    expect(cmds.clone).toContain("origin 'pull/7/head'");
    expect(cmds.checkedOutSha).toBe("git -C '/workspace/repo' rev-parse HEAD");
    expect(cmds.diff).toBe("gh pr diff '7' --repo 'my-org.example/repo_name-2' > '/workspace/pr.diff'");
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
        }),
      ).toThrow(/unsafe prNumber/);
    });
  });
});
