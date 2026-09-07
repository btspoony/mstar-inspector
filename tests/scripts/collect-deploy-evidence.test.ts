/**
 * `scripts/collect-deploy-evidence.ts` unit tests (plan 52 T1 / D1 / D3).
 *
 * The GH-touching layer is injected (`GhRunner` + fake clock/sleep), so the
 * wait/match/timeout decision logic is pinned without `gh`, network, or real
 * time. The fake clock advances only inside `sleep` — polls are
 * instantaneous, so a 90 s window at 30 s interval deterministically polls
 * at t=0,30,60,90 (4 polls, 3 sleeps).
 *
 * Branch matrix (plan 52 §Clarify / AC1):
 * - success: run concludes success -> artifact read -> Worker Version ID +
 *   image digest + run link (bare id without the GitHub env pair);
 * - deploy-failed: explicit failed section with conclusion + run link;
 * - pending: timeout with run in flight -> explicit pending section + link;
 * - no-run: nothing for the SHA after the window -> explicit no-run section;
 * - degraded: gh error / artifact download failure / artifact shape ->
 *   section noting the error.
 *
 * Exit-code invariant: runCli returns 0 for EVERY runtime outcome (evidence
 * absence never fails the release); 1 is usage-errors only.
 */
import { describe, expect, test } from "bun:test";
import {
  DEPLOY_EVIDENCE_ARTIFACT,
  type CliDeps,
  collectDeployEvidence,
  type CollectOptions,
  type GhRun,
  type GhRunner,
  parseArgs,
  runCli,
} from "../../scripts/collect-deploy-evidence";
import { disposeTempRoot, makeTempRoot, writeAt } from "./helpers";

const SHA = "1f2e3d4c5b6a79880112233445566778899a00bc";
const OTHER_SHA = "0000000000000000000000000000000000000001";

const IN_FLIGHT: GhRun = {
  databaseId: 123456,
  status: "in_progress",
  conclusion: null,
  displayTitle: "Deploy main",
};
const SUCCESS: GhRun = {
  databaseId: 123456,
  status: "completed",
  conclusion: "success",
  displayTitle: "Deploy main",
};
const FAILED: GhRun = {
  databaseId: 123456,
  status: "completed",
  conclusion: "failure",
  displayTitle: "Deploy main",
};

const VERSION_ID = "11112222-3333-4444-5555-666677778888";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const RUN_URL = "https://github.com/acme/mstar-inspector/actions/runs/123456";
const GH_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/mstar-inspector",
};

/** Recording fake: `listRuns(poll, sha)` decides per poll; `download` materializes artifact files. */
function makeRunner(
  listRuns: (poll: number, sha: string) => GhRun[],
  download?: (runId: number, destDir: string) => void,
): { runner: GhRunner; polls: string[]; downloads: { runId: number; destDir: string }[] } {
  const polls: string[] = [];
  const downloads: { runId: number; destDir: string }[] = [];
  return {
    polls,
    downloads,
    runner: {
      listRuns(sha: string): GhRun[] {
        polls.push(sha);
        return listRuns(polls.length, sha);
      },
      downloadArtifact(runId: number, destDir: string): void {
        downloads.push({ runId, destDir });
        download?.(runId, destDir);
      },
    },
  };
}

