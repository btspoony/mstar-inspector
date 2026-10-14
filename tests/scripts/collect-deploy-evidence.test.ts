/**
 * `scripts/collect-deploy-evidence.ts` unit tests (D1 / D3).
 *
 * The GH-touching layer is injected (`GhRunner` + fake clock/sleep), so the
 * wait/match/timeout decision logic is pinned without `gh`, network, or real
 * time. The fake clock advances only inside `sleep` — polls are
 * instantaneous, so a 90 s window at 30 s interval deterministically polls
 * at t=0,30,60,90 (4 polls, 3 sleeps).
 *
 * Branch matrix (AC1):
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
import { readFileSync } from "node:fs";
import {
  DEFAULT_DEPLOY_WORKFLOW,
  DEPLOY_EVIDENCE_ARTIFACT,
  type CliDeps,
  collectDeployEvidence,
  type CollectOptions,
  type CollectResult,
  createGhRunner,
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
  headBranch: "main",
};
const SUCCESS: GhRun = {
  databaseId: 123456,
  status: "completed",
  conclusion: "success",
  displayTitle: "Deploy main",
  headBranch: "main",
};
const FAILED: GhRun = {
  databaseId: 123456,
  status: "completed",
  conclusion: "failure",
  displayTitle: "Deploy main",
  headBranch: "main",
};

const VERSION_ID = "11112222-3333-4444-5555-666677778888";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const RUN_URL = "https://github.com/acme/mstar-inspector/actions/runs/123456";
const GH_ENV = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/mstar-inspector",
};

/** Recording fake: `listRuns(poll, sha, workflow)` decides per poll; `download` materializes artifact files. */
function makeRunner(
  listRuns: (poll: number, sha: string) => GhRun[],
  download?: (runId: number, destDir: string) => void,
): {
  runner: GhRunner;
  polls: string[];
  workflows: string[];
  downloads: { runId: number; destDir: string }[];
} {
  const polls: string[] = [];
  const workflows: string[] = [];
  const downloads: { runId: number; destDir: string }[] = [];
  return {
    polls,
    workflows,
    downloads,
    runner: {
      listRuns(sha: string, workflow: string): GhRun[] {
        polls.push(sha);
        workflows.push(workflow);
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
    workflow: DEFAULT_DEPLOY_WORKFLOW,
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

  test("zero wait polls exactly once and reports an immediate check, never a rounded-up wait", () => {
    // The Release workflow passes --wait-minutes 0 for a prerelease version
    // (it never dispatches, so there is nothing to wait for): the section must
    // be written after ONE poll and must not claim a ~1 min wait that never
    // happened.
    const { runner, polls } = makeRunner(() => []);
    const result = collectDeployEvidence(baseOpts({ runner, waitMs: 0, env: {} }));
    expect(result.kind).toBe("no-run");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        `- Status: no deploy run for commit \`${SHA}\` after the immediate check (no deploy.yml run was created for this commit)`,
      ].join("\n"),
    );
    expect(polls).toHaveLength(1);
  });

  test("zero wait with a run still in flight yields the pending section after one poll", () => {
    const { runner, polls } = makeRunner(() => [IN_FLIGHT]);
    const result = collectDeployEvidence(baseOpts({ runner, waitMs: 0, env: {} }));
    expect(result.kind).toBe("pending");
    expect(result.section).toContain("still in flight after the immediate check");
    expect(polls).toHaveLength(1);
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
        `- Status: no deploy run for commit \`${SHA}\` after the ~2 min bounded wait (no deploy.yml run was created for this commit)`,
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

describe("collectDeployEvidence — multiple runs for one SHA (newest wins)", () => {
  const OLDER_SUCCESS = { ...SUCCESS, databaseId: 42 };
  const OLDER_FAILED = { ...FAILED, databaseId: 42 };

  test("newest success wins: its artifact is downloaded, older runs ignored", () => {
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(
        () => [SUCCESS, OLDER_FAILED],
        (_runId, destDir) => writeArtifact(destDir),
      );
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("success");
      expect(result.section).toContain("- Actions run: 123456");
      expect(downloads).toEqual([{ runId: 123456, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("newest failure wins over an older success (newest is the live one)", () => {
    const { runner, downloads } = makeRunner(() => [FAILED, OLDER_SUCCESS]);
    const result = collectDeployEvidence(baseOpts({ runner, env: {} }));
    expect(result.kind).toBe("deploy-failed");
    expect(result.section).toContain("- Actions run: 123456");
    expect(downloads).toEqual([]);
  });
});

describe("collectDeployEvidence — release identity (--ref prefers the release's own run)", () => {
  // deploy-prod.yml takes no `ref` input and refuses a non-tag ref, so a run's
  // own headBranch IS the ref it deployed — the preference proves identity.
  const TAG = "v1.2.3";
  // gh reports newest-first: the manual rollback (dispatched on `main` at the
  // release merge commit) is NEWER than the release's own tag-bound run.
  const ROLLBACK: GhRun = {
    databaseId: 999,
    status: "completed",
    conclusion: "success",
    displayTitle: "Deploy prod rollback",
    headBranch: "main",
  };
  const TAG_RUN: GhRun = { ...SUCCESS, databaseId: 4242, headBranch: TAG };

  test("same SHA: the tag-bound run is selected over the newer rollback run", () => {
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(() => [ROLLBACK, TAG_RUN], (_id, d) =>
        writeArtifact(d),
      );
      const result = collectDeployEvidence(
        baseOpts({ runner, ref: TAG, artifactDir: root, env: { ...GH_ENV } }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain(`- Actions run: ${RUN_URL.replace("123456", "4242")}`);
      expect(result.section).not.toContain("- Actions run: 999");
      // the rollback's artifact is never read for the release's evidence
      expect(downloads).toEqual([{ runId: 4242, destDir: root }]);
      // the preference HIT is not an ambiguity — no fallback notice
      expect(result.section).not.toContain("Run identity:");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("no run matches the ref: fallback keeps the newest-for-SHA pick and discloses it", () => {
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(() => [ROLLBACK], (_id, d) => writeArtifact(d));
      const result = collectDeployEvidence(
        baseOpts({ runner, ref: TAG, artifactDir: root, env: {} }),
      );
      expect(result.kind).toBe("success"); // never degrades to "no run"
      expect(result.section).toContain("- Actions run: 999");
      // the fallback is what discloses that the cited run is not the release's own deploy
      expect(result.section).toContain(
        `- Run identity: no run on ref \`${TAG}\` for commit \`${SHA}\` — the newest run for the commit is reported instead, which is not that ref's deploy`,
      );
      expect(downloads).toEqual([{ runId: 999, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("fallback on a pending run still yields a section with the fallback notice", () => {
    const { runner } = makeRunner(() => [{ ...ROLLBACK, status: "in_progress", conclusion: null }]);
    const clock = fakeClock();
    const result = collectDeployEvidence(
      baseOpts({ runner, ref: TAG, now: clock.now, sleep: clock.sleep }),
    );
    expect(result.kind).toBe("pending");
    expect(result.section).toContain("- Actions run: 999");
    expect(result.section).toContain("Run identity:");
  });

  test("no --ref keeps the plain newest-for-SHA pick (unchanged behavior)", () => {
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(() => [ROLLBACK, TAG_RUN], (_id, d) =>
        writeArtifact(d),
      );
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("success");
      expect(result.section).toContain("- Actions run: 999");
      expect(result.section).not.toContain("Run identity:");
      expect(downloads).toEqual([{ runId: 999, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("collectDeployEvidence — dispatch boundary (--since-run)", () => {
  const TAG = "v1.2.3";
  // The run this release's rerun replaced: a terminal failure on this tag.
  const SUPERSEDED: GhRun = { ...FAILED, databaseId: 5150, headBranch: TAG };
  // The trap this boundary exists for: an OLDER success on the same tag. A
  // single-id exclusion drops only 5150 and leaves 42 selectable, so the
  // collector would immediately return 42's artifact as this release's
  // evidence instead of waiting for the run the rerun just dispatched.
  const OLDER_SUCCESS: GhRun = { ...SUCCESS, databaseId: 42, headBranch: TAG };
  const FRESH: GhRun = { ...SUCCESS, databaseId: 5250, headBranch: TAG };
  // gh lists newest-first: the fresh dispatch leads once it registers.
  const FRESH_IN_FLIGHT: GhRun = { ...FRESH, status: "waiting", conclusion: null };
  /** The highest id visible at dispatch time — what the dispatch step captured. */
  const BOUNDARY = SUPERSEDED.databaseId;

  test("older success + superseded failure: waits past the boundary instead of backfilling the older success", () => {
    const root = makeTempRoot();
    try {
      // poll 1: only pre-boundary runs are visible (the fresh dispatch has not
      // registered yet); poll 2+: it leads the newest-first list.
      const { runner, polls, downloads } = makeRunner(
        (poll) => (poll === 1 ? [SUPERSEDED, OLDER_SUCCESS] : [FRESH, SUPERSEDED, OLDER_SUCCESS]),
        (_id, destDir) => writeArtifact(destDir),
      );
      const clock = fakeClock();
      const result = collectDeployEvidence(
        baseOpts({
          runner,
          ref: TAG,
          sinceRun: BOUNDARY,
          now: clock.now,
          sleep: clock.sleep,
          artifactDir: root,
          env: { ...GH_ENV },
        }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain(`- Actions run: ${RUN_URL.replace("123456", "5250")}`);
      // neither pre-boundary run is cited, and the older success' artifact is
      // never read
      expect(result.section).not.toContain("5150");
      expect(result.section).not.toContain("- Actions run: 42");
      expect(downloads).toEqual([{ runId: 5250, destDir: root }]);
      // a completed failure at poll 1 did NOT conclude the wait
      expect(polls).toHaveLength(2);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("MUTATION/dropping the boundary filter: the same sequence concludes on a pre-boundary run at the first poll", async () => {
    // A real source mutation, not a re-implementation: the collector has no
    // relative imports, so the mutated copy runs from a temp tree against the
    // same fixture — proving the boundary is what keeps the older success out.
    const src = readFileSync(`${import.meta.dir}/../../scripts/collect-deploy-evidence.ts`, "utf8");
    const mutated = src.replace(
      "sinceRun === undefined ? runs : runs.filter((r) => r.databaseId > sinceRun)",
      "runs",
    );
    expect(mutated).not.toBe(src);
    const root = makeTempRoot();
    try {
      const file = writeAt(root, "collect-deploy-evidence.mutated.ts", mutated);
      // Deliberate runtime-selected specifier: a static import cannot reach a
      // file generated during the test, and exercising that loader boundary is
      // the point of the mutation.
      const mutant: { collectDeployEvidence: (opts: CollectOptions) => CollectResult } =
        await import(file);
      const { runner, polls, downloads } = makeRunner(
        () => [SUPERSEDED, OLDER_SUCCESS],
        (_id, destDir) => writeArtifact(destDir),
      );
      const result = mutant.collectDeployEvidence(
        baseOpts({
          runner,
          ref: TAG,
          sinceRun: BOUNDARY,
          artifactDir: root,
          env: {},
        }),
      );
      // The newest pre-boundary run is the failure, so without the filter the
      // wait concludes immediately on it — the very outcome the boundary
      // prevents (with only that id excluded, the older success would be
      // selected instead, which is the reviewed bug).
      expect(result.kind).toBe("deploy-failed");
      expect(result.section).toContain("- Actions run: 5150");
      expect(polls).toHaveLength(1);
      expect(downloads).toEqual([]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("an in-flight post-boundary run is selected and awaited", () => {
    const { runner } = makeRunner(() => [FRESH_IN_FLIGHT, SUPERSEDED, OLDER_SUCCESS]);
    const clock = fakeClock();
    const result = collectDeployEvidence(
      baseOpts({
        runner,
        ref: TAG,
        sinceRun: BOUNDARY,
        now: clock.now,
        sleep: clock.sleep,
        env: { ...GH_ENV },
      }),
    );
    expect(result.kind).toBe("pending");
    expect(result.section).toContain(`- Actions run: ${RUN_URL.replace("123456", "5250")}`);
    expect(result.section).not.toContain("5150");
    expect(result.section).not.toContain("- Actions run: 42");
  });

  test("the boundary is dropped from the newest-for-SHA fallback too", () => {
    // The fresh run did not run on this tag: the disclosed fallback must still
    // apply — and it can only ever name a POST-boundary run.
    const freshForeign: GhRun = { ...FAILED, databaseId: 5255, headBranch: "main" };
    const { runner } = makeRunner(() => [freshForeign, SUPERSEDED, OLDER_SUCCESS]);
    const result = collectDeployEvidence(
      baseOpts({ runner, ref: TAG, sinceRun: BOUNDARY, env: { ...GH_ENV } }),
    );
    expect(result.kind).toBe("deploy-failed");
    expect(result.section).toContain(`- Actions run: ${RUN_URL.replace("123456", "5255")}`);
    expect(result.section).not.toContain("5150");
    expect(result.section).toContain("Run identity:");
  });

  test("only pre-boundary runs for the whole window: truthful boundary timeout, never cited", () => {
    const { runner, polls } = makeRunner(() => [SUPERSEDED, OLDER_SUCCESS]);
    const clock = fakeClock();
    const result = collectDeployEvidence(
      baseOpts({
        runner,
        ref: TAG,
        sinceRun: BOUNDARY,
        now: clock.now,
        sleep: clock.sleep,
        env: { ...GH_ENV },
      }),
    );
    expect(result.kind).toBe("no-run");
    // truthful: the commit does have runs, but none newer than the boundary —
    // and the section says exactly that without citing one
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        `- Status: no new deploy run for commit \`${SHA}\` after the ~2 min bounded wait (no run newer than the dispatch boundary 5150 appeared — the superseding deploy.yml run was not yet visible; no pre-boundary run was cited)`,
      ].join("\n"),
    );
    expect(result.section).not.toContain("- Actions run:");
    // polled the whole window rather than concluding on a pre-boundary run
    expect(polls).toHaveLength(4);
    expect(clock.sleeps).toEqual([30_000, 30_000, 30_000]);
  });

  test("boundary run appearing later in the window is awaited, not skipped", () => {
    const root = makeTempRoot();
    try {
      // polls 1-2: only pre-boundary runs; poll 3+: the dispatched run lands.
      const { runner, polls } = makeRunner(
        (poll) => (poll >= 3 ? [FRESH, SUPERSEDED, OLDER_SUCCESS] : [SUPERSEDED, OLDER_SUCCESS]),
        (_id, destDir) => writeArtifact(destDir),
      );
      const clock = fakeClock();
      const result = collectDeployEvidence(
        baseOpts({
          runner,
          ref: TAG,
          sinceRun: BOUNDARY,
          now: clock.now,
          sleep: clock.sleep,
          artifactDir: root,
          env: {},
        }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain("- Actions run: 5250");
      expect(polls).toHaveLength(3);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("no boundary keeps the plain nearest-first selection (reuse path regression)", () => {
    // The reuse path passes no --since-run: the newest-for-SHA pick is
    // unchanged, including when an older success sits behind it.
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(
        () => [SUPERSEDED, OLDER_SUCCESS],
        (_id, destDir) => writeArtifact(destDir),
      );
      const result = collectDeployEvidence(
        baseOpts({ runner, ref: TAG, artifactDir: root, env: {} }),
      );
      expect(result.kind).toBe("deploy-failed");
      expect(result.section).toContain("- Actions run: 5150");
      expect(downloads).toEqual([]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("no boundary with only the older success visible cites it (boundless fallback unchanged)", () => {
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(() => [OLDER_SUCCESS], (_id, destDir) =>
        writeArtifact(destDir),
      );
      const result = collectDeployEvidence(
        baseOpts({ runner, ref: TAG, artifactDir: root, env: {} }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain("- Actions run: 42");
      expect(downloads).toEqual([{ runId: 42, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("no boundary and no run at all keeps the original no-run wording", () => {
    const { runner } = makeRunner(() => []);
    const result = collectDeployEvidence(baseOpts({ runner, waitMs: 0, env: {} }));
    expect(result.kind).toBe("no-run");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        `- Status: no deploy run for commit \`${SHA}\` after the immediate check (no deploy.yml run was created for this commit)`,
      ].join("\n"),
    );
  });

  test("a zero window with only pre-boundary runs still states the boundary, never a run", () => {
    const { runner, polls } = makeRunner(() => [SUPERSEDED, OLDER_SUCCESS]);
    const result = collectDeployEvidence(
      baseOpts({ runner, ref: TAG, sinceRun: BOUNDARY, waitMs: 0, env: {} }),
    );
    expect(result.kind).toBe("no-run");
    expect(result.section).toContain("dispatch boundary 5150");
    expect(result.section).not.toContain("- Actions run:");
    expect(polls).toHaveLength(1);
  });

  // Codex P2, the rollback alias: this tag's FIRST deploy on a commit already
  // deployed under ANOTHER tag. The boundary is taken over the whole page, so
  // the foreign completed run is pre-boundary — the collector may never cite
  // its artifact as this release's evidence.
  const FOREIGN_DONE: GhRun = { ...SUCCESS, databaseId: 72, headBranch: "v1.2.4" };
  const FRESH_SAME_TAG: GhRun = { ...SUCCESS, databaseId: 80, headBranch: TAG };

  test("rollback alias: a completed run for another tag is never cited — the dispatched run is awaited and wins", () => {
    const root = makeTempRoot();
    try {
      // poll 1: only the foreign completed run is visible (this release's
      // dispatch has not registered); poll 2+: it leads the newest-first list.
      const { runner, polls, downloads } = makeRunner(
        (poll) => (poll === 1 ? [FOREIGN_DONE] : [FRESH_SAME_TAG, FOREIGN_DONE]),
        (_id, destDir) => writeArtifact(destDir),
      );
      const clock = fakeClock();
      const result = collectDeployEvidence(
        baseOpts({
          runner,
          ref: TAG,
          sinceRun: FOREIGN_DONE.databaseId,
          now: clock.now,
          sleep: clock.sleep,
          artifactDir: root,
          env: { ...GH_ENV },
        }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain(`- Actions run: ${RUN_URL.replace("123456", "80")}`);
      expect(result.section).not.toContain("- Actions run: 72");
      // the foreign run is not even a fallback candidate: no identity notice
      expect(result.section).not.toContain("Run identity:");
      expect(downloads).toEqual([{ runId: 80, destDir: root }]);
      // a completed foreign run at poll 1 did NOT conclude the wait
      expect(polls).toHaveLength(2);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("rollback alias, foreign run only for the whole window: truthful boundary timeout, artifact never read", () => {
    const { runner, polls, downloads } = makeRunner(() => [FOREIGN_DONE]);
    const clock = fakeClock();
    const result = collectDeployEvidence(
      baseOpts({
        runner,
        ref: TAG,
        sinceRun: FOREIGN_DONE.databaseId,
        now: clock.now,
        sleep: clock.sleep,
        env: { ...GH_ENV },
      }),
    );
    expect(result.kind).toBe("no-run");
    expect(result.section).toContain(`- Status: no new deploy run for commit \`${SHA}\``);
    expect(result.section).toContain("dispatch boundary 72");
    expect(result.section).not.toContain("- Actions run:");
    expect(downloads).toEqual([]);
    expect(polls).toHaveLength(4);
  });

  test("rollback alias without a boundary (reuse path): the foreign run is cited only with the identity disclosure", () => {
    // The boundless path is unchanged: a foreign-ref run cannot be excluded
    // when nothing was dispatched, so the section must SAY the cited run is not
    // this release's deploy rather than present it as this release's evidence.
    const root = makeTempRoot();
    try {
      const { runner, downloads } = makeRunner(() => [FOREIGN_DONE], (_id, d) => writeArtifact(d));
      const result = collectDeployEvidence(
        baseOpts({ runner, ref: TAG, artifactDir: root, env: {} }),
      );
      expect(result.kind).toBe("success");
      expect(result.section).toContain("- Actions run: 72");
      expect(result.section).toContain(
        `- Run identity: no run on ref \`${TAG}\` for commit \`${SHA}\` — the newest run for the commit is reported instead, which is not that ref's deploy`,
      );
      expect(downloads).toEqual([{ runId: 72, destDir: root }]);
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("collectDeployEvidence — sanitization + shape gates (QC round A1)", () => {
  test("multi-line error text is collapsed to one line; `- ` bullet shape preserved", () => {
    const { runner } = makeRunner(() => {
      throw new Error("gh run list failed (1): boom\nsecond line\n  third line");
    });
    const result = collectDeployEvidence(baseOpts({ runner, env: {} }));
    expect(result.kind).toBe("degraded");
    expect(result.section).toBe(
      [
        "### Deploy evidence",
        "- Status: unavailable — gh run list failed (1): boom second line third line",
      ].join("\n"),
    );
  });

  test("artifact value with an embedded newline degrades naming the file; raw value never interpolated", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "version_id.txt", "abc\ninjected line\n");
      writeAt(root, "image_digest.txt", DIGEST);
      const { runner } = makeRunner(() => [SUCCESS]); // download no-op: pre-written files
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("degraded");
      expect(result.section).toBe(
        [
          "### Deploy evidence",
          "- Status: unavailable — version_id.txt value is not a single line",
          "- Actions run: 123456",
        ].join("\n"),
      );
      expect(result.section).not.toContain("injected line");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("backtick in a digest degrades naming the violation", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "version_id.txt", VERSION_ID);
      writeAt(root, "image_digest.txt", "`sha256:not-a-digest`");
      const { runner } = makeRunner(() => [SUCCESS]);
      const result = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(result.kind).toBe("degraded");
      expect(result.section).toContain("image_digest.txt value contains a backtick");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("over-length value degrades naming the cap; exactly-at-cap value passes", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "version_id.txt", "a".repeat(257));
      writeAt(root, "image_digest.txt", DIGEST);
      const { runner } = makeRunner(() => [SUCCESS]);
      const over = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(over.kind).toBe("degraded");
      expect(over.section).toContain("version_id.txt value exceeds 256 characters");

      writeAt(root, "version_id.txt", "a".repeat(256));
      const atCap = collectDeployEvidence(baseOpts({ runner, artifactDir: root }));
      expect(atCap.kind).toBe("success");
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

describe("collectDeployEvidence — deploy workflow selection (--workflow)", () => {
  test("defaults to deploy.yml; the explicit workflow reaches listRuns verbatim on every poll", () => {
    const root = makeTempRoot();
    try {
      const def = makeRunner(() => [SUCCESS], (_id, d) => writeArtifact(d));
      collectDeployEvidence(baseOpts({ runner: def.runner, artifactDir: root }));
      expect(def.workflows).toEqual([DEFAULT_DEPLOY_WORKFLOW]);
      expect(def.workflows[0]).toBe("deploy.yml");

      const explicit = makeRunner(() => [SUCCESS], (_id, d) => writeArtifact(d));
      collectDeployEvidence(
        baseOpts({ runner: explicit.runner, workflow: "deploy-prod.yml", artifactDir: root }),
      );
      expect(explicit.workflows).toEqual(["deploy-prod.yml"]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("no-run section names the collected workflow, not a hardcoded deploy.yml", () => {
    const { runner } = makeRunner(() => []);
    const clock = fakeClock();
    const result = collectDeployEvidence(
      baseOpts({
        runner,
        workflow: "deploy-prod.yml",
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(result.kind).toBe("no-run");
    expect(result.section).toContain("(no deploy-prod.yml run was created for this commit)");
  });

  test("createGhRunner builds `gh run list --workflow <file> --commit <sha> …` argv", () => {
    const calls: string[][] = [];
    const orig = Bun.spawnSync;
    // test seam: swap the process spawner for a recorder
    Bun.spawnSync = ((args: string[]) => {
      calls.push(args);
      return {
        exitCode: 0,
        stdout: Buffer.from("[]"),
        stderr: Buffer.from(""),
      };
    }) as typeof Bun.spawnSync;
    try {
      createGhRunner().listRuns(SHA, "deploy-prod.yml");
    } finally {
      Bun.spawnSync = orig;
    }
    expect(calls).toEqual([
      [
        "gh",
        "run",
        "list",
        "--workflow",
        "deploy-prod.yml",
        "--commit",
        SHA,
        "--json",
        "status,conclusion,databaseId,displayTitle,headBranch",
      ],
    ]);
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

  test("--workflow missing its value before another flag is a usage error (T3-1 regression)", () => {
    const { runner, workflows } = makeRunner(() => []);
    const stdout: string[] = [];
    const cap = captureConsole(() =>
      runCli(["bun", "script", SHA, "--workflow", "--help"], {}, {
        runner,
        now: () => 0,
        sleep: () => {},
        stdout: (s) => void stdout.push(s),
      }),
    );
    expect(cap.value).toBe(1);
    expect(cap.err[0]).toMatch(/^Invalid --workflow value: --help/);
    // usage text reaches the caller, and the runner is never consulted
    expect(cap.out.join("\n")).toContain("MERGE_SHA=<merge-sha>");
    expect(stdout).toEqual([]);
    expect(workflows).toEqual([]);

    const empty = drive({ runs: () => [] }, [SHA, "--workflow="]);
    expect(empty.code).toBe(1);
    expect(empty.err[0]).toMatch(/^Invalid --workflow value: <none>/);

    const nextFlag = drive({ runs: () => [] }, [SHA, "--workflow", "--wait-minutes=0"]);
    expect(nextFlag.code).toBe(1);
    expect(nextFlag.err[0]).toMatch(/^Invalid --workflow value: --wait-minutes=0/);
  });

  test("--workflow reaches listRuns verbatim through runCli; default stays deploy.yml", () => {
    const explicit = makeRunner(() => []);
    const explicitClock = fakeClock();
    const explicitCode = captureConsole(() =>
      runCli(["bun", "script", SHA, "--workflow", "deploy-prod.yml"], {}, {
        runner: explicit.runner,
        now: explicitClock.now,
        sleep: explicitClock.sleep,
        stdout: () => {},
      }),
    ).value;
    expect(explicitCode).toBe(0);
    expect(explicit.workflows.length).toBeGreaterThan(0);
    expect(explicit.workflows.every((w) => w === "deploy-prod.yml")).toBe(true);

    const fallback = makeRunner(() => []);
    const fallbackClock = fakeClock();
    captureConsole(() =>
      runCli(["bun", "script", SHA], {}, {
        runner: fallback.runner,
        now: fallbackClock.now,
        sleep: fallbackClock.sleep,
        stdout: () => {},
      }),
    );
    expect(fallback.workflows.every((w) => w === DEFAULT_DEPLOY_WORKFLOW)).toBe(true);
  });

  test("--help exits 0 and prints usage", () => {
    const { code, log } = drive({ runs: () => [] }, ["--help"]);
    expect(code).toBe(0);
    expect(log.join("\n")).toContain("MERGE_SHA=<merge-sha>");
  });

  test("--ref reaches the selection: the tag-bound run outranks the newer rollback via runCli", () => {
    const rollback: GhRun = { ...SUCCESS, databaseId: 999, headBranch: "main" };
    const tagRun: GhRun = { ...SUCCESS, databaseId: 4242, headBranch: "v1.2.3" };
    const { code, stdout } = drive(
      { runs: () => [rollback, tagRun], download: downloadOk },
      [SHA, "--workflow", "deploy-prod.yml", "--ref", "v1.2.3"],
    );
    expect(code).toBe(0);
    expect(stdout).toContain("- Actions run: 4242");
    expect(stdout).not.toContain("999");
  });

  test("--since-run reaches the selection: a pre-boundary run is never cited via runCli", () => {
    const olderSuccess: GhRun = { ...SUCCESS, databaseId: 42, headBranch: "v1.2.3" };
    const { code, stdout, err } = drive(
      { runs: () => [olderSuccess] },
      [
        SHA,
        "--workflow",
        "deploy-prod.yml",
        "--ref",
        "v1.2.3",
        "--since-run",
        "42",
        "--wait-minutes",
        "1",
      ],
    );
    expect(code).toBe(0);
    expect(stdout).toContain("dispatch boundary 42");
    expect(stdout).not.toContain("Actions run:");
    expect(err[0]).toBe("collect-deploy-evidence: no-run");
  });
});

describe("parseArgs", () => {
  test("defaults: deploy.yml workflow, 15 min bounded wait, 30 s interval", () => {
    expect(parseArgs(["bun", "script", SHA])).toEqual({
      sha: SHA,
      workflow: DEFAULT_DEPLOY_WORKFLOW,
      ref: undefined,
      sinceRun: undefined,
      waitMinutes: 15,
      intervalSeconds: 30,
      help: false,
    });
  });

  test("--workflow in both flag forms selects the deploy workflow file", () => {
    expect(parseArgs(["bun", "script", SHA, "--workflow", "deploy-prod.yml"])).toMatchObject({
      workflow: "deploy-prod.yml",
    });
    expect(parseArgs(["bun", "script", SHA, "--workflow=deploy-prod.yml"])).toMatchObject({
      workflow: "deploy-prod.yml",
    });
  });

  test("--ref in both flag forms selects the expected run ref (T3-3)", () => {
    expect(parseArgs(["bun", "script", SHA, "--ref", "v1.2.3"])).toMatchObject({ ref: "v1.2.3" });
    expect(parseArgs(["bun", "script", SHA, "--ref=v1.2.3"])).toMatchObject({ ref: "v1.2.3" });
  });

  test("--ref rejects a missing value, a swallowed flag, and an unquotable value", () => {
    expect(() => parseArgs(["bun", "script", SHA, "--ref"])).toThrow(/Invalid --ref value/);
    expect(() => parseArgs(["bun", "script", SHA, "--ref", "--help"])).toThrow(
      /Invalid --ref value: --help/,
    );
    expect(() => parseArgs(["bun", "script", SHA, "--ref="])).toThrow(/Invalid --ref value/);
    // whitespace / backticks would break the `- ` bullet the value lands in
    expect(() => parseArgs(["bun", "script", SHA, "--ref", "v1 `x`"])).toThrow(
      /Invalid --ref value/,
    );
  });

  test("--since-run in both flag forms selects the dispatch boundary run id", () => {
    expect(parseArgs(["bun", "script", SHA, "--since-run", "123456"])).toMatchObject({
      sinceRun: 123456,
    });
    expect(parseArgs(["bun", "script", SHA, "--since-run=123456"])).toMatchObject({
      sinceRun: 123456,
    });
  });

  test("--since-run rejects a missing value, a swallowed flag, and a non-id value", () => {
    // A silently ignored boundary would let a pre-boundary run be cited as this
    // release's evidence, so every malformed form is a loud usage error.
    for (const argv of [
      ["bun", "script", SHA, "--since-run"],
      ["bun", "script", SHA, "--since-run", "--help"],
      ["bun", "script", SHA, "--since-run="],
      ["bun", "script", SHA, "--since-run", "abc"],
      ["bun", "script", SHA, "--since-run", "0"],
      ["bun", "script", SHA, "--since-run", "-1"],
    ]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(/Invalid --since-run value/);
    }
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
    expect(() => parseArgs(["bun", "script", SHA, "--workflow"])).toThrow(
      /Invalid --workflow value/,
    );
    expect(() => parseArgs(["bun", "script", "zzz"])).toThrow(/Unknown argument: zzz/);
  });
});
