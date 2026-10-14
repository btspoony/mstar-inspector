/**
 * Durable workflow-guard tests (QC round B2; AC2's 守卫断言 made
 * permanent — previously only transient CI-run heredoc evidence).
 *
 * YAML-parses `.github/workflows/release-prep.yml` + `release.yml` and pins
 * the release-chain guard surface (also the deploy-evidence hook surface):
 *
 * - triggers: prep = workflow_dispatch with the optional `version` input;
 *   release = pull_request closed + branches [main];
 * - release job guard: merged == true AND title prefix `release v`;
 * - permission faces (AD-4): prep = contents + pull-requests write, no
 *   issues; release = contents write + actions write (the `gh workflow run`
 *   dispatch face plus the deploy-evidence `gh run list`/`gh run download`
 *   face) and nothing else;
 * - concurrency: prep group `release-prep`, cancel-in-progress: false;
 * - checkout ref pins merge_commit_sha (release side);
 * - softprops/action-gh-release SHA pin string (byte-exact, sole
 *   third-party action; new-to-repo actions are SHA-pinned — pin convention);
 * - production dispatch step: `gh workflow run deploy-prod.yml --ref "$TAG"`
 *   only (the production workflow has no `ref` input — a run deploys exactly
 *   the ref it runs on) after Release creation and before the evidence step —
 *   a GITHUB_TOKEN-created Release does not fire `release: published`, so the
 *   explicit dispatch is the only production trigger (T3-2); the lookup for an
 *   existing run for the commit precedes that dispatch and reuses it instead of
 *   queueing a duplicate on a release rerun (P2) — the lookup is scoped to a run
 *   whose own `headBranch` is THIS tag (the collector's identity rule), so a
 *   run for another tag on the same commit is never reused and cannot mask a
 *   reusable same-tag run; reuse only for an in-flight or successful run, any
 *   other terminal outcome dispatching fresh, and the pre-dispatch boundary id
 *   leaving the step as the `since_run` output — that boundary is taken over
 *   the WHOLE page (any ref, the collector's exclusion scope), so a completed
 *   run under another tag for the same commit is excluded too — with the step
 *   body executed against a stubbed `gh` for the full case table (plus
 *   mutations dropping the reuse identity filter and narrowing the boundary);
 * - deploy-evidence append step: exactly one `gh release edit`
 *   workflow-wide (count across ALL step runs, not mere containment), its own
 *   step-level timeout budget bounded below the job cap, edit failure loud at
 *   the step level (::error + exit 1) while continue-on-error keeps the job
 *   green, and the notes file handed off from the extract step's
 *   `notes_file` output — never rebuilt from RUNNER_TEMP; the pre-dispatch
 *   boundary id reaches the collector as `--since-run` (only when set) and a prerelease
 *   version zeroes the bounded wait, both observed by executing the step body
 *   against stubbed `bun`/`gh`;
 * - evidence reads the PRODUCTION deploy workflow: the step's env carries
 *   `DEPLOY_WORKFLOW: deploy-prod.yml` and passes it as the collector's
 *   `--workflow` argument (staging deploys on the same push, so deploy.yml
 *   would be ambiguous); it also passes the release tag as `--ref "$TAG"`
 *   (shell-derived from VERSION) so a same-commit manual rollback run cannot
 *   be cited as this Release's deploy evidence (T3-3); the prep PR-body
 *   sentence promises production only for a non-prerelease version while
 *   staging always deploys (QC1-F003);
 * - timeout-minutes on both jobs.
 *
 * Parsing uses python3 + PyYAML (the method validated in task 4; preinstalled
 * on GitHub ubuntu runners) exported to JSON — no new dependencies. Structural
 * assertions only: a formatting change cannot silently drop a guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { git } from "./helpers";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

/** Parse a workflow YAML into a plain JS structure (throws loudly on failure). */
function parseWorkflow(rel: string): Record<string, any> {
  const path = join(REPO_ROOT, ".github", "workflows", rel);
  const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `python3 yaml parse failed for ${rel} (${proc.exitCode}): ${proc.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(proc.stdout.toString());
}

/** PyYAML parses the bare `on:` key as boolean true → JSON key "true". */
function triggers(wf: Record<string, any>): Record<string, any> {
  const on = wf["true"];
  if (!on) throw new Error("workflow has no `on:` trigger block");
  return on;
}

const SOFTPROPS_PIN = "softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64";

describe("release-prep.yml guards", () => {
  const wf = parseWorkflow("release-prep.yml");

  test("trigger: workflow_dispatch with optional string `version` input", () => {
    const dispatch = triggers(wf)["workflow_dispatch"];
    expect(dispatch).toBeDefined();
    expect(dispatch.inputs.version).toEqual({
      description: expect.any(String),
      required: false,
      type: "string",
    });
  });

  test("permissions (AD-4): contents + pull-requests write, no issues", () => {
    expect(wf.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
  });

  test("concurrency: group release-prep, cancel-in-progress false", () => {
    expect(wf.concurrency).toEqual({ group: "release-prep", "cancel-in-progress": false });
  });

  test("job: timeout-minutes 30", () => {
    expect(wf.jobs.prepare["timeout-minutes"]).toBe(30);
  });

  test("no direct `${{ }}` interpolation inside run: scripts (env indirection)", () => {
    const runs = (wf.jobs.prepare.steps as { run?: string; env?: unknown }[])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).not.toContain("${{");
    }
  });

  test("chain steps present: tag-exists early fail, prepare, validate, jq resolve, PR open/update", () => {
    const runs = (wf.jobs.prepare.steps as { run?: string }[])
      .map((s) => s.run ?? "")
      .join("\n---step---\n");
    expect(runs).toContain('git rev-parse "v$V"');
    expect(runs).toContain("release:prepare");
    expect(runs).toContain("release:validate");
    expect(runs).toContain("jq -er .version package.json");
    expect(runs).toContain("gh pr create");
    expect(runs).toContain("gh pr edit");
    // the PR body must state the real consequence for both version shapes:
    // staging always, production only for a version with no `-` (QC1-F003 —
    // an unqualified production promise must not come back)
    expect(runs).toContain("always deploys staging");
    expect(runs).toContain("only for a stable version (no hyphen in the version)");
    expect(runs).toContain("never dispatched to production automatically");
    expect(runs).not.toContain("gh label");
  });
});

describe("release.yml guards", () => {
  const wf = parseWorkflow("release.yml");

  test("trigger: pull_request closed on main", () => {
    expect(triggers(wf).pull_request).toEqual({ types: ["closed"], branches: ["main"] });
  });

  test("job guard: merged == true AND title prefix `release v`", () => {
    const cond = String(wf.jobs.release.if).replace(/\s+/g, " ");
    expect(cond).toContain("github.event.pull_request.merged == true");
    expect(cond).toContain("startsWith(github.event.pull_request.title, 'release v')");
  });

  test("permissions (AD-4): contents write + actions write (dispatch + evidence face), nothing else", () => {
    expect(wf.permissions).toEqual({ contents: "write", actions: "write" });
  });

  test("job: timeout-minutes 30", () => {
    expect(wf.jobs.release["timeout-minutes"]).toBe(30);
  });

  test("checkout pins merge_commit_sha", () => {
    const checkout = (wf.jobs.release.steps as { uses?: string; with?: { ref?: string } }[]).find(
      (s) => s.uses?.startsWith("actions/checkout"),
    );
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.merge_commit_sha }}");
  });

  test("softprops/action-gh-release is the sole third-party action, byte-exact SHA pin", () => {
    const uses = (wf.jobs.release.steps as { uses?: string }[])
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");
    expect(uses).toContain(SOFTPROPS_PIN);
    const third = uses.filter((u) => !u.startsWith("actions/") && !u.startsWith("oven-sh/"));
    expect(third).toEqual([SOFTPROPS_PIN]);
    // pin convention residue (QC B3): the SHA pin must carry the convention comment
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(text).toContain("actions NEW to this repo are SHA-pinned");
  });

  test("tag + notes steps: annotated tag with idempotent skip, bilingual notes + separator contract", () => {
    const runs = (wf.jobs.release.steps as { run?: string }[])
      .map((s) => s.run ?? "")
      .join("\n---step---\n");
    expect(runs).toContain("git tag -a");
    expect(runs).toContain("git rev-parse");
    expect(runs).toContain("--lang en");
    expect(runs).toContain("--lang cn");
    expect(runs).toContain("printf '\\n\\n---\\n\\n'");
  });

  test("dispatch step: production workflow dispatched on the tag, after Release and before evidence (T3-2)", () => {
    const steps = wf.jobs.release.steps as {
      id?: string;
      uses?: string;
      run?: string;
      if?: string;
      env?: Record<string, string>;
      "continue-on-error"?: boolean;
    }[];
    const createIdx = steps.findIndex((s) => s.uses?.startsWith("softprops/action-gh-release"));
    const dispatchIdx = steps.findIndex((s) => s.run?.includes("gh workflow run"));
    const evidIdx = steps.findIndex((s) => s.run?.includes("collect-deploy-evidence"));
    expect(dispatchIdx).toBeGreaterThan(createIdx); // tag + Release exist first
    expect(dispatchIdx).toBeLessThan(evidIdx); // the collector's bounded wait must see the run

    const dispatch = steps[dispatchIdx]!;
    // the evidence step reads the superseded run id from this step's output
    expect(dispatch.id).toBe("dispatch");
    // tag as `--ref` only: deploy-prod.yml takes no `ref` input, so the run
    // deploys exactly the ref it runs on (its guard refuses a non-tag ref)
    expect(dispatch.run).toContain('gh workflow run deploy-prod.yml --ref "$TAG"');
    expect(dispatch.run).not.toContain("-f ref=");
    expect(dispatch.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      VERSION: "${{ steps.ver.outputs.version }}",
    });
    expect(dispatch.run).not.toContain("${{");
    // fail-fast: a dispatch failure reds the step (unlike the evidence step)
    expect(dispatch["continue-on-error"]).toBeUndefined();
    // a dispatch always deploys, so a prerelease must not dispatch at all
    expect(dispatch.if).toBe("${{ !contains(steps.ver.outputs.version, '-') }}");
    // P2 rerun-reuse: the existing-run lookup must precede the dispatch, else a
    // release rerun queues a SECOND approval-gated deploy and the evidence
    // collector waits on the new run instead of backfilling the completed one
    const lookupIdx = dispatch.run!.indexOf("gh run list --workflow deploy-prod.yml --commit");
    expect(lookupIdx).toBeGreaterThanOrEqual(0);
    expect(lookupIdx).toBeLessThan(dispatch.run!.indexOf("gh workflow run"));
    // finding 1: the lookup reads the run's OWN branch and keeps only THIS tag —
    // the collector's identity rule — and scans the page, because `--limit 1`
    // let a foreign run hide a reusable same-tag run behind it
    expect(dispatch.run).toContain("--json status,conclusion,databaseId,headBranch");
    expect(dispatch.run).toContain("select(.headBranch == $tag)");
    // the whole page is scanned: a run limit could hide a reusable same-tag run
    expect(dispatch.run).not.toContain("--limit");
    expect(dispatch.run).not.toContain(".[0] // empty");
    // finding 2: the pre-dispatch boundary id leaves the step as an output (the
    // evidence step forwards it to the collector as --since-run)
    expect(dispatch.run).toContain('echo "since_run=${BOUNDARY}" >> "$GITHUB_OUTPUT"');
    // the boundary is the HIGHEST id on the WHOLE page, any ref (Codex P2):
    // same-tag only would leave an older success on this tag — and a foreign
    // tag's completed run for the same commit, the rollback alias — selectable
    expect(dispatch.run).toContain("map(.databaseId) | max // empty");
    expect(dispatch.run).toContain('BOUNDARY="$(printf');
    // the reuse lookup keeps its OWN, narrower scope (headBranch == $tag)
    expect(dispatch.run).toContain(
      "first(.[] | select(.headBranch == $tag)) // empty |",
    );
  });

  /**
   * Throwaway repo carrying the real `v9.9.9` tag (the body runs
   * `git rev-list -n1`) plus a stubbed `gh`: `run list` hands the fixture JSON
   * to the STEP'S OWN jq pipeline (so the real headBranch filter is what runs),
   * `workflow run` records the dispatch instead of mutating the repo.
   */
  function makeDispatchFixture(): { dir: string; log: string; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "release-dispatch-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-qm", "x");
    git(dir, "tag", "-a", "-m", "v9.9.9", "v9.9.9");

    const log = join(dir, "gh.log");
    const output = join(dir, "output.txt");
    writeFileSync(log, "");
    writeFileSync(output, "");
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "list" ]; then
  printf '%s' "$GH_STUB_RUNS_JSON"
  exit 0
fi
if [ "\${1:-}" = "workflow" ] && [ "\${2:-}" = "run" ]; then
  printf 'DISPATCH %s\\n' "$*" >> "$GH_STUB_LOG"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 7
`,
    );
    Bun.spawnSync(["chmod", "+x", join(dir, "gh")]);
    return { dir, log, output };
  }

  /** Run one dispatch-step body against a prepared fixture. */
  function runDispatchBody(
    fixture: { dir: string; log: string; output: string },
    body: string,
    runsJson: string,
  ): { code: number; out: string; log: string; exported: string } {
    writeFileSync(fixture.log, "");
    writeFileSync(fixture.output, "");
    const proc = Bun.spawnSync(["bash", "-e", "-c", body], {
      cwd: fixture.dir,
      env: {
        ...process.env,
        PATH: `${fixture.dir}:${process.env.PATH}`,
        GH_TOKEN: "stub-token",
        VERSION: "9.9.9",
        GH_STUB_RUNS_JSON: runsJson,
        GH_STUB_LOG: fixture.log,
        GITHUB_OUTPUT: fixture.output,
      },
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString() + proc.stderr.toString(),
      log: readFileSync(fixture.log, "utf8"),
      exported: readFileSync(fixture.output, "utf8"),
    };
  }

  test("dispatch step body EXECUTES: reuse only an in-flight or successful run OF THIS TAG, dispatch for every other outcome", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const run = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;

    // gh reports newest-first and `headBranch` is the run's OWN ref: only a run
    // on v9.9.9 is this release's deploy. `reuse` cases must leave the dispatch
    // log empty; every other outcome dispatches a fresh run and exports the
    // highest run id visible on the WHOLE page (ANY ref) as `since_run` (empty
    // only when the commit has no run at all). That boundary — not the same-tag
    // reuse id — is what stops an older success on this tag, or a foreign tag's
    // completed run, from being cited as this release's evidence.
    const REUSE = true;
    const DISPATCH = false;
    const cases: {
      runs: string;
      reuse: boolean;
      label: string;
      /** The boundary the step must export; null → empty value. */
      boundary: number | null;
      /** Reuse cases: the id the reuse notice must name. */
      reuseId?: number;
    }[] = [
      { runs: "[]", reuse: DISPATCH, label: "no run for the commit", boundary: null },
      {
        runs: '[{"databaseId":1,"status":"completed","conclusion":"success","headBranch":"v9.9.9"}]',
        reuse: REUSE,
        label: "success",
        boundary: null,
        reuseId: 1,
      },
      {
        runs: '[{"databaseId":2,"status":"waiting","conclusion":null,"headBranch":"v9.9.9"}]',
        reuse: REUSE,
        label: "in-flight (waiting for approval)",
        boundary: null,
        reuseId: 2,
      },
      {
        runs: '[{"databaseId":3,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9"}]',
        reuse: REUSE,
        label: "in-flight (in_progress)",
        boundary: null,
        reuseId: 3,
      },
      ...[
        "failure",
        "cancelled",
        "timed_out",
        "startup_failure",
        "action_required",
        "stale",
        "neutral",
        "skipped",
      ].map((conclusion, i) => ({
        runs: `[{"databaseId":${10 + i},"status":"completed","conclusion":"${conclusion}","headBranch":"v9.9.9"}]`,
        reuse: DISPATCH,
        label: `terminal ${conclusion}`,
        boundary: 10 + i,
      })),
      // foreign run listed FIRST: it must not mask the reusable same-tag run
      // behind it (gh's newest-first order is what `--limit 1` used to hide)
      {
        runs:
          '[{"databaseId":70,"status":"completed","conclusion":"success","headBranch":"v9.9.8"},' +
          '{"databaseId":71,"status":"completed","conclusion":"success","headBranch":"v9.9.9"}]',
        reuse: REUSE,
        label: "foreign newer run listed first, same-tag run behind it",
        boundary: null,
        reuseId: 71,
      },
      // ROLLBACK ALIAS (Codex P2): this tag has NO run of its own, while the
      // commit already carries a COMPLETED run under another tag. Nothing may
      // be reused (the foreign run is not this release's deploy) and the
      // boundary must cover that foreign run — 72, not empty — else the
      // collector could cite its artifact as this release's evidence before
      // the dispatched run registers.
      {
        runs: '[{"databaseId":72,"status":"completed","conclusion":"success","headBranch":"v9.9.8"}]',
        reuse: DISPATCH,
        label: "rollback alias: another tag's completed run only",
        boundary: 72,
      },
      {
        runs:
          '[{"databaseId":73,"status":"completed","conclusion":"failure","headBranch":"v9.9.8"},' +
          '{"databaseId":74,"status":"completed","conclusion":"failure","headBranch":"v9.9.9"}]',
        reuse: DISPATCH,
        label: "another tag's failure ahead of this tag's failure",
        boundary: 74,
      },
      // THE reviewed trap: a newer same-tag failure ahead of an OLDER same-tag
      // success. The old step exported only the failure id (80), so the
      // collector could still select run 20's successful artifact as this
      // release's evidence. The boundary must be 80, so run 20 is out too.
      {
        runs:
          '[{"databaseId":80,"status":"completed","conclusion":"failure","headBranch":"v9.9.9"},' +
          '{"databaseId":20,"status":"completed","conclusion":"success","headBranch":"v9.9.9"}]',
        reuse: DISPATCH,
        label: "superseded failure ahead of an older success on this tag",
        boundary: 80,
      },
    ];

    const fixture = makeDispatchFixture();
    try {
      for (const c of cases) {
        const result = runDispatchBody(fixture, run, c.runs);
        expect(result.code, `${c.label}: exit code`).toBe(0);
        if (c.reuse) {
          expect(result.out, `${c.label}: reuse notice`).toContain(
            "::notice::reusing existing deploy-prod.yml run",
          );
          expect(result.out, `${c.label}: reuses the same-tag run`).toContain(
            `reusing existing deploy-prod.yml run ${c.reuseId} for v9.9.9`,
          );
          expect(result.log, `${c.label}: no dispatch`).toBe("");
          // the reuse path exits before the boundary line: no --since-run
          expect(result.exported, `${c.label}: no boundary`).not.toContain("since_run=");
        } else {
          expect(result.log, `${c.label}: dispatches`).toContain(
            "DISPATCH workflow run deploy-prod.yml --ref v9.9.9",
          );
          expect(result.exported, `${c.label}: boundary`).toBe(
            `since_run=${c.boundary ?? ""}\n`,
          );
        }
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("MUTATION/dropping the headBranch filter: a foreign run is reused for this tag (the reviewed bug)", () => {
    // The pin above is load-bearing: remove the identity filter — the reviewed
    // state, where the lookup had no ref scope — and the newest run for the
    // commit, whatever tag it belongs to, is reused as this release's deploy.
    const steps = wf.jobs.release.steps as { run?: string }[];
    const src = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;
    const mutated = src.replace("select(.headBranch == $tag)", ".");
    expect(mutated).not.toBe(src);

    const foreignOnly =
      '[{"databaseId":72,"status":"completed","conclusion":"success","headBranch":"v9.9.8"}]';
    const fixture = makeDispatchFixture();
    try {
      const fixed = runDispatchBody(fixture, src, foreignOnly);
      expect(fixed.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");

      const unfiltered = runDispatchBody(fixture, mutated, foreignOnly);
      expect(unfiltered.out).toContain("reusing existing deploy-prod.yml run 72 for v9.9.9");
      expect(unfiltered.log).toBe("");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("MUTATION/narrowing the boundary to this tag: the foreign-ref run is left outside it (Codex P2)", () => {
    // The widened jq is load-bearing. Narrow it back to the same-tag scope the
    // reviewed state had (the literal tag the fixture releases) and the
    // rollback-alias page exports an EMPTY boundary, so the collector could fall
    // back to the completed foreign run before the dispatched one registers.
    const steps = wf.jobs.release.steps as { run?: string }[];
    const src = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;
    const mutated = src.replace(
      "map(.databaseId) | max // empty",
      'map(select(.headBranch == "v9.9.9") | .databaseId) | max // empty',
    );
    expect(mutated).not.toBe(src);

    const aliasPage =
      '[{"databaseId":72,"status":"completed","conclusion":"success","headBranch":"v9.9.8"}]';
    const fixture = makeDispatchFixture();
    try {
      const fixed = runDispatchBody(fixture, src, aliasPage);
      expect(fixed.code).toBe(0);
      expect(fixed.exported).toBe("since_run=72\n");

      const narrowed = runDispatchBody(fixture, mutated, aliasPage);
      expect(narrowed.code).toBe(0);
      expect(narrowed.exported).toBe("since_run=\n"); // the reviewed gap
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("deploy-evidence append step: after release creation, never fails the release, env-indirected", () => {
    const steps = wf.jobs.release.steps as {
      id?: string;
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      "continue-on-error"?: boolean;
      "timeout-minutes"?: number;
    }[];
    const createIdx = steps.findIndex((s) => s.uses?.startsWith("softprops/action-gh-release"));
    const evidIdx = steps.findIndex((s) => s.run?.includes("collect-deploy-evidence"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(evidIdx).toBeGreaterThan(createIdx); // tag/Release creation never waits for evidence

    const evid = steps[evidIdx]!;
    const evidRun = evid.run!;
    // QC W-F001: the wait cannot starve pre-steps of the job's 30-min budget —
    // 15-min bounded-wait default + margin, arithmetic documented in the YAML comment
    expect(evid["timeout-minutes"]).toBe(18);
    // QC A3: an edit failure is loud at the step level (::error + exit 1 →
    // step red) while continue-on-error keeps the JOB green — evidence can
    // never fail the release
    expect(evid["continue-on-error"]).toBe(true);
    expect(evidRun).toContain("::error::");
    expect(evidRun).toContain("exit 1");
    // AD-3: single idempotent rewrite from the workspace notes file, same separator
    expect(evidRun).toContain("printf '\\n\\n---\\n\\n' >> \"$NOTES_FILE\"");
    expect(evidRun).toContain('gh release edit "v${VERSION}" --notes-file "$NOTES_FILE"');
    expect(evidRun.match(/gh release edit/g)).toHaveLength(1);
    expect(evidRun).not.toContain("${{");
    // QC B1: version/SHA/token reach the script via step env, never raw interpolation
    expect(evid.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      VERSION: "${{ steps.ver.outputs.version }}",
      MERGE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
      // folded T2 review: the notes path is handed off from the extract step's
      // output (single shared path), not rebuilt here
      NOTES_FILE: "${{ steps.changelog.outputs.notes_file }}",
      // boundary: the highest run id the dispatch step saw before it dispatched
      // (empty when it reused a run, dispatched nothing, or had no run) — every
      // id at or below it predates this release's deploy
      SINCE_RUN: "${{ steps.dispatch.outputs.since_run }}",
      // AC4: the evidence section must cite the PRODUCTION deploy run —
      // deploy.yml runs on the same main push and would be ambiguous
      DEPLOY_WORKFLOW: "deploy-prod.yml",
    });
    // the boundary is forwarded as `--since-run` — only when set, so the reuse
    // path (and a first release with no run) passes no flag at all and keeps the
    // normal ref-preference behaviour
    expect(evidRun).toContain('[ -n "$SINCE_RUN" ]');
    expect(evidRun).toContain('EXTRA_ARGS+=(--since-run "$SINCE_RUN")');
    // nit d: a prerelease version carries no dispatch, so the wait is zeroed —
    // the section is written at once instead of burning the bounded wait
    expect(evidRun).toContain("case \"$VERSION\" in");
    expect(evidRun).toContain("*-*) EXTRA_ARGS+=(--wait-minutes 0)");
    // … and the value reaches the collector as the `--workflow` argument
    expect(evidRun).toContain(
      'bun run scripts/collect-deploy-evidence.ts --workflow "$DEPLOY_WORKFLOW"',
    );
    expect(evidRun).toContain('"${EXTRA_ARGS[@]}"');
    // T3-3: the release tag is passed as `--ref` (derived from VERSION inside
    // the script, no inline ${{ }}) so a manual rollback run that merely shares
    // the merge commit cannot be selected as this Release's evidence
    expect(evidRun).toContain('TAG="v${VERSION}"');
    expect(evidRun).toContain('--ref "$TAG"');
    // shared-path handoff: the extract step exports the path exactly once …
    const extract = steps.find((s) => s.id === "changelog");
    expect(extract?.run).toContain('echo "notes_file=${NOTES_FILE}" >> "$GITHUB_OUTPUT"');
    // … and this step consumes it without re-deriving it from RUNNER_TEMP/VERSION
    expect(evidRun).not.toContain("RUNNER_TEMP");
  });

  /**
   * Execute the evidence step body with stubbed `bun` (records the collector
   * argv it is handed) and `gh` (`release edit` recorded instead of mutating
   * anything), so the flag pairing is observed rather than pattern-matched.
   */
  function runEvidenceBody(
    body: string,
    env: Record<string, string>,
  ): { code: number; argv: string; notes: string; edited: string } {
    const dir = mkdtempSync(join(tmpdir(), "release-evidence-"));
    try {
      const notes = join(dir, "notes.txt");
      const argvLog = join(dir, "bun.log");
      const editLog = join(dir, "gh.log");
      writeFileSync(notes, "EN\n\n---\n\nCN");
      writeFileSync(argvLog, "");
      writeFileSync(editLog, "");
      writeFileSync(
        join(dir, "bun"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$BUN_STUB_LOG"
printf '### Deploy evidence\\n- Status: stub\\n'
`,
      );
      writeFileSync(
        join(dir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
exit 0
`,
      );
      Bun.spawnSync(["chmod", "+x", join(dir, "bun"), join(dir, "gh")]);
      const proc = Bun.spawnSync(["bash", "-e", "-c", body], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          NOTES_FILE: notes,
          GH_TOKEN: "stub-token",
          BUN_STUB_LOG: argvLog,
          GH_STUB_LOG: editLog,
          ...env,
        },
      });
      return {
        code: proc.exitCode,
        argv: readFileSync(argvLog, "utf8"),
        notes: readFileSync(notes, "utf8"),
        edited: readFileSync(editLog, "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("evidence step body EXECUTES: prerelease zeroes the wait, a boundary is forwarded, a clean release passes neither", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const body = steps.find((s) => s.run?.includes("collect-deploy-evidence.ts"))!.run!;
    const base = {
      MERGE_SHA: "a".repeat(40),
      DEPLOY_WORKFLOW: "deploy-prod.yml",
    };

    // A normal release that dispatched nothing: no boundary, no explicit wait
    // (the collector's 15-min default), section appended to the shared notes
    // file, one rewrite of the Release from that file.
    const release = runEvidenceBody(body, { ...base, VERSION: "9.9.9", SINCE_RUN: "" });
    expect(release.code).toBe(0);
    expect(release.argv).toContain("--workflow deploy-prod.yml --ref v9.9.9");
    expect(release.argv).not.toContain("--since-run");
    expect(release.argv).not.toContain("--wait-minutes");
    expect(release.notes).toContain("### Deploy evidence");
    expect(release.edited).toContain("release edit v9.9.9 --notes-file");

    // a rerun that dispatched a fresh run: the collector is told only runs past
    // the boundary it captured may be cited
    const bounded = runEvidenceBody(body, {
      ...base,
      VERSION: "9.9.9",
      SINCE_RUN: "4242",
    });
    expect(bounded.code).toBe(0);
    expect(bounded.argv).toContain("--since-run 4242");

    // a prerelease never dispatches, so the bounded wait is zeroed and the
    // section is written at once (with the same collector, same wording)
    const prerelease = runEvidenceBody(body, { ...base, VERSION: "9.9.9-alpha.1", SINCE_RUN: "" });
    expect(prerelease.code).toBe(0);
    expect(prerelease.argv).toContain("--wait-minutes 0");
    expect(prerelease.notes).toContain("### Deploy evidence");

    // mutation: without the zero-wait arm the prerelease would wait the full
    // window — the pin above is what stops that
    const mutated = body.replace("*-*) EXTRA_ARGS+=(--wait-minutes 0)", "*-*) :");
    expect(mutated).not.toBe(body);
    const unzeroed = runEvidenceBody(mutated, {
      ...base,
      VERSION: "9.9.9-alpha.1",
      SINCE_RUN: "",
    });
    expect(unzeroed.argv).not.toContain("--wait-minutes");
  });

  test("workflow-wide single-edit guard (QC A2, AD-3): exactly one `gh release edit` across ALL step runs", () => {
    const allRuns = (wf.jobs.release.steps as { run?: string }[])
      .map((s) => s.run ?? "")
      .join("\n---step---\n");
    // the rewrite happens once, from the evidence step — any second edit
    // call anywhere in the workflow breaks AD-3's single-idempotent-rewrite
    expect(allRuns.match(/gh release edit/g)).toHaveLength(1);
  });

  test("no direct `${{ }}` interpolation inside run: scripts (env indirection)", () => {
    const runs = (wf.jobs.release.steps as { run?: string }[])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).not.toContain("${{");
    }
  });
});
