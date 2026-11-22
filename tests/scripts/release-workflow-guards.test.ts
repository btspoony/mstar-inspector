import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { git } from "./helpers";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

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

function triggers(wf: Record<string, any>): Record<string, any> {
  const on = wf["true"];
  if (!on) throw new Error("workflow has no `on:` trigger block");
  return on;
}

const SHA_PIN = /^softprops\/action-gh-release@[0-9a-f]{40}$/;

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

  test("softprops/action-gh-release is the sole third-party action, SHA-pinned", () => {
    const uses = (wf.jobs.release.steps as { uses?: string }[])
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");
    const third = uses.filter((u) => !u.startsWith("actions/") && !u.startsWith("oven-sh/"));
    expect(third).toHaveLength(1);
    expect(third[0]).toMatch(SHA_PIN);
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
    expect(dispatchIdx).toBeGreaterThan(createIdx);
    expect(dispatchIdx).toBeLessThan(evidIdx);

    const dispatch = steps[dispatchIdx]!;
    expect(dispatch.id).toBe("dispatch");
    expect(dispatch.run).toContain('gh workflow run deploy-prod.yml --ref "$TAG"');
    expect(dispatch.run).not.toContain("-f ref=");
    expect(dispatch.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      VERSION: "${{ steps.ver.outputs.version }}",
    });
    expect(dispatch.run).not.toContain("${{");
    expect(dispatch["continue-on-error"]).toBeUndefined();
    expect(dispatch.if).toBe("${{ !contains(steps.ver.outputs.version, '-') }}");
    const lookupIdx = dispatch.run!.indexOf("gh run list --workflow deploy-prod.yml --commit");
    expect(lookupIdx).toBeGreaterThanOrEqual(0);
    expect(lookupIdx).toBeLessThan(dispatch.run!.indexOf("gh workflow run"));
    expect(dispatch.run).toContain("--json status,conclusion,databaseId,headBranch");
    expect(dispatch.run).toContain("select(.headBranch == $tag)");
    expect(dispatch.run).toContain("--limit 100");
    expect(dispatch.run!.match(/gh run list[^\n]*\n[^\n]*--limit 100 --json/) !== null).toBe(true);
    expect(dispatch.run).not.toContain(".[0] // empty");
    expect(dispatch.run!.match(/gh run list/g)).toHaveLength(1);
    expect(dispatch.run).toContain("map(.databaseId) | max // empty");
    expect(dispatch.run).toContain('echo "since_run=${BOUNDARY}" >> "$GITHUB_OUTPUT"');
    expect(dispatch.run).toContain("map(.databaseId) | max // empty");
    expect(dispatch.run).toContain('BOUNDARY="$(printf');
    expect(dispatch.run).toContain(
      "first(.[] | select(.headBranch == $tag)) // empty |",
    );
    expect(dispatch.run).toContain('gh run view "$REUSE_ID" --json jobs');
    expect(dispatch.run).toContain(
      'Bun.YAML.parse(await Bun.file(".github/workflows/deploy-prod.yml")',
    );
    expect(dispatch.run).toContain('job?.environment === "production"');
    expect(dispatch.run).toContain("console.log(job.name ?? id)");
    expect(dispatch.run).toContain('--arg job "$DEPLOY_JOB"');
    expect(dispatch.run).toContain('jq -c --arg job "$DEPLOY_JOB" \'first(.jobs[]? | select(.name == $job)) // {}\'');
    expect(dispatch.run).toContain('jq -r \'.status // empty\'');
    expect(dispatch.run).toContain('jq -r \'.conclusion // empty\'');
    expect(dispatch.run).toContain(
      '[ "$REUSE_STATUS" != "completed" ] && [ "$REUSE_EVENT" = "workflow_dispatch" ]',
    );
    expect(dispatch.run).toContain('[ "$DEPLOY_JOB_STATUS" = "in_progress" ] \\');
    expect(dispatch.run).toContain('[ "$DEPLOY_JOB_STATUS" = "waiting" ]; then');
    expect(dispatch.run).toContain('[ "$DEPLOY_JOB_CONCLUSION" = "success" ] \\');
    expect(dispatch.run).toContain('if [ "$REUSE_RUN" = "true" ]; then');
    expect(dispatch.run).toContain("--json status,conclusion,databaseId,headBranch,event");
    expect(dispatch.run).toContain('"\\(.databaseId) \\(.status) \\(.conclusion // "-") \\(.event)"');
    expect(dispatch.run).toContain("read -r REUSE_ID REUSE_STATUS REUSE_CONCLUSION REUSE_EVENT <<<");
  });

  function makeDispatchFixture(): {
    dir: string;
    log: string;
    argv: string;
    output: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "release-dispatch-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-qm", "x");
    git(dir, "tag", "-a", "-m", "v9.9.9", "v9.9.9");

    const workflows = join(dir, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, "deploy-prod.yml"),
      readFileSync(join(REPO_ROOT, ".github", "workflows", "deploy-prod.yml")),
    );

    const log = join(dir, "gh.log");
    const argv = join(dir, "gh-argv.log");
    const output = join(dir, "output.txt");
    writeFileSync(log, "");
    writeFileSync(argv, "");
    writeFileSync(output, "");
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "list" ]; then
  printf 'run list %s\\n' "$*" >> "$GH_STUB_ARGV_LOG"
  # gh's page size: --limit N / -L N / --limit=N, else its 20-row default.
  limit=20
  args=("$@")
  i=0
  while [ "$i" -lt "\${#args[@]}" ]; do
    a="\${args[$i]}"
    case "$a" in
      --limit|-L) i=$((i+1)); limit="\${args[$i]:-20}" ;;
      --limit=*) limit="\${a#--limit=}" ;;
    esac
    i=$((i+1))
  done
  printf '%s' "$GH_STUB_RUNS_JSON" | jq --argjson n "\${limit:-20}" 'if length > $n then .[0:$n] else . end'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "view" ]; then
  printf 'run view %s\\n' "$*" >> "$GH_STUB_ARGV_LOG"
  # The deploy job as the workflow declares it (id + display name), plus the
  # guard the run starts with. A job status is one of queued / in_progress /
  # completed; "absent" means the deploy job was never created for this run.
  if [ "\${GH_STUB_DEPLOY_STATUS:-}" = "absent" ]; then
    jq -n '{jobs:[{name:"guard-tag-ref",status:"in_progress",conclusion:null}]}'
  else
    jq -n --arg s "\${GH_STUB_DEPLOY_STATUS:-completed}" \
      --arg c "\${GH_STUB_DEPLOY_CONCLUSION-success}" \
      '{jobs:[{name:"guard-tag-ref",status:"completed",conclusion:"success"},{name:"deploy",status:$s,conclusion:(if $c == "" then null else $c end)}]}'
  fi
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
    return { dir, log, argv, output };
  }

  function runDispatchBody(
    fixture: { dir: string; log: string; argv: string; output: string },
    body: string,
    runsJson: string,
    deployJob: { status: string; conclusion?: string } = { status: "completed", conclusion: "success" },
  ): { code: number; out: string; log: string; argv: string; exported: string } {
    writeFileSync(fixture.log, "");
    writeFileSync(fixture.argv, "");
    writeFileSync(fixture.output, "");
    const proc = Bun.spawnSync(["bash", "-e", "-c", body], {
      cwd: fixture.dir,
      env: {
        ...process.env,
        PATH: `${fixture.dir}:${process.env.PATH}`,
        GH_TOKEN: "stub-token",
        VERSION: "9.9.9",
        GH_STUB_RUNS_JSON: runsJson,
        GH_STUB_DEPLOY_STATUS: deployJob.status,
        GH_STUB_DEPLOY_CONCLUSION: deployJob.conclusion ?? "",
        GH_STUB_LOG: fixture.log,
        GH_STUB_ARGV_LOG: fixture.argv,
        GITHUB_OUTPUT: fixture.output,
      },
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString() + proc.stderr.toString(),
      log: readFileSync(fixture.log, "utf8"),
      argv: readFileSync(fixture.argv, "utf8"),
      exported: readFileSync(fixture.output, "utf8"),
    };
  }

  test("dispatch step body EXECUTES: reuse only an in-flight or successful run OF THIS TAG, dispatch for every other outcome", { timeout: 15_000 }, () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const run = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;

    const REUSE = true;
    const DISPATCH = false;
    const deepPageRuns = JSON.stringify([
      ...Array.from({ length: 24 }, (_, i) => ({
        databaseId: 2000 - i,
        status: "completed",
        conclusion: "success",
        headBranch: `v9.8.${30 - i}`,
      })),
      { databaseId: 1900, status: "waiting", conclusion: null, headBranch: "v9.9.9", event: "release" },
      ...Array.from({ length: 6 }, (_, i) => ({
        databaseId: 1800 - i,
        status: "completed",
        conclusion: "success",
        headBranch: `v9.8.${20 - i}`,
      })),
    ]);
    const cases: {
      runs: string;
      reuse: boolean;
      label: string;
      boundary: number | null;
      reuseId?: number;
      deployJob?: { status: string; conclusion?: string };
      jobCheck?: boolean;
    }[] = [
      { runs: "[]", reuse: DISPATCH, label: "no run for the commit", boundary: null },
      {
        runs: '[{"databaseId":1,"status":"completed","conclusion":"success","headBranch":"v9.9.9","event":"workflow_dispatch"}]',
        reuse: REUSE,
        label: "success (deploy job ran)",
        boundary: null,
        reuseId: 1,
        jobCheck: true,
      },
      {
        runs: '[{"databaseId":4,"status":"completed","conclusion":"success","headBranch":"v9.9.9","event":"release"}]',
        reuse: DISPATCH,
        label: "guard-only run (deploy job skipped) — success conclusion is not a deployment",
        boundary: 4,
        deployJob: { status: "completed", conclusion: "skipped" },
      },
      {
        runs: '[{"databaseId":5,"status":"completed","conclusion":"success","headBranch":"v9.9.9","event":"release"}]',
        reuse: DISPATCH,
        label: "guard-only run (deploy job absent from the job list)",
        boundary: 5,
        deployJob: { status: "absent" },
      },
      {
        runs: '[{"databaseId":6,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: DISPATCH,
        label: "in-flight release run in the guard phase (deploy job queued)",
        boundary: 6,
        deployJob: { status: "queued" },
      },
      {
        runs: '[{"databaseId":7,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: DISPATCH,
        label: "in-flight release run in the guard phase (deploy job not yet created)",
        boundary: 7,
        deployJob: { status: "absent" },
      },
      {
        runs: '[{"databaseId":8,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: REUSE,
        label: "in-flight release run, deploy job in_progress",
        boundary: null,
        reuseId: 8,
        deployJob: { status: "in_progress" },
        jobCheck: true,
      },
      {
        runs: '[{"databaseId":9,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: REUSE,
        label: "in-flight release run, deploy job waiting for approval",
        boundary: null,
        reuseId: 9,
        deployJob: { status: "waiting" },
        jobCheck: true,
      },
      {
        runs: '[{"databaseId":11,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: REUSE,
        label: "in-flight release run whose deploy job already succeeded",
        boundary: null,
        reuseId: 11,
        deployJob: { status: "completed", conclusion: "success" },
        jobCheck: true,
      },
      {
        runs: '[{"databaseId":12,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]',
        reuse: DISPATCH,
        label: "in-flight release run whose deploy job already failed",
        boundary: 12,
        deployJob: { status: "completed", conclusion: "failure" },
      },
      {
        runs: '[{"databaseId":10,"status":"waiting","conclusion":null,"headBranch":"v9.9.9","event":"workflow_dispatch"}]',
        reuse: REUSE,
        label: "in-flight workflow_dispatch run (always deploys)",
        boundary: null,
        reuseId: 10,
        deployJob: { status: "absent" },
        jobCheck: false,
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
      {
        runs:
          '[{"databaseId":70,"status":"completed","conclusion":"success","headBranch":"v9.9.8"},' +
          '{"databaseId":71,"status":"completed","conclusion":"success","headBranch":"v9.9.9"}]',
        reuse: REUSE,
        label: "foreign newer run listed first, same-tag run behind it",
        boundary: null,
        reuseId: 71,
      },
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
      {
        runs:
          '[{"databaseId":80,"status":"completed","conclusion":"failure","headBranch":"v9.9.9"},' +
          '{"databaseId":20,"status":"completed","conclusion":"success","headBranch":"v9.9.9"}]',
        reuse: DISPATCH,
        label: "superseded failure ahead of an older success on this tag",
        boundary: 80,
      },
      {
        runs: deepPageRuns,
        reuse: REUSE,
        label: "reusable same-tag run on row 25 of a 31-row page",
        boundary: null,
        reuseId: 1900,
        deployJob: { status: "waiting" },
      },
    ];

    const fixture = makeDispatchFixture();
    try {
      for (const c of cases) {
        const result = runDispatchBody(fixture, run, c.runs, c.deployJob);
        expect(result.code, `${c.label}: exit code`).toBe(0);
        if (c.jobCheck !== undefined) {
          expect(result.argv.includes("run view"), `${c.label}: job check`).toBe(c.jobCheck);
        }
        if (c.reuse) {
          expect(result.out, `${c.label}: reuse notice`).toContain(
            "::notice::reusing existing deploy-prod.yml run",
          );
          expect(result.out, `${c.label}: reuses the same-tag run`).toContain(
            `reusing existing deploy-prod.yml run ${c.reuseId} for v9.9.9`,
          );
          expect(result.log, `${c.label}: no dispatch`).toBe("");
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
      expect(narrowed.exported).toBe("since_run=\n");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("MUTATION/reverting the page size to gh's default: a reusable run on row 25 is missed and a duplicate deploy is queued (Codex P2 round 4)", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const src = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;
    const dropped = src.replace(" --limit 100 --json", " --json");
    expect(dropped).not.toBe(src);
    const narrowed = src.replace("--limit 100 --json", "--limit 1 --json");
    expect(narrowed).not.toBe(src);

    const deepPage = JSON.stringify([
      ...Array.from({ length: 24 }, (_, i) => ({
        databaseId: 2000 - i,
        status: "completed",
        conclusion: "success",
        headBranch: `v9.8.${30 - i}`,
      })),
      { databaseId: 1900, status: "completed", conclusion: "success", headBranch: "v9.9.9" },
    ]);

    const fixture = makeDispatchFixture();
    try {
      const fixed = runDispatchBody(fixture, src, deepPage);
      expect(fixed.code).toBe(0);
      expect(fixed.argv).toContain("--limit 100");
      expect(fixed.out).toContain("reusing existing deploy-prod.yml run 1900 for v9.9.9");
      expect(fixed.log).toBe("");

      const defaulted = runDispatchBody(fixture, dropped, deepPage);
      expect(defaulted.code).toBe(0);
      expect(defaulted.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");
      expect(defaulted.exported).toBe("since_run=2000\n");

      const one = runDispatchBody(fixture, narrowed, deepPage);
      expect(one.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("MUTATION/dropping the deploy-job check: a guard-only run is reused and production never changes (Codex P2 round 4)", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const src = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;
    const mutated = src.replace(
      'if [ "$DEPLOY_JOB_CONCLUSION" = "success" ]; then',
      "if true; then",
    );
    expect(mutated).not.toBe(src);

    const guardOnly =
      '[{"databaseId":4,"status":"completed","conclusion":"success","headBranch":"v9.9.9","event":"release"}]';
    const skipped = { status: "completed", conclusion: "skipped" };
    const fixture = makeDispatchFixture();
    try {
      const fixed = runDispatchBody(fixture, src, guardOnly, skipped);
      expect(fixed.code).toBe(0);
      expect(fixed.out).toContain("was skipped");
      expect(fixed.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");

      const unfixed = runDispatchBody(fixture, mutated, guardOnly, skipped);
      expect(unfixed.out).toContain("reusing existing deploy-prod.yml run 4 for v9.9.9");
      expect(unfixed.log).toBe("");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("MUTATION/treating an unstarted deploy job as reusable: the guard-phase run is reused and never deploys (Codex P2 round 5)", () => {
    const steps = wf.jobs.release.steps as { run?: string }[];
    const src = steps.find((s) => s.run?.includes("gh workflow run deploy-prod.yml"))!.run!;
    const mutated = src.replace(
      'elif [ "$DEPLOY_JOB_CONCLUSION" = "success" ] \\\n' +
        '      || [ "$DEPLOY_JOB_STATUS" = "in_progress" ] \\\n' +
        '      || [ "$DEPLOY_JOB_STATUS" = "waiting" ]; then',
      'elif [ "$DEPLOY_JOB_STATUS" != "completed" ]; then',
    );
    expect(mutated).not.toBe(src);

    const guardPhase =
      '[{"databaseId":6,"status":"in_progress","conclusion":null,"headBranch":"v9.9.9","event":"release"}]';
    const fixture = makeDispatchFixture();
    try {
      const fixed = runDispatchBody(fixture, src, guardPhase, { status: "queued" });
      expect(fixed.code).toBe(0);
      expect(fixed.out).toContain("not yet deploying");
      expect(fixed.log).toContain("DISPATCH workflow run deploy-prod.yml --ref v9.9.9");

      const unfixed = runDispatchBody(fixture, mutated, guardPhase, { status: "queued" });
      expect(unfixed.out).toContain("reusing existing deploy-prod.yml run 6 for v9.9.9");
      expect(unfixed.log).toBe("");
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
    expect(evidIdx).toBeGreaterThan(createIdx);

    const evid = steps[evidIdx]!;
    const evidRun = evid.run!;
    expect(evid["timeout-minutes"]).toBe(18);
    expect(evid["continue-on-error"]).toBe(true);
    expect(evidRun).toContain("::error::");
    expect(evidRun).toContain("exit 1");
    expect(evidRun).toContain("printf '\\n\\n---\\n\\n' >> \"$NOTES_FILE\"");
    expect(evidRun).toContain('gh release edit "v${VERSION}" --notes-file "$NOTES_FILE"');
    expect(evidRun.match(/gh release edit/g)).toHaveLength(1);
    expect(evidRun).not.toContain("${{");
    expect(evid.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      VERSION: "${{ steps.ver.outputs.version }}",
      MERGE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
      NOTES_FILE: "${{ steps.changelog.outputs.notes_file }}",
      SINCE_RUN: "${{ steps.dispatch.outputs.since_run }}",
      DEPLOY_WORKFLOW: "deploy-prod.yml",
    });
    expect(evidRun).toContain('[ -n "$SINCE_RUN" ]');
    expect(evidRun).toContain('EXTRA_ARGS+=(--since-run "$SINCE_RUN")');
    expect(evidRun).toContain("case \"$VERSION\" in");
    expect(evidRun).toContain("*-*) EXTRA_ARGS+=(--wait-minutes 0)");
    expect(evidRun).toContain(
      'bun run scripts/collect-deploy-evidence.ts --workflow "$DEPLOY_WORKFLOW"',
    );
    expect(evidRun).toContain('"${EXTRA_ARGS[@]}"');
    expect(evidRun).toContain('TAG="v${VERSION}"');
    expect(evidRun).toContain('--ref "$TAG"');
    const extract = steps.find((s) => s.id === "changelog");
    expect(extract?.run).toContain('echo "notes_file=${NOTES_FILE}" >> "$GITHUB_OUTPUT"');
    expect(evidRun).not.toContain("RUNNER_TEMP");
  });

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

    const release = runEvidenceBody(body, { ...base, VERSION: "9.9.9", SINCE_RUN: "" });
    expect(release.code).toBe(0);
    expect(release.argv).toContain("--workflow deploy-prod.yml --ref v9.9.9");
    expect(release.argv).not.toContain("--since-run");
    expect(release.argv).not.toContain("--wait-minutes");
    expect(release.notes).toContain("### Deploy evidence");
    expect(release.edited).toContain("release edit v9.9.9 --notes-file");

    const bounded = runEvidenceBody(body, {
      ...base,
      VERSION: "9.9.9",
      SINCE_RUN: "4242",
    });
    expect(bounded.code).toBe(0);
    expect(bounded.argv).toContain("--since-run 4242");

    const prerelease = runEvidenceBody(body, { ...base, VERSION: "9.9.9-alpha.1", SINCE_RUN: "" });
    expect(prerelease.code).toBe(0);
    expect(prerelease.argv).toContain("--wait-minutes 0");
    expect(prerelease.notes).toContain("### Deploy evidence");

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
