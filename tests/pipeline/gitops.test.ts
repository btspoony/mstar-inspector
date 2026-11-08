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

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BOUNDED_READ_ABSENT_FLAG,
  boundedFileReadCommand,
  buildGitOpsCommands,
  checkedOutShaCommand,
  cloneCommand,
  compareStatusCommand,
  DIFF_PATH,
  DIFF_PREFETCH_MAX_BYTES,
  diffCommand,
  fetchDepthOneCommand,
  gitTransportEnv,
  incrementDiffCommand,
  isDiffTooLarge,
  issueViewCommand,
  localDiffCommand,
  mergeBaseCommand,
  numstatCommand,
  prBodyCommand,
  pullRequestBaseRefCommand,
  readRecheckCommand,
  readRecheckStatusCommand,
  readReportCommand,
  runnerCommand,
  writeJsonCommand,
} from "../../src/pipeline/gitops";
import { shellCommand } from "../../src/pipeline/shell-command";
import { RECHECK_FILE_MAX_BYTES } from "../../packages/shared/src/recheck-wire";
import { REPORT_FILE_MAX_BYTES } from "../../packages/shared/src/report-wire";

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
    expect(writeJsonCommand("/workspace/review-input.json")).toBe(
      shellCommand("base64 -d > '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/packages/runner/src/runner.ts", "default", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/packages/runner/src/runner.ts' --level 'default' --input '/workspace/review-input.json'"),
    );
    expect(runnerCommand("/opt/runner/packages/runner/src/runner.ts", "quick", "/workspace/review-input.json")).toBe(
      shellCommand("bun run '/opt/runner/packages/runner/src/runner.ts' --level 'quick' --input '/workspace/review-input.json'"),
    );
  });

  test("writeJsonCommand rejects an unallowlisted path before any shell string is built", () => {
    for (const evil of [
      "relative/review-input.json",
      "/workspace/../etc/review-input.json",
      "/workspace/x; rm -rf / #",
      "/workspace/a b",
      "/workspace/recheck'",
      "",
    ]) {
      expect(() => writeJsonCommand(evil)).toThrow(/unsafe write path/);
    }
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
        {
          // The report read wraps the same transport in its absence probe: an
          // EXISTING file must still take the unchanged bounded read.
          name: "report",
          maxBytes: REPORT_FILE_MAX_BYTES,
          command: (path: string) => readReportCommand(path),
          fit: JSON.stringify({ schema: "mstar.report/v1" }),
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

  test("incrementDiffCommand replaces the diff file only after a delivered capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mstar-increment-"));
    try {
      // A stub compare API: it records the request it was asked for, answers
      // with the file named by GH_ANSWER_FILE, and otherwise refuses with
      // nothing on stdout — the way the real 406 does.
      const answer = join(dir, "answer.diff");
      const argv = join(dir, "gh-argv");
      await Bun.write(
        join(dir, "gh"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n[ -n "$GH_ANSWER_FILE" ] && cat "$GH_ANSWER_FILE"\nexit "\${GH_EXIT:-0}"\n`,
      );
      Bun.spawnSync(["chmod", "+x", join(dir, "gh")]);

      const diffPath = join(dir, "pr.diff");
      const previous = "diff --git a/full b/full\n@@ -1 +1 @@\n-full\n+full\n";
      const increment = "diff --git a/delta b/delta\n@@ -1 +1 @@\n-a\n+b\n";
      const base = "a".repeat(40);
      const head = "b".repeat(40);
      const command = incrementDiffCommand("acme", "widgets", base, head, diffPath);
      const run = async (env: Record<string, string>) => {
        const proc = Bun.spawn(["sh", "-c", command], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
        });
        return { exitCode: await proc.exited, stdout: await new Response(proc.stdout).text() };
      };

      // REFUSED capture: the full diff this round already wrote stays intact,
      // so a refused increment degrades to a full-diff round instead of an
      // empty one. The delivery ORDER is what this pins: redirecting straight
      // into `diffPath` would truncate it before the refusal lands.
      await Bun.write(diffPath, previous);
      const refused = await run({ GH_EXIT: "1" });
      expect(refused.exitCode).not.toBe(0);
      expect(await Bun.file(diffPath).text()).toBe(previous);

      // DELIVERED capture: the increment replaces the file completely — no
      // byte of the full diff survives — and the bounded read after it
      // answers fit (flag 0) over the same file.
      await Bun.write(answer, increment);
      const delivered = await run({ GH_EXIT: "0", GH_ANSWER_FILE: answer });
      expect(delivered.exitCode).toBe(0);
      expect(await Bun.file(diffPath).text()).toBe(increment);
      const lines = delivered.stdout.trimEnd().split("\n");
      expect(lines.at(-1)!.trim()).toBe("0");
      expect(lines.slice(0, -1).join("\n")).toBe(increment);

      // The three-dot form is the one `compare` reports `ahead` for, so the two
      // steps agree by construction.
      expect(await Bun.file(argv).text()).toContain(`repos/acme/widgets/compare/${base}...${head}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the oversized-diff fallback resolves the base ref and merge base, then diffs the clone locally", () => {
    const head = "b".repeat(40);
    const mergeBase = "c".repeat(40);
    expect(pullRequestBaseRefCommand("acme", "widgets", 42)).toBe(
      shellCommand(`gh api 'repos/acme/widgets/pulls/42' --jq '.base.ref'`),
    );
    expect(mergeBaseCommand("acme", "widgets", "release/1.9", head)).toBe(
      shellCommand(`gh api 'repos/acme/widgets/compare/release/1.9...${head}' --jq '.merge_base_commit.sha'`),
    );
    expect(fetchDepthOneCommand("/workspace/repo", mergeBase)).toBe(
      shellCommand(`git -C '/workspace/repo' fetch --depth 1 origin '${mergeBase}'`),
    );
    // The local capture is the SAME bounded read `diffCommand` carries — one
    // transport, so the overflow contract cannot drift between the two.
    expect(localDiffCommand("/workspace/repo", mergeBase, head, DIFF_PATH)).toBe(
      shellCommand(
        `git -C '/workspace/repo' diff '${mergeBase}' '${head}' > '${DIFF_PATH}' && ` +
          boundedFileReadCommand(DIFF_PATH, DIFF_PREFETCH_MAX_BYTES),
      ),
    );
  });

  test("isDiffTooLarge accepts the 406 ceiling token or GitHub's wording — an auth or transport fault is not it", () => {
    expect(
      isDiffTooLarge(
        "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) (https://api.github.com/repos/acme/widgets/pulls/42)",
      ),
    ).toBe(true);
    expect(isDiffTooLarge('{"message":"too_large"}')).toBe(true);
    expect(isDiffTooLarge("GraphQL: too_large")).toBe(true);
    // The status TOKEN alone is enough: GitHub rewriting the prose must not
    // silently reopen the repeat-failure it took the fallback out of.
    expect(isDiffTooLarge("HTTP 406: Not Acceptable")).toBe(true);
    for (const other of [
      "",
      "HTTP 401: Bad credentials (https://api.github.com/repos/acme/widgets/pulls/42)",
      "HTTP 404: Not Found (https://api.github.com/repos/acme/widgets/pulls/42)",
      "dial tcp 140.82.112.3:443: connect: connection refused",
      "error: RPC failed; curl 56 GnuTLS recv error",
      // The token inside gh's trailing URL is a REPO NAME, not the ceiling:
      // every failure of `auth_too_large` would otherwise take the fallback.
      "HTTP 401: Bad credentials (https://api.github.com/repos/acme/auth_too_large/pulls/42)",
      "HTTP 500: Server Error (https://api.github.com/repos/too_large/widgets/pulls/42)",
      // …and a 406 that only appears in the URL is not the status either.
      "HTTP 404: Not Found (https://api.github.com/repos/acme/widgets/pulls/406)",
      // A longer word that merely contains it is not the token either.
      "HTTP 422: too_larger request",
      "HTTP 4060: not a status",
    ]) {
      expect(isDiffTooLarge(other)).toBe(false);
    }
  });

  test("a base ref must stay a plain branch ref — traversal and option-form refs fail closed", () => {
    const head = "b".repeat(40);
    for (const evil of ["", "-main", "main..evil", "../../etc", "main; rm -rf /", "re lease", "main'", "`main`"]) {
      expect(() => mergeBaseCommand("acme", "widgets", evil, head)).toThrow(/unsafe base ref/);
    }
    // A ref GitHub can really report is accepted (slashes and dots are branch syntax).
    expect(mergeBaseCommand("acme", "widgets", "release/1.9_hotfix", head)).toContain(
      "/compare/release/1.9_hotfix...",
    );
    // Every sha argument keeps the hex guard.
    for (const evil of ["", "ABC", "../../etc", "b".repeat(40) + ";rm -rf /", "zzzzzzz", "b".repeat(65)]) {
      expect(() => mergeBaseCommand("acme", "widgets", "main", evil)).toThrow(/unsafe head sha/);
      expect(() => fetchDepthOneCommand("/workspace/repo", evil)).toThrow(/unsafe fetch sha/);
      expect(() => localDiffCommand("/workspace/repo", evil, head, DIFF_PATH)).toThrow(/unsafe merge base sha/);
      expect(() => localDiffCommand("/workspace/repo", "c".repeat(40), evil, DIFF_PATH)).toThrow(/unsafe head sha/);
    }
  });

  test("gitTransportEnv is the ONE extraheader definition the clone and the fallback fetch share", () => {
    expect(gitTransportEnv("ghs_installation_token")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa("x-access-token:ghs_installation_token")}`,
    });
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

  test("readReportCommand proves an absent document — a missing file is not a broken read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mstar-report-read-"));
    try {
      const path = join(dir, "report.json");
      // Nothing written: the seat produced no document. The command's own
      // probe answers with the absent flag line and a ZERO exit, so this can
      // never be confused with a read that failed (which exits non-zero).
      const absent = Bun.spawn(["sh", "-c", readReportCommand(path)]);
      const absentStdout = await new Response(absent.stdout).text();
      expect(await absent.exited).toBe(0);
      const lines = absentStdout.trimEnd().split("\n");
      expect(lines.pop()?.trim()).toBe(BOUNDED_READ_ABSENT_FLAG);
      expect(lines.join("\n")).toBe("");

      // A path that EXISTS but cannot be read as a file (here: a directory)
      // keeps failing closed — no flag line, non-zero exit — so a read fault
      // is never reported as an absence.
      const dirPath = join(dir, "as-directory");
      await mkdir(dirPath);
      const broken = Bun.spawn(["sh", "-c", readReportCommand(dirPath)], { stderr: "pipe" });
      expect(await broken.exited).not.toBe(0);
      expect(await new Response(broken.stdout).text()).toBe("");
      expect(await new Response(broken.stderr).text()).not.toBe("");

      // Same path allowlist as the other reads: no metacharacters, absolute only.
      // The rejection is the shared bounded-read guard's, so the assertion is the
      // rejection itself, not the label it happens to carry.
      expect(() => readReportCommand("/tmp/a b")).toThrow(/unsafe/);
      expect(() => readReportCommand("relative/report.json")).toThrow(/unsafe/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
