/**
 * `.github/workflows/refresh-catalog.yml` guards.
 *
 * The workflow runs unattended against a live registry, writes to a branch and
 * opens a pull request. Three things must hold every night, and none of them is
 * observable from a successful run:
 *
 *   1. It never pushes to `main` — the push target is the fixed branch literal.
 *   2. It never creates a second pull request for the same branch — an open PR
 *      from `chore/catalog-refresh` is updated in place.
 *   3. Red checks are LABELLED as red: the title and the body both say so, and
 *      the test/typecheck steps must therefore be allowed to fail (a plain
 *      `run:` would abort the job before the PR is opened).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

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
    // Off-peak UTC, and not on the hour (avoids the cron stampede at :00).
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
    // Position in the chain matters: fetch before regenerate, regenerate before
    // the fingerprint repair, the diff gate before verification.
    const order = [
      "Fetch the models.dev snapshot",
      "Regenerate the catalog",
      "Repair the image-input fingerprint",
      "Decide whether anything changed",
      "Typecheck",
      "Test",
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
    // The push names the branch variable, and the step refuses the literal main.
    expect(runs).toContain('git push --force origin "$BRANCH"');
    expect(runs).toContain('[ "$BRANCH" = "main" ]');
  });

  test("never creates a duplicate PR: an open PR for the branch is updated in place", () => {
    const prStep = steps.find((step) => step.name === "Open or update the refresh PR")!;
    expect(prStep.run).toContain("gh pr list --head \"$BRANCH\" --state open --json number");
    expect(prStep.run).toContain("gh pr edit");
    // `create` only runs in the else branch of the open-PR test.
    const create = prStep.run!.indexOf("gh pr create");
    expect(prStep.run!.slice(0, create)).toContain("else");
    expect(prStep.run!.slice(create)).toContain('--head "$BRANCH"');
    expect(prStep.run!.slice(create)).toContain("--base main");
  });

  test("red checks are labelled: title and body both say so, and neither step aborts the job", () => {
    for (const id of ["typecheck", "test"]) {
      expect(byId.get(id)!.run, id).toBeDefined();
      // A hard failure would kill the job before the branch is pushed.
      expect(byId.get(id)!["continue-on-error"], id).toBe(true);
      expect(byId.get(id)!.if, id).toBe("steps.diff.outputs.changed == 'true'");
    }
    const body = steps.find((step) => step.name === "Build the PR body")!;
    expect(body.run).toContain('grep -q \'❌\'');
    expect(body.run).toContain("typecheck FAILED");
    expect(body.run).toContain("bun test tests FAILED");
    const prStep = steps.find((step) => step.name === "Open or update the refresh PR")!;
    expect(prStep.run).toContain("⚠ tests red");
    // No auto-merge, ever: the PR is a review surface, not a merge trigger.
    expect(runs).not.toContain("--auto");
    expect(runs).not.toContain("gh pr merge");
  });

  test("the PR body reports catalog removals and the pin movement", () => {
    const body = steps.find((step) => step.name === "Build the PR body")!;
    // The base revision's committed module is the comparison input.
    expect(body.run).toContain("git show \"origin/main:src/contracts/provider-catalog.generated.ts\"");
    expect(body.run).toContain("scripts/provider-catalog/catalog-changes.ts");
    expect(body.run).toContain("## Catalog removals");
    expect(body.run).toContain("## SDK pins");
    expect(byId.has("pins")).toBe(true);
    expect(byId.get("pins")!.run).toContain("scripts/provider-catalog/bump-pins.ts");
  });

  test("an unpublished SDK version does not fail the run", () => {
    const latest = steps.find((step) => step.name === "Resolve the newest published SDK versions")!;
    // `npm view` failures are tolerated; the pin step treats "unknown" as a skip.
    expect(latest.run).toContain("set +e");
    expect(latest.run).toContain("unknown");
    expect(byId.get("pins")!.run).toContain('"$OMP_LATEST" != "unknown"');
    expect(byId.get("pins")!.run).toContain('"$ENGINE_LATEST" != "unknown"');
    // An engine release whose CLI is not published yet cannot build the image
    // (the CLI pin is installed from a frozen lock at HARNESS_VERSION).
    expect(latest.run).toContain('npm view "@mstar-harness/cli@${ENGINE}" version');
    expect(byId.get("pins")!.run).toContain('"$CLI_STATE" = "available"');
  });

  test("the runner lock is regenerated from the committed lock, not from scratch", () => {
    // Resolving packages/runner/package.json alone also lifts caret-ranged
    // transitives (the SDK's own deps), turning a one-line pin bump into an
    // unrelated dependency upgrade inside the review image.
    expect(byId.get("pins")!.run).toContain('cp packages/runner/package.json packages/runner/bun.lock "$TMP"');
    expect(byId.get("pins")!.run).toContain("--lockfile-only");
  });
});
