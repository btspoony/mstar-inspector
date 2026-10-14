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
 *   queueing a duplicate on a release rerun (P2), with the step body executed
 *   against a stubbed `gh` for the reuse/fresh-dispatch paths;
 * - deploy-evidence append step: exactly one `gh release edit`
 *   workflow-wide (count across ALL step runs, not mere containment), its own
 *   step-level timeout budget bounded below the job cap, edit failure loud at
 *   the step level (::error + exit 1) while continue-on-error keeps the job
 *   green, and the notes file handed off from the extract step's
 *   `notes_file` output — never rebuilt from RUNNER_TEMP;
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
  });

  test("dispatch step body EXECUTES: rerun reuses a completed/in-flight run, dispatches when none or after failure", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const run = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;

    const dir = mkdtempSync(join(tmpdir(), "release-dispatch-"));
    try {
      // real tag so the step's own `git rev-list -n1 "$TAG"` resolves
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "t@example.com");
      git(dir, "config", "user.name", "t");
      writeFileSync(join(dir, "f.txt"), "x\n");
      git(dir, "add", "f.txt");
      git(dir, "commit", "-qm", "x");
      git(dir, "tag", "-a", "-m", "v9.9.9", "v9.9.9");

      // stub `gh`: `run list` applies the --jq expression the STEP passes to the
      // fixture JSON (so the real filter is under test); `workflow run` records
      // the dispatch instead of mutating the real repo.
      const log = join(dir, "gh.log");
      writeFileSync(log, "");
      writeFileSync(
        join(dir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "list" ]; then
  expr=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --jq) expr="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf '%s' "$GH_STUB_RUNS_JSON" | jq -r "$expr"
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

      const runOnce = (runsJson: string) => {
        writeFileSync(log, "");
        const proc = Bun.spawnSync(["bash", "-e", "-c", run], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GH_TOKEN: "stub-token",
            VERSION: "9.9.9",
            GH_STUB_RUNS_JSON: runsJson,
            GH_STUB_LOG: log,
          },
        });
        return {
          code: proc.exitCode,
          out: proc.stdout.toString() + proc.stderr.toString(),
          log: readFileSync(log, "utf8"),
        };
      };

      // 1) completed run for the commit → reuse, no dispatch (the rerun path)
      const completed = runOnce(
        '[{"databaseId":111,"status":"completed","conclusion":"success"}]',
      );
      expect(completed.code).toBe(0);
      expect(completed.out).toContain("::notice::reusing existing deploy-prod.yml run 111");
      expect(completed.log).toBe("");

      // 2) in-flight run (waiting for the owner's approval) → reuse, no dispatch
      const inFlight = runOnce(
        '[{"databaseId":222,"status":"waiting","conclusion":null}]',
      );
      expect(inFlight.code).toBe(0);
      expect(inFlight.out).toContain("::notice::reusing existing deploy-prod.yml run 222");
      expect(inFlight.log).toBe("");

      // 3) no run for the commit → fresh dispatch
      const none = runOnce("[]");
      expect(none.code).toBe(0);
      expect(none.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");

      // 4) newest run failed → a rerun after a failed deploy must retry
      const failed = runOnce(
        '[{"databaseId":333,"status":"completed","conclusion":"failure"}]',
      );
      expect(failed.code).toBe(0);
      expect(failed.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");

      // 5) newest run cancelled → also a retry, not a reuse
      const cancelled = runOnce(
        '[{"databaseId":444,"status":"completed","conclusion":"cancelled"}]',
      );
      expect(cancelled.code).toBe(0);
      expect(cancelled.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      // AC4: the evidence section must cite the PRODUCTION deploy run —
      // deploy.yml runs on the same main push and would be ambiguous
      DEPLOY_WORKFLOW: "deploy-prod.yml",
    });
    // … and the value reaches the collector as the `--workflow` argument
    expect(evidRun).toContain(
      'bun run scripts/collect-deploy-evidence.ts --workflow "$DEPLOY_WORKFLOW"',
    );
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
