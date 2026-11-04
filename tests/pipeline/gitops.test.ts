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
  boundedFileReadCommand,
  buildGitOpsCommands,
  checkedOutShaCommand,
  cloneCommand,
  compareStatusCommand,
  DIFF_PATH,
  DIFF_PREFETCH_MAX_BYTES,
  diffCommand,
  incrementDiffCommand,
  issueViewCommand,
  numstatCommand,
  prBodyCommand,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  runnerCommand,
  writeJsonCommand,
} from "../../src/pipeline/gitops";
import { shellCommand } from "../../src/pipeline/shell-command";
import { RECHECK_FILE_MAX_BYTES } from "../../packages/shared/src/recheck-wire";
import { REPORT_FILE_MAX_BYTES, REPORT_OUTPUT_PATH } from "../../packages/shared/src/report-wire";

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
    // The diff is written to the numstat file AND streamed back bounded: the
    // capture is the exec's stdout, so the file redirect alone (empty stdout)
    // could never feed the evidence catalog.
    expect(diffCommand("acme", "widgets", 42, "/workspace/pr.diff")).toBe(
      shellCommand(
        "gh pr diff '42' --repo 'acme/widgets' > '/workspace/pr.diff' && " +
          `head -c '${DIFF_PREFETCH_MAX_BYTES}' '/workspace/pr.diff' && printf '\\n' && ` +
          `tail -c '+${DIFF_PREFETCH_MAX_BYTES + 1}' '/workspace/pr.diff' | head -c '1' | wc -c`,
      ),
    );
    // the runner consumes the runtime envelope path — --level +
    // --input reconFacts JSON; the diff feeds the numstat partition universe.
    expect(numstatCommand("/workspace/pr.diff")).toBe(shellCommand("git apply --numstat '/workspace/pr.diff'"));
    expect(writeJsonCommand("/workspace/review-input.json", "eyJhIjoxfQ==")).toBe(
      shellCommand("printf '%s' 'eyJhIjoxfQ==' | base64 -d > '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/packages/runner/src/runner.ts", "default", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/packages/runner/src/runner.ts' --level 'default' --input '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/packages/runner/src/runner.ts", "quick", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/packages/runner/src/runner.ts' --level 'quick' --input '/workspace/review-input.json'"),
    );
  });

  test("writeJsonCommand rejects non-base64 content before any shell string is built", () => {
    expect(() => writeJsonCommand("/workspace/review-input.json", "a'; rm -rf / #")).toThrow(
      /unsafe base64 content/,
    );
    expect(() => writeJsonCommand("/workspace/review-input.json", "ey Jh")).toThrow(/unsafe base64 content/);
  });

  test("readRecheckCommand bounds the read at RECHECK_FILE_MAX_BYTES and probes for overflow", () => {
    // Fixed audited path shape: head stops the content stream at the bound,
    // tail probes byte bound+1 → last line 1 = overflow, 0 = exact fit.
    expect(readRecheckCommand("/tmp/mstar-recheck.json")).toBe(
      shellCommand(
        `head -c '${RECHECK_FILE_MAX_BYTES}' '/tmp/mstar-recheck.json' && printf '\\n' && ` +
          `tail -c '+${RECHECK_FILE_MAX_BYTES + 1}' '/tmp/mstar-recheck.json' | head -c '1' | wc -c`,
      ),
    );
  });

  test("the bounded read rejects metacharacter-laden and relative paths fail-closed", () => {
    for (const evil of [
      "/tmp/x; rm -rf /",
      "/tmp/$(id)",
      "/tmp/a b",
      "/tmp/recheck'",
      "relative/recheck.json",
      "",
    ]) {
      expect(() => readRecheckCommand(evil)).toThrow(/unsafe bounded read path/);
      // Same shared builder, same guard: the diff capture path is allowlisted
      // too (it used to be interpolated with only single quotes).
      expect(() => diffCommand("acme", "widgets", 42, evil)).toThrow(/unsafe bounded read path/);
    }
  });

  test("every bounded read emits content + newline + newline-terminated flag (P67-QC-006)", async () => {
    // ONE oracle over every caller of the shared bounded-read builder: the
    // recheck document read, the status read and the diff capture (whose
    // redirect half needs gh, so only its read half runs here). The parser and
    // the Worker's test double both assume a NEWLINE-TERMINATED overflow flag
    // (`wc -c` writes its own trailing newline). Running the built strings
    // through a local POSIX shell against real files turns that assumption
    // into evidence — no network, no GitHub. Every fixture lives under a
    // private mkdtemp: no test writes a production path, so a crashed run can
    // never clobber a real /tmp document.
    const dir = await mkdtemp(join(tmpdir(), "mstar-bounded-read-"));
    try {
      for (const read of [
        {
          // The identity rides the filename, so each entry owns its fixture.
          name: "recheck-doc",
          maxBytes: RECHECK_FILE_MAX_BYTES,
          command: (path: string) => readRecheckCommand(path),
          fit: JSON.stringify({ schema: "mstar.recheck/v1", headSha: "x", results: [] }),
        },
        {
          name: "recheck-status",
          maxBytes: RECHECK_FILE_MAX_BYTES,
          command: (path: string) => readRecheckStatusCommand(path),
          fit: JSON.stringify({
            schema: "mstar.recheck-status/v1",
            headSha: "x",
            outcome: "ok",
            rejected: 0,
            rejected_row_ids: [],
            rejected_unnamed: 0,
            reason: null,
            error: null,
          }),
        },
        {
          name: "diff",
          maxBytes: DIFF_PREFETCH_MAX_BYTES,
          command: (path: string) => boundedFileReadCommand(path, DIFF_PREFETCH_MAX_BYTES),
          fit: "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1,2 +1,3 @@\n+a\n b\n",
        },
      ]) {
        const overflowText = "b".repeat(read.maxBytes + 1);
        // The bound ITSELF is still a fit: the probe starts at byte bound+1, so
        // content of exactly maxBytes must report flag 0. An off-by-one tail
        // (`+maxBytes`) would flag an at-bound capture as overflow and throw
        // away text the command had already delivered in full.
        const atBoundText = "b".repeat(read.maxBytes);
        for (const { label, text, flag, content } of [
          { label: "fits", text: read.fit, flag: "0", content: read.fit },
          { label: "at-bound", text: atBoundText, flag: "0", content: atBoundText },
          { label: "over-bound", text: overflowText, flag: "1", content: overflowText.slice(0, read.maxBytes) },
        ]) {
          const path = join(dir, `${read.name}-${label}.json`);
          await Bun.write(path, text);
          const proc = Bun.spawn(["sh", "-c", read.command(path)]);
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
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("compareStatusCommand reads the compare verdict through gh's --jq surface", () => {
    expect(compareStatusCommand("acme", "widgets", "a".repeat(40), "b".repeat(40))).toBe(
      shellCommand(`gh api 'repos/acme/widgets/compare/${"a".repeat(40)}...${"b".repeat(40)}' --jq '.status'`),
    );
  });

  test("incrementDiffCommand captures base...head with the SAME bounded read as the PR diff", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    expect(incrementDiffCommand("acme", "widgets", base, head, DIFF_PATH)).toBe(
      shellCommand(
        `gh api -H 'Accept: application/vnd.github.v3.diff' 'repos/acme/widgets/compare/${base}...${head}' > '${DIFF_PATH}' && ` +
          `head -c '${DIFF_PREFETCH_MAX_BYTES}' '${DIFF_PATH}' && printf '\\n' && ` +
          `tail -c '+${DIFF_PREFETCH_MAX_BYTES + 1}' '${DIFF_PATH}' | head -c '1' | wc -c`,
      ),
    );
    // The three-dot form is the one `compare` reports `ahead` for, so the two
    // steps agree by construction.
    expect(incrementDiffCommand("acme", "widgets", base, head, DIFF_PATH)).toContain(`/${base}...${head}`);
  });

  test("compareStatusCommand / incrementDiffCommand reject a non-hex sha before any shell string", () => {
    for (const evil of ["", "ABC", "../../etc", "a".repeat(40) + ";rm -rf /", "zzzzzzz", "a".repeat(65)]) {
      expect(() => compareStatusCommand("acme", "widgets", evil, "b".repeat(40))).toThrow(/unsafe base sha/);
      expect(() => compareStatusCommand("acme", "widgets", "a".repeat(40), evil)).toThrow(/unsafe head sha/);
      expect(() => incrementDiffCommand("acme", "widgets", evil, "b".repeat(40), DIFF_PATH)).toThrow(/unsafe base sha/);
      expect(() => incrementDiffCommand("acme", "widgets", "a".repeat(40), evil, DIFF_PATH)).toThrow(/unsafe head sha/);
    }
  });

  test("prBodyCommand / issueViewCommand read through gh's JSON surface, numbers guarded", () => {
    expect(prBodyCommand("acme", "widgets", 42)).toBe(
      shellCommand("gh pr view '42' --repo 'acme/widgets' --json body"),
    );
    expect(issueViewCommand("acme", "widgets", 7)).toBe(
      shellCommand("gh issue view '7' --repo 'acme/widgets' --json number,title,body"),
    );
    expect(() => issueViewCommand("acme", "widgets", 0)).toThrow(/unsafe prNumber/);
    expect(() => prBodyCommand("acme;rm", "widgets", 42)).toThrow(/unsafe owner/);
  });

  test("readReportCommand shares the bounded-read transport with its own byte bound", () => {
    expect(readReportCommand()).toBe(
      shellCommand(
        `head -c '${REPORT_FILE_MAX_BYTES}' '${REPORT_OUTPUT_PATH}' && printf '\\n' && ` +
          `tail -c '+${REPORT_FILE_MAX_BYTES + 1}' '${REPORT_OUTPUT_PATH}' | head -c '1' | wc -c`,
      ),
    );
    // Same path allowlist as the other reads: no metacharacters, absolute only.
    // The rejection is the shared bounded-read guard's, so the assertion is the
    // rejection itself, not the label it happens to carry.
    expect(() => readReportCommand("/tmp/a b")).toThrow(/unsafe/);
    expect(() => readReportCommand("relative/report.json")).toThrow(/unsafe/);
  });

  test("runnerCommand appends --report-out after --recheck-out (both optional, both quoted)", () => {
    expect(
      runnerCommand(
        "/opt/runner/packages/runner/src/runner.ts",
        "quick",
        "/workspace/review-input.json",
        "/tmp/mstar-recheck.json",
        "/tmp/mstar-report.json",
      ),
    ).toBe(
      shellCommand(
        "bun run '/opt/runner/packages/runner/src/runner.ts' --level 'quick' --input '/workspace/review-input.json' " +
          "--recheck-out '/tmp/mstar-recheck.json' --report-out '/tmp/mstar-report.json'",
      ),
    );
    // Report only (no recheck round): the recheck flag is simply absent.
    expect(
      runnerCommand("/opt/runner/packages/runner/src/runner.ts", "quick", "/workspace/review-input.json", undefined, "/tmp/mstar-report.json"),
    ).toBe(
      shellCommand(
        "bun run '/opt/runner/packages/runner/src/runner.ts' --level 'quick' --input '/workspace/review-input.json' " +
          "--report-out '/tmp/mstar-report.json'",
      ),
    );
  });
  test("runnerCommand appends the optional --recheck-out flag quoted", () => {
    expect(
      runnerCommand("/opt/runner/packages/runner/src/runner.ts", "quick", "/workspace/review-input.json", "/tmp/mstar-recheck.json"),
    ).toBe(
      shellCommand(
        "bun run '/opt/runner/packages/runner/src/runner.ts' --level 'quick' --input '/workspace/review-input.json' " +
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
    });
    expect(cmds.clone).toContain("origin 'https://github.com/my-org.example/repo_name-2.git'");
    expect(cmds.clone).toContain("origin 'pull/7/head'");
    expect(cmds.checkedOutSha).toBe(shellCommand("git -C '/workspace/repo' rev-parse HEAD"));
    expect(cmds.diff).toContain("gh pr diff '7' --repo 'my-org.example/repo_name-2' > '/workspace/pr.diff'");
    // The capture is the exec's STDOUT, so the wiring must also carry the
    // bounded read — asserted through the shared builder that defines it, not
    // as a second copy of the command string.
    expect(cmds.diff).toContain(boundedFileReadCommand("/workspace/pr.diff", DIFF_PREFETCH_MAX_BYTES));
    expect(cmds.numstat).toBe(shellCommand("git apply --numstat '/workspace/pr.diff'"));
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
        }),
      ).toThrow(/unsafe prNumber/);
    });
  });
});
