/**
 * GitOps command builder tests (plan 06 QC fix round 1 / qc2 F-001) — the
 * shell-injection surface. Every payload-derived field (owner/repo/headSha/
 * prNumber) must be allowlisted and single-quoted before interpolation; any
 * metacharacter fails closed with a descriptive error BEFORE a shell string
 * is built. Pure functions — no mocks, static imports.
 */

import { describe, expect, test } from "bun:test";
import {
  buildGitOpsCommands,
  cloneCommand,
  diffCommand,
  resolveHeadShaCommand,
  runnerCommand,
} from "../../src/pipeline/gitops";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("gitops command builders", () => {
  test("valid inputs produce single-quoted, allowlisted commands", () => {
    expect(resolveHeadShaCommand("acme", "widgets", 42)).toBe(
      "gh pr view '42' --repo 'acme/widgets' --json headRefOid --jq .headRefOid",
    );
    expect(cloneCommand("acme", "widgets", SHA, "/workspace/repo")).toBe(
      [
        "rm -rf '/workspace/repo'",
        "git init '/workspace/repo'",
        "cd '/workspace/repo'",
        "git remote add origin 'https://github.com/acme/widgets.git'",
        `git fetch --depth 1 origin '${SHA}'`,
        "git checkout FETCH_HEAD",
      ].join(" && "),
    );
    expect(diffCommand("acme", "widgets", 42, "/workspace/pr.diff")).toBe(
      "gh pr diff '42' --repo 'acme/widgets' > '/workspace/pr.diff'",
    );
    expect(runnerCommand("/opt/runner/src/review/runner.ts", "/workspace/pr.diff")).toBe(
      "bun run '/opt/runner/src/review/runner.ts' --diff '/workspace/pr.diff'",
    );
  });

  test("buildGitOpsCommands accepts dotted/dashed GitHub names and 64-char shas", () => {
    const cmds = buildGitOpsCommands({
      owner: "my-org.example",
      repo: "repo_name-2",
      prNumber: 7,
      headSha: SHA_64,
      cloneDir: "/workspace/repo",
      diffPath: "/workspace/pr.diff",
      runnerPath: "/opt/runner/src/review/runner.ts",
    });
    expect(cmds.clone).toContain("origin 'https://github.com/my-org.example/repo_name-2.git'");
    expect(cmds.clone).toContain(`origin '${SHA_64}'`);
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
    const evilShas = [
      "deadbeef;echo pwned",
      "DEADBEEF0123456789abcdef0123456789abcdef", // uppercase is not hex for this check
      "abc", // too short
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // non-hex
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0", // 65 chars
      "0123456789abcdef0123456789abcdef0123456;", // hex prefix + metachar
    ];
    const evilPrs = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const owner of evilOwners) {
      test(`resolveHeadShaCommand rejects owner ${JSON.stringify(owner)}`, () => {
        expect(() => resolveHeadShaCommand(owner, "widgets", 42)).toThrow(/unsafe owner/);
      });
      test(`cloneCommand rejects owner ${JSON.stringify(owner)}`, () => {
        expect(() => cloneCommand(owner, "widgets", SHA, "/workspace/repo")).toThrow(/unsafe owner/);
      });
      test(`diffCommand rejects owner ${JSON.stringify(owner)}`, () => {
        expect(() => diffCommand(owner, "widgets", 42, "/workspace/pr.diff")).toThrow(/unsafe owner/);
      });
    }
    for (const repo of evilRepos) {
      test(`resolveHeadShaCommand rejects repo ${JSON.stringify(repo)}`, () => {
        expect(() => resolveHeadShaCommand("acme", repo, 42)).toThrow(/unsafe repo/);
      });
      test(`diffCommand rejects repo ${JSON.stringify(repo)}`, () => {
        expect(() => diffCommand("acme", repo, 42, "/workspace/pr.diff")).toThrow(/unsafe repo/);
      });
    }
    for (const sha of evilShas) {
      test(`cloneCommand rejects headSha ${JSON.stringify(sha)}`, () => {
        expect(() => cloneCommand("acme", "widgets", sha, "/workspace/repo")).toThrow(/unsafe headSha/);
      });
    }
    for (const pr of evilPrs) {
      test(`resolveHeadShaCommand rejects prNumber ${String(pr)}`, () => {
        expect(() => resolveHeadShaCommand("acme", "widgets", pr)).toThrow(/unsafe prNumber/);
      });
    }

    test("buildGitOpsCommands rejects a metacharacter-laden headSha before any command is built", () => {
      expect(() =>
        buildGitOpsCommands({
          owner: "acme",
          repo: "widgets",
          prNumber: 42,
          headSha: "deadbeef;echo pwned",
          cloneDir: "/workspace/repo",
          diffPath: "/workspace/pr.diff",
          runnerPath: "/opt/runner/src/review/runner.ts",
        }),
      ).toThrow(/unsafe headSha/);
    });
  });
});
