/**
 * invariant: `.github/workflows/refresh-catalog.yml` guards.
 *
 * The workflow runs unattended against a live registry, writes to a branch and
 * opens a pull request. Three things must hold every night, and none of them is
 * observable from a successful run:
 *
 *   1. It never pushes to `main` — the push target is the fixed branch literal.
 *   2. It never creates a second pull request for the same branch — an open PR
 *      from `chore/catalog-refresh` is updated in place.
 *   3. NOTHING IS PUBLISHED UNLESS IT IS GREEN. Verification runs before any
 *      push; a failing typecheck or test aborts the run with no commit, no
 *      force-push and no PR create/update. The Actions page is the signal, and
 *      an already-open green PR is left untouched.
 *
 * The publishing claims are proved BEHAVIOURALLY: the steps' own scripts run
 * against a stub `gh`/`git` that records argv, so a removed guard fails the test
 * instead of passing on a substring.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdict } from "../../scripts/provider-catalog/pr-verdict";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

function parseWorkflow(rel: string): Record<string, any> {
  const path = join(REPO_ROOT, ".github", "workflows", rel);
  const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${rel} is not valid YAML: ${proc.stderr.toString()}`);
  return JSON.parse(proc.stdout.toString()) as Record<string, any>;
}

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};

const wf = parseWorkflow("refresh-catalog.yml");
const steps = wf.jobs.refresh.steps as Step[];
const byId = new Map(steps.filter((step) => step.id !== undefined).map((step) => [step.id!, step]));
const runs = steps.map((step) => step.run ?? "").join("\n---step---\n");

describe("refresh-catalog.yml trigger and permissions", () => {
  test("runs daily off-peak plus a manual dispatch", () => {
    const on = wf["true"] as { schedule: { cron: string }[]; workflow_dispatch: unknown };
    expect(on.schedule).toHaveLength(1);
    // why: Off-peak UTC, and not on the hour (avoids the cron stampede at :00).
    expect(on.schedule[0]!.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(Number(on.schedule[0]!.cron.split(" ")[0])).toBeGreaterThan(0);
    expect(Object.hasOwn(on, "workflow_dispatch")).toBe(true);
  });

  test("writes contents (the branch) and pull requests (the PR) — nothing else", () => {
    expect(wf.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  });
});

describe("refresh-catalog.yml step chain", () => {
  test("the required steps appear in dependency order", () => {
    // why: Position in the chain matters: fetch before regenerate, regenerate before
    // the fingerprint repair, the diff gate before verification.
    const order = [
      "Fetch the models.dev snapshot",
      "Regenerate the catalog",
      "Repair the image-input fingerprint",
      "Decide whether anything changed",
      "Typecheck",
      "Test",
      "Decide whether this run may publish",
      "Commit and force-update the refresh branch",
      "Open or update the refresh PR",
    ];
    const positions = order.map((name) => steps.findIndex((step) => step.name === name));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("the fetch and regenerate commands are the scripts' own entry points", () => {
    expect(byId.get("diff")).toBeDefined();
    expect(runs).toContain("bun run scripts/provider-catalog/fetch-models-dev.ts");
    expect(runs).toContain("bun run provider:catalog");
    expect(runs).toContain("bun scripts/check-image-inputs.ts --base origin/main --write");
    expect(runs).toContain("bun run typecheck");
    expect(runs).toContain("bun test tests");
  });

  test("an unchanged tree stops before verification and before any PR step", () => {
    const gate = steps.findIndex((step) => step.name === "Decide whether anything changed");
    for (const name of ["Typecheck", "Test", "Commit and force-update the refresh branch", "Open or update the refresh PR"]) {
      const step = steps.find((candidate) => candidate.name === name)!;
      expect(step.if, name).toBe("steps.diff.outputs.changed == 'true'");
      expect(steps.indexOf(step)).toBeGreaterThan(gate);
    }
    expect(byId.get("diff")!.run).toContain("git diff --cached --quiet");
  });
});

describe("refresh-catalog.yml guards", () => {
  test("never pushes to main — the only push target is the branch variable, guarded", () => {
    expect(wf.jobs.refresh.env.BRANCH).toBe("chore/catalog-refresh");
    expect(runs).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(runs).not.toMatch(/git push[^\n]*\bHEAD:main\b/);
    // why: The push names the branch variable, and the step refuses the literal main.
    expect(runs).toContain('git push --force origin "$BRANCH"');
    expect(runs).toContain('[ "$BRANCH" = "main" ]');
  });

  test("never creates a duplicate PR: an open PR for the branch is updated in place", () => {
    const prStep = steps.find((step) => step.name === "Open or update the refresh PR")!;
    const script = prStep.run!;
    expect(script).toContain("gh pr list --head \"$BRANCH\" --state open --json number");
    expect(script).toContain("gh pr edit");
    // why: Not "the word else appears somewhere": `gh pr create` must sit INSIDE the
    // branch taken when the lookup found nothing. The script is run here (with
    // `gh` stubbed) under both cases, so removing the guard makes this fail
    // instead of passing on the title branch's `else`.
    expect(script).toMatch(/if \[ -n "\$OPEN" \]; then/);
    expect(script).toMatch(/else\s+gh pr create/);
    expect(script.indexOf("gh pr create")).toBeGreaterThan(script.indexOf("else"));
    expect(script.slice(script.indexOf("gh pr create"))).toContain('--head "$BRANCH"');
    expect(script.slice(script.indexOf("gh pr create"))).toContain("--base main");
  });

  test("the create/update choice is exercised, not just read", () => {
    // why: A stub `gh` that records its argv; the step's own script drives it.
    const prStep = steps.find((step) => step.name === "Open or update the refresh PR")!;
    for (const [open, expected] of [
      ["", "create"],
      ["7", "edit"],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "pr-step-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        const record = join(dir, "argv.log");
        writeFileSync(
          join(bin, "gh"),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\n` +
            `case "$1 $2" in\n  "pr list") echo ${JSON.stringify(open)} ;;\nesac\n`,
        );
        chmodSync(join(bin, "gh"), 0o755);
        // note: The step's script with its env; only `gh` is stubbed.
        const script = `BRANCH=chore/catalog-refresh\nRUNNER_TEMP=${JSON.stringify(dir)}\n` +
          `printf 'body\\n' > "$RUNNER_TEMP/pr-body.md"\n${prStep.run}`;
        const proc = Bun.spawnSync(["bash", "-e", "-c", script], {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x" },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(proc.exitCode, proc.stderr.toString()).toBe(0);
        const calls = readFileSync(record, "utf8");
        expect(calls).toContain("pr list");
        if (expected === "create") {
          expect(calls).toContain("pr create");
          expect(calls).not.toContain("pr edit");
        } else {
          expect(calls).toContain("pr edit 7");
          expect(calls).not.toContain("pr create");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("nothing is published unless the tree is green", () => {
    // why: Verification STOPS the run: no `continue-on-error` (a swallowed failure
    // would let the publishing steps proceed), and the gate step is a hard
    // `run:` that exits non-zero on any red signal.
    for (const id of ["typecheck", "test"]) {
      expect(byId.get(id)!.run, id).toBeDefined();
      expect(byId.get(id)!["continue-on-error"], id).toBeUndefined();
      expect(byId.get(id)!.if, id).toBe("steps.diff.outputs.changed == 'true'");
    }
    const gate = byId.get("gate")!;
    expect(gate).toBeDefined();
    expect(gate.run).toContain("scripts/provider-catalog/pr-verdict.ts");
    expect(gate.run).toContain("$TYPECHECK_OUTCOME");
    expect(gate.run).toContain("$TEST_OUTCOME");
    // why: The gate precedes every publishing step.
    const gateAt = steps.indexOf(gate);
    for (const name of ["Build the PR body", "Commit and force-update the refresh branch", "Open or update the refresh PR"]) {
      expect(steps.indexOf(steps.find((step) => step.name === name)!), name).toBeGreaterThan(gateAt);
    }
    // why: And no artefact of the retired "ship it red" design survives.
    expect(runs).not.toContain("⚠ tests red");
    expect(runs).not.toContain("checks red");
    const body = steps.find((step) => step.name === "Build the PR body")!;
    expect(body.run).not.toContain("❌");
    expect(body.run).not.toContain("✅");
    // why: No auto-merge, ever: the PR is a review surface, not a merge trigger.
    expect(runs).not.toContain("--auto");
    expect(runs).not.toContain("gh pr merge");
  });

  test("a red run publishes nothing: the verdict gate exits non-zero before any push", () => {
    // note: The decision function, as the gate uses it.
    expect(verdict("success", "failure", "").green).toBe(false);
    expect(verdict("failure", "success", "").green).toBe(false);
    expect(verdict("success", "success", " 10 pass\n 3 fail\n").green).toBe(false);
    expect(verdict("success", "success", " 5679 pass\n 0 fail\n").green).toBe(true);
  });

  test("the test step's exit status is the test's, not `tee`'s", () => {
    // why: The workflow declares no `shell:`, so GitHub runs `bash -e {0}` — and a
    // bare `bun test | tee` reports 0 through tee even when the suite fails. Any
    // pipeline into `tee` must be preceded by `pipefail`.
    const test = byId.get("test")!;
    if (/\|\s*tee\b/.test(test.run!)) expect(test.run).toMatch(/set -o pipefail/);
    expect(test.run).toContain('"${RUNNER_TEMP}/test.log"');
    // why: Belt and braces, asserted as the DECISION the gate makes: even if that
    // construct were lost (step reports success) a log that records failures
    // must refuse publication — that is the round-1 bug, and this is the proof
    // it cannot come back silently.
    const lostStatus = verdict("success", "success", " 5679 pass\n 79 fail\n");
    expect(lostStatus.green).toBe(false);
    expect(lostStatus.reason).toContain("79");
  });

  test("a red run performs no git push and no gh pr create (stubbed tools)", () => {
    // why: The REAL gate, the REAL push step and the REAL PR step, in a scratch
    // directory, with `git` and `gh` replaced by argv recorders. Each case runs
    // the whole chain under `bash -e` exactly as the job does: if the gate exits
    // non-zero, `bash -e` stops before the publishing steps — which is the
    // property, not a claim about it. The green case proves the chain CAN reach
    // them, so an empty recorder in the red cases means something.
    const gate = byId.get("gate")!;
    const push = steps.find((step) => step.name === "Commit and force-update the refresh branch")!;
    const pr = steps.find((step) => step.name === "Open or update the refresh PR")!;
    const verdictScript = join(REPO_ROOT, "scripts/provider-catalog/pr-verdict.ts");

    /** note: Run the chain; return the recorder's lines. */
    const chain = (log: string, typecheck: string, test: string): { code: number; calls: string[] } => {
      const dir = mkdtempSync(join(tmpdir(), "publish-"));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        const record = join(dir, "argv.log");
        for (const tool of ["git", "gh"]) {
          writeFileSync(
            join(bin, tool),
            `#!/bin/sh\nprintf '%s %s\\n' ${JSON.stringify(tool)} "$*" >> ${JSON.stringify(record)}\n` +
              // note: `gh pr list` reports no open PR, so the create path is the one
              // a broken gate would take.
              `case "$*" in\n  *"pr list"*) echo "" ;;\nesac\n`,
          );
          chmodSync(join(bin, tool), 0o755);
        }
        writeFileSync(join(dir, "test.log"), log);
        writeFileSync(join(dir, "pr-body.md"), "body\n");
        // note: The gate's script, with the repo-relative path made absolute: the
        // cwd is the scratch dir, and a broken path would make bun fail for the
        // wrong reason (round 4 caught exactly that).
        const gateRun = gate.run!.replace("scripts/provider-catalog/pr-verdict.ts", verdictScript);
        expect(gateRun).not.toContain("bun run scripts/");
        const script = [
          `RUNNER_TEMP=${JSON.stringify(dir)}`,
          "BRANCH=chore/catalog-refresh",
          `TYPECHECK_OUTCOME=${typecheck}`,
          `TEST_OUTCOME=${test}`,
          gateRun,
          push.run,
          pr.run,
        ].join("\n");
        const proc = Bun.spawnSync(["bash", "-e", "-c", script], {
          cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const calls = existsSync(record)
          ? readFileSync(record, "utf8").split("\n").filter((line) => line !== "")
          : [];
        return { code: proc.exitCode ?? -1, calls };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // note: Red: failing typecheck. Red: a lost exit status with a failing log.
    for (const red of [
      chain(" 1 pass\n 0 fail\n", "failure", "success"),
      chain(" 1 pass\n 79 fail\n", "success", "success"),
    ]) {
      expect(red.code).not.toBe(0);
      expect(red.calls.filter((line) => line.includes("push"))).toEqual([]);
      expect(red.calls.filter((line) => line.includes("pr create"))).toEqual([]);
      expect(red.calls.filter((line) => line.includes("pr edit"))).toEqual([]);
    }

    // why: Green reaches both steps — the control that makes the empty red recorders
    // meaningful.
    const green = chain(" 5679 pass\n 0 fail\n", "success", "success");
    expect(green.code, JSON.stringify(green.calls)).toBe(0);
    expect(green.calls.some((line) => line.includes("push --force origin chore/catalog-refresh"))).toBe(true);
    expect(green.calls.some((line) => line.includes("pr create"))).toBe(true);
  });

  test("every trigger builds from the default branch, never from a dispatched feature branch", () => {
    // why: `workflow_dispatch` may be run from any branch; without a pinned ref the
    // refresh branch (and its PR) would carry that branch's unmerged commits
    // while the removals diff still compares origin/main.
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"))!;
    expect(checkout.with?.ref).toContain("github.event.repository.default_branch");
  });

  test("the PR body reports catalog removals and the pin movement", () => {
    const body = steps.find((step) => step.name === "Build the PR body")!;
    // note: The base revision's committed module is the comparison input.
    expect(body.run).toContain("git show \"origin/main:src/contracts/provider-catalog.generated.ts\"");
    expect(body.run).toContain("scripts/provider-catalog/catalog-changes.ts");
    expect(body.run).toContain("## Catalog removals");
    expect(body.run).toContain("## SDK pins");
    expect(byId.has("pins")).toBe(true);
    expect(byId.get("pins")!.run).toContain("scripts/provider-catalog/bump-pins.ts");
  });

  test("an unpublished SDK version does not fail the run", () => {
    const latest = steps.find((step) => step.name === "Resolve the newest published SDK versions")!;
    // note: `npm view` failures are tolerated; the pin step treats "unknown" as a skip.
    expect(latest.run).toContain("set +e");
    expect(latest.run).toContain("unknown");
    expect(byId.get("pins")!.run).toContain('"$OMP_LATEST" != "unknown"');
    expect(byId.get("pins")!.run).toContain('"$ENGINE_LATEST" != "unknown"');
    // why: An engine release whose CLI is not published yet cannot build the image
    // (the CLI pin is installed from a frozen lock at HARNESS_VERSION).
    expect(latest.run).toContain('npm view "@mstar-harness/cli@${ENGINE}" version');
    expect(byId.get("pins")!.run).toContain('"$CLI_STATE" != "available"');
    // why: A version bump with no annotated tag must HOLD the pins: the version, the
    // CLI pin, harnessRef and the Dockerfile tag anchor describe one release, so
    // a version-only move is a half-moved tree (round 4's wedge). `ENGINE_ARG` is
    // set only inside the branch where the dereferenced tag exists.
    const pins = byId.get("pins")!.run!;
    const tagGuard = pins.indexOf('refs/tags/v${ENGINE_LATEST}^{}');
    const setEngine = pins.indexOf('ENGINE_ARG="$ENGINE_LATEST"');
    expect(tagGuard).toBeGreaterThan(-1);
    expect(setEngine).toBeGreaterThan(tagGuard);
    // note: …and the missing-tag branch must not set it.
    const missing = pins.slice(pins.indexOf('if [ -z "$REF" ]'), setEngine);
    expect(missing).not.toContain('ENGINE_ARG=');
    expect(pins).toContain("holding the pins");
  });

  test("the pins step delegates to bump-pins, which owns every lock beside a manifest", () => {
    // why: The workflow used to re-do the runner lock itself; a second implementation
    // drifted from the script's documented local path (the review caught the
    // local path leaving both locks stale). One owner, one behaviour.
    const pins = byId.get("pins")!.run!;
    expect(pins).toContain("scripts/provider-catalog/bump-pins.ts");
    expect(pins).not.toContain("bun install --lockfile-only");
    expect(pins).toContain("PINS=(");
    expect(pins).toContain("git checkout -- \"${PINS[@]}\"");
    // why: The rollback must cover every lock the script may have rewritten.
    for (const path of ["package.json", "bun.lock", "packages/runner/package.json", "packages/runner/bun.lock"]) {
      expect(pins, path).toContain(path);
    }
  });
});