/** Deterministic clock: time advances only when the collector sleeps. */
function fakeClock(): { now: () => number; sleep: (ms: number) => void; sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function baseOpts(over: Partial<CollectOptions> & { runner: GhRunner }): CollectOptions {
  // A fake clock by default: in-flight / no-run scenarios would otherwise
  // really sleep the whole 90 s window. Tests pinning the cadence pass their own.
  const clock = fakeClock();
  return {
    sha: SHA,
    waitMs: 90_000,
    intervalMs: 30_000,
    env: {},
    now: clock.now,
    sleep: clock.sleep,
    ...over,
  };
}

/** gh-style download: materialize version_id.txt + image_digest.txt in destDir. */
function writeArtifact(destDir: string): void {
  writeAt(destDir, "version_id.txt", `${VERSION_ID}\n`);
  writeAt(destDir, "image_digest.txt", `${DIGEST}\n`);
}

describe("collectDeployEvidence — success branch", () => {
  test("in-flight run completes; artifact read into exact evidence section", () => {
    const root = makeTempRoot();
    try {
      const { runner, polls, downloads } = makeRunner(
        (poll) => [poll === 1 ? IN_FLIGHT : SUCCESS],
        (_runId, destDir) => writeArtifact(destDir),
      );
      const clock = fakeClock();
      const result = collectDeployEvidence(
        baseOpts({ runner, now: clock.now, sleep: clock.sleep, artifactDir: root }),
      );

      expect(result.kind).toBe("success");
      expect(result.section).toBe(
        [
          "### Deploy evidence",
          `- Worker version: \`${VERSION_ID}\``,
          `- Image digest: \`${DIGEST}\``,
          "- Actions run: 123456",
        ].join("\n"),
      );
      expect(polls).toEqual([SHA, SHA]);
      expect(downloads).toEqual([{ runId: 123456, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("GitHub env pair turns the run bullet into a full link", () => {
    const root = makeTempRoot();
    try {
      const { runner } = makeRunner(() => [SUCCESS], (_runId, destDir) => writeArtifact(destDir));
      const result = collectDeployEvidence(
        baseOpts({ runner, env: { ...GH_ENV }, artifactDir: root }),
      );
      expect(result.section).toContain(`- Actions run: ${RUN_URL}`);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("trims artifact file content (whitespace never leaks into the notes)", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "version_id.txt", `  ${VERSION_ID}\n\n`);
      writeAt(root, "image_digest.txt", `\t${DIGEST} \n`);
      const { runner } = makeRunner(() => [SUCCESS]); // download no-op: read pre-written files
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.section).toContain(`- Worker version: \`${VERSION_ID}\``);
      expect(result.section).toContain(`- Image digest: \`${DIGEST}\``);
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("collectDeployEvidence — deploy-failed branch", () => {
  test("failed conclusion yields the explicit failed section; no artifact download", () => {
    const { runner, downloads } = makeRunner(() => [FAILED]);
    const result = collectDeployEvidence(baseOpts({ runner, env: { ...GH_ENV } }));

    expect(result.kind).toBe("deploy-failed");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        '- Status: deploy failed — run concluded "failure"; see the run log',
        `- Actions run: ${RUN_URL}`,
      ].join("\n"),
    );
    expect(downloads).toEqual([]);
  });

  test("alternate conclusions are quoted, not hardcoded", () => {
    for (const conclusion of ["cancelled", "timed_out"]) {
      const { runner } = makeRunner(() => [{ ...FAILED, conclusion }]);
      const result = collectDeployEvidence(baseOpts({ runner, env: {} }));
      expect(result.kind).toBe("deploy-failed");
      expect(result.section).toContain(`run concluded "${conclusion}"`);
    }
  });
});

describe("collectDeployEvidence — timeout / pending branch", () => {
  test("run still in flight after the window: pending section + exact poll cadence", () => {
    const { runner, polls } = makeRunner(() => [IN_FLIGHT]);
    const clock = fakeClock();
    const result = collectDeployEvidence(baseOpts({ runner, now: clock.now, sleep: clock.sleep }));

    expect(result.kind).toBe("pending");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        "- Status: pending — deploy run still in flight after the ~2 min bounded wait",
        "- Actions run: 123456",
      ].join("\n"),
    );
    // 90 s window at 30 s interval: polls at t=0,30,60,90, sleeping 30 s between.
    expect(polls).toHaveLength(4);
    expect(clock.sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  test("wait label rounds the window down to whole minutes, never reports ~0 min", () => {
    const { runner } = makeRunner(() => [IN_FLIGHT]);
    const result = collectDeployEvidence(baseOpts({ runner, waitMs: 45_000, intervalMs: 30_000 }));
    expect(result.section).toContain("after the ~1 min bounded wait");
  });
});

describe("collectDeployEvidence — no-run branch", () => {
  test("empty run list for the whole window: explicit no-run section, no run bullet", () => {
    const { runner, polls } = makeRunner(() => []);
    const clock = fakeClock();
    const result = collectDeployEvidence(baseOpts({ runner, now: clock.now, sleep: clock.sleep }));

    expect(result.kind).toBe("no-run");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        `- Status: no deploy run for commit \`${SHA}\` after the ~2 min bounded wait (deploy.yml paths-ignore may have skipped this commit)`,
      ].join("\n"),
    );
    expect(result.section).not.toContain("Actions run:");
    expect(polls).toHaveLength(4);
  });

  test("a run appearing mid-window for the SHA wins over earlier empties", () => {
    const root = makeTempRoot();
    try {
      // poll 1-2: nothing yet (deploy run not registered); poll 3+: success.
      const { runner, polls } = makeRunner(
        (poll) => (poll >= 3 ? [SUCCESS] : []),
        (_runId, destDir) => writeArtifact(destDir),
      );
      const clock = fakeClock();
      const result = collectDeployEvidence(
        baseOpts({ runner, now: clock.now, sleep: clock.sleep, artifactDir: root }),
      );
      expect(result.kind).toBe("success");
      expect(polls).toHaveLength(3);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("listRuns is queried with the requested SHA", () => {
    const { runner, polls } = makeRunner(() => []);
    const clock = fakeClock();
    collectDeployEvidence(baseOpts({ runner, sha: OTHER_SHA, now: clock.now, sleep: clock.sleep }));
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((s) => s === OTHER_SHA)).toBe(true);
  });
});

describe("collectDeployEvidence — degraded branches (never fail the release)", () => {
  test("gh error (e.g. binary missing) before any run was seen: no run bullet", () => {
    const { runner } = makeRunner(() => {
      throw new Error("gh run list failed (127): gh: command not found");
    });
    const result = collectDeployEvidence(baseOpts({ runner }));

    expect(result.kind).toBe("degraded");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        "- Status: unavailable — gh run list failed (127): gh: command not found",
      ].join("\n"),
    );
  });

  test("gh error after a run was seen keeps the run link for manual follow-up", () => {
    let poll = 0;
    const { runner } = makeRunner(() => {
      poll += 1;
      if (poll === 1) return [IN_FLIGHT];
      throw new Error("gh run list failed (1): Connection reset");
    });
    const result = collectDeployEvidence(baseOpts({ runner, env: { ...GH_ENV } }));
    expect(result.kind).toBe("degraded");
    expect(result.section).toContain(
      "- Status: unavailable — gh run list failed (1): Connection reset",
    );
    expect(result.section).toContain(`- Actions run: ${RUN_URL}`);
  });

  test("artifact download failure degrades with the run link", () => {
    const { runner, downloads } = makeRunner(
      () => [SUCCESS],
      () => {
        throw new Error("gh run download failed (1): artifact not found");
      },
    );
    const result = collectDeployEvidence(baseOpts({ runner, env: {} }));
    expect(result.kind).toBe("degraded");
    expect(result.section).toContain(
      "- Status: unavailable — gh run download failed (1): artifact not found",
    );
    expect(result.section).toContain("- Actions run: 123456");
    expect(downloads).toHaveLength(1);
  });

  test("artifact missing its evidence files degrades naming the file", () => {
    const root = makeTempRoot();
    try {
      const { runner } = makeRunner(() => [SUCCESS]); // download no-op: no files land
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("degraded");
      expect(result.section).toMatch(/- Status: unavailable — .+version_id\.txt/);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("artifact with empty evidence files degrades explicitly", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "version_id.txt", "\n");
      writeAt(root, "image_digest.txt", DIGEST);
      const { runner } = makeRunner(() => [SUCCESS]);
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("degraded");
      expect(result.section).toContain(
        `- Status: unavailable — artifact ${DEPLOY_EVIDENCE_ARTIFACT} has empty version_id.txt / image_digest.txt`,
      );
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("section markdown shape (every branch keeps the explicit heading)", () => {
  test("heading first, dash bullets after, no trailing newline", () => {
    const root = makeTempRoot();
    try {
      const scenarios: Array<{
        runs: (poll: number) => GhRun[];
        download?: (id: number, d: string) => void;
      }> = [
        { runs: () => [SUCCESS], download: (_id, d) => writeArtifact(d) },
        { runs: () => [FAILED] },
        { runs: () => [IN_FLIGHT] },
        { runs: () => [] },
        {
          runs: () => {
            throw new Error("x");
          },
        },
      ];
      for (const s of scenarios) {
        const { runner } = makeRunner((poll) => s.runs(poll), s.download);
        const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
        const lines = result.section.split("\n");
        expect(lines[0]).toBe("### Deploy evidence");
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines.slice(1)) expect(line).toMatch(/^- /);
        expect(result.section.endsWith("\n")).toBe(false);
      }
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("runCli — exit-code invariant and wiring", () => {
  /** Capture console traffic while `fn` runs (usage + outcome summary lines). */
  function captureConsole<T>(fn: () => T): { out: string[]; err: string[]; value: T } {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...data: unknown[]) => void out.push(data.join(" "));
    console.error = (...data: unknown[]) => void err.push(data.join(" "));
    try {
      return { out, err, value: fn() };
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  }

  /** Drive runCli with the given GH behavior and injected clock; returns code + channels. */
  function drive(
    gh: { runs: (poll: number) => GhRun[]; download?: (id: number, d: string) => void },
    argv: string[] = [SHA],
    env: Record<string, string | undefined> = {},
  ): { code: number; stdout: string; log: string[]; err: string[] } {
    const { runner } = makeRunner((poll) => gh.runs(poll), gh.download);
    const clock = fakeClock();
    const stdout: string[] = [];
    const deps: CliDeps = {
      runner,
      now: clock.now,
      sleep: clock.sleep,
      stdout: (s) => void stdout.push(s),
    };
    const cap = captureConsole(() => runCli(["bun", "script", ...argv], env, deps));
    return { code: cap.value, stdout: stdout.join(""), log: cap.out, err: cap.err };
  }

  const downloadOk = (_id: number, d: string): void => writeArtifact(d);

  test("all four branches + degraded return 0 and print exactly one section on stdout", () => {
    const cases: Array<{
      label: string;
      gh: { runs: (poll: number) => GhRun[]; download?: (id: number, d: string) => void };
    }> = [
      { label: "success", gh: { runs: () => [SUCCESS], download: downloadOk } },
      { label: "deploy-failed", gh: { runs: () => [FAILED] } },
      { label: "pending", gh: { runs: () => [IN_FLIGHT] } },
      { label: "no-run", gh: { runs: () => [] } },
      {
        label: "degraded",
        gh: {
          runs: () => {
            throw new Error("no gh here");
          },
        },
      },
    ];
    for (const c of cases) {
      const { code, stdout, err } = drive(c.gh);
      expect(code).toBe(0);
      expect(stdout.startsWith("### Deploy evidence\n")).toBe(true);
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.endsWith("\n\n")).toBe(false); // exactly one trailing newline
      expect(err[0]).toBe(`collect-deploy-evidence: ${c.label}`);
    }
  });

  test("MERGE_SHA env provides the SHA; positional arg wins over env", () => {
    const viaEnv = drive({ runs: () => [] }, [], { MERGE_SHA: OTHER_SHA });
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.stdout).toContain(OTHER_SHA);

    const viaArg = drive({ runs: () => [] }, [SHA], { MERGE_SHA: OTHER_SHA });
    expect(viaArg.stdout).toContain(SHA);
    expect(viaArg.stdout).not.toContain(OTHER_SHA);
  });

  test("MERGE_SHA env value goes through the same full-SHA validation (folded task-1 review fix)", () => {
    const short = drive({ runs: () => [] }, [], { MERGE_SHA: "1f2e3d4" });
    expect(short.code).toBe(1);
    expect(short.err[0]).toMatch(
      /^Invalid commit SHA: 1f2e3d4 \(expected the full 40-char merge commit SHA/,
    );
  });

  test("unexpected internal error still exits 0 with a degraded section", () => {
    const { runner } = makeRunner(() => [SUCCESS], downloadOk);
    const stdout: string[] = [];
    const cap = captureConsole(() =>
      runCli(["bun", "script", SHA], {}, {
        runner,
        now: () => {
          throw new Error("clock exploded");
        },
        sleep: () => {},
        stdout: (s) => void stdout.push(s),
      }),
    );
    expect(cap.value).toBe(0);
    expect(stdout.join("")).toContain("- Status: unavailable — clock exploded");
    expect(cap.err[0]).toBe("collect-deploy-evidence: degraded");
  });

  test("usage errors exit 1 (missing SHA, short SHA, unknown flag)", () => {
    expect(drive({ runs: () => [] }, []).code).toBe(1);
    const short = drive({ runs: () => [] }, ["1f2e3d4"]);
    expect(short.code).toBe(1);
    expect(short.err[0]).toMatch(/^Invalid commit SHA: 1f2e3d4/);
    const junk = drive({ runs: () => [] }, ["--wat"]);
    expect(junk.code).toBe(1);
    expect(junk.err[0]).toMatch(/^Unknown argument: --wat/);
  });

  test("--help exits 0 and prints usage", () => {
    const { code, log } = drive({ runs: () => [] }, ["--help"]);
    expect(code).toBe(0);
    expect(log.join("\n")).toContain("MERGE_SHA=<merge-sha>");
  });
});

describe("parseArgs", () => {
  test("defaults: 15 min bounded wait, 30 s interval", () => {
    expect(parseArgs(["bun", "script", SHA])).toEqual({
      sha: SHA,
      waitMinutes: 15,
      intervalSeconds: 30,
      help: false,
    });
  });

  test("tunable via both flag forms; uppercase SHA normalized to lowercase", () => {
    expect(parseArgs(["bun", "script", SHA.toUpperCase(), "--wait-minutes", "5"])).toMatchObject({
      sha: SHA,
      waitMinutes: 5,
    });
    expect(parseArgs(["bun", "script", "--interval-seconds=10", SHA])).toMatchObject({
      intervalSeconds: 10,
    });
    expect(parseArgs(["bun", "script", SHA, "--wait-minutes=0"])).toMatchObject({
      waitMinutes: 0,
    });
  });

  test("rejects bad values loudly", () => {
    expect(() => parseArgs(["bun", "script", SHA, "--wait-minutes", "abc"])).toThrow(
      /Invalid --wait-minutes value: abc/,
    );
    expect(() => parseArgs(["bun", "script", SHA, "--interval-seconds", "0"])).toThrow(
      /minimum 1/,
    );
    expect(() => parseArgs(["bun", "script", "zzz"])).toThrow(/Unknown argument: zzz/);
  });
});
