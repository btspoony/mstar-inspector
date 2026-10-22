/**
 * Deploy gate ordering — both workflows.
 *
 * `wrangler secret bulk` creates AND deploys a Worker version, exactly like
 * `wrangler deploy`, so "fail before deploy" means: the D1 migration, the
 * idempotent `0027` backfill and the zero-orphan abort gate all run BEFORE the
 * first deploy-capable step — not merely before the final `wrangler deploy`.
 *
 * Also pinned here: the ref-identity assertion still runs before every
 * deploy-capable step (the tenant-mode rollout that needed a replay binding is
 * gone; a moved tag/branch must never deploy), the container-digest comparison
 * is reported, the last version-creating step binds `DEPLOYMENT_MODE` (the one
 * remaining deployment-shape switch), no deploy command passes the retired
 * tenant-mode var, and the always-run summary derives its status keys from the
 * deploy steps' outcomes — never from the non-fatal version-id capture. The
 * summary pins assert the CONTENT the step actually writes into
 * `$GITHUB_STEP_SUMMARY` (the step body is executed), not the markdown source
 * shape.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** Release-shaped tag the git fixture creates at HEAD (`@tag` in a step's env). */
const FIXTURE_TAG = "v0.0.1-fixture";
const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

type Step = {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};

/** Parse a workflow YAML into a plain object (python3 + PyYAML, no new deps). */
function parseWorkflow(rel: string): Record<string, any> {
  const path = join(REPO_ROOT, ".github", "workflows", rel);
  const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`python3 yaml parse failed for ${rel}: ${proc.stderr.toString().trim()}`);
  }
  return JSON.parse(proc.stdout.toString());
}

/** Parse mutated workflow TEXT (mutation tests write a variant to a temp file). */
function parseText(rel: string, text: string): Step[] {
  const dir = mkdtempSync(join(tmpdir(), "ordering-"));
  try {
    const path = join(dir, rel);
    writeFileSync(path, text);
    const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`python3 yaml parse failed for the mutated ${rel}: ${proc.stderr.toString().trim()}`);
    }
    return JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Execute one step body exactly as Actions would (bash -eo pipefail, the step's
 * `env:` resolved from `vars`), in a scratch directory whose `scripts/` points
 * at the repository's. Returns what landed in `$GITHUB_OUTPUT` /
 * `$GITHUB_STEP_SUMMARY` — the emitted content, not the YAML shape.
 *
 * `opts.withGit` adds a real repository (HEAD + tag) so a step's
 * `git rev-parse` assertions run; the env value `"@head"` is then substituted
 * with that commit, which is how a step gets a SHA it can actually resolve.
 */
function runStep(
  step: Step,
  env: Record<string, string>,
  files: Record<string, string> = {},
  opts: { withGit?: boolean } = {},
): { code: number; out: string; output: string; summary: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "step-"));
  try {
    symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const output = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    let head = "";
    if (opts.withGit === true) {
      // `-c …Sign=false`: an operator's global signing config must not decide
      // whether the fixture can create a commit/tag.
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        });
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "fixture");
      head = git("rev-parse", "HEAD").stdout.toString().trim();
      // prod asserts `refs/tags/<github.ref_name>^{commit}`; the fixture tag is a
      // real release-shaped name pointing at HEAD, so `@tag` resolves.
      git("tag", FIXTURE_TAG);
    }
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      resolved[key] = value === "@head" ? head : value === "@tag" ? FIXTURE_TAG : value;
    }
    const proc = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", step.run ?? ""], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "42",
        ...resolved,
      },
    });
    return {
      code: proc.exitCode,
      out: proc.stdout.toString() + proc.stderr.toString(),
      output: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
      head,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Steps that publish a Worker version (a `secret bulk` write does too). */
const DEPLOY_CAPABLE = /bunx wrangler (deploy|secret bulk)\b/;
/**
 * Every wrangler command that CREATES a Worker version — the one serving
 * traffic is the version made by the LAST of these, whatever its kind.
 */
const VERSION_CREATING = /bunx wrangler (deploy|secret bulk|versions)\b/;
/** The deployment-shape var the serving version must bind. */
const DEPLOYMENT_VAR = '--var "DEPLOYMENT_MODE:saas"';
/** The retired tenant-mode var, assembled so this file does not match its own scan. */
const RETIRED_VAR = ["WORKSPACE", "TENANT", "MODE"].join("_");
const GATE = "Assert zero orphan Apps (pre-deploy gate)";
const BACKFILL = "Re-run workspace backfill (0027, idempotent)";

/**
 * The version that serves a deploy is created by the LAST version-creating
 * command, and it must bind the deployment shape. `wrangler secret bulk`
 * cannot carry `--var` (a named environment rejects `keep_vars`), so the last
 * such command has to be a `wrangler deploy` that passes the var.
 */
function assertServingStepBindsDeploymentMode(file: string, steps: Step[]): void {
  const versionCreating = steps.filter((s) => VERSION_CREATING.test(s.run ?? ""));
  expect(versionCreating.length, `${file}: no version-creating step found`).toBeGreaterThan(0);
  const last = versionCreating[versionCreating.length - 1]!;
  expect(last.run, `${file}: last version-creating step "${last.name}" is not a mode-binding deploy`).toContain(
    "bunx wrangler deploy",
  );
  expect(last.run, `${file}: last version-creating step "${last.name}" drops the deployment mode var`).toContain(
    DEPLOYMENT_VAR,
  );
}

/** The always-run step that writes the status keys and the evidence summary. */
function findSummaryStep(steps: Step[]): Step | undefined {
  return steps.find(
    (s) =>
      s.if === "always()" &&
      (s.run ?? "").includes("GITHUB_STEP_SUMMARY") &&
      (s.run ?? "").includes("scripts/deploy-status.sh"),
  );
}

const WORKFLOWS = [
  {
    file: "deploy.yml",
    migrations: "Apply D1 migrations (remote)",
    refIdentity: "Assert checkout identity",
    refNeedles: ["HEAD_SHA"],
    // Staging's `wrangler deploy` IS the last version-creating step, so the
    // summary takes no separate serving outcome.
    serving: undefined,
  },
  {
    file: "deploy-prod.yml",
    migrations: "Apply prod D1 migrations (remote)",
    refIdentity: "Assert tag identity",
    refNeedles: ["refs/tags/", "TAG_SHA"],
    // Production re-deploys the deployment-shape version in a LATER step: the
    // summary must consume that outcome too (I-000071).
    serving: { id: "serving", name: "Deploy serving version (prod)" },
  },
] as const;

for (const { file, migrations, refIdentity, refNeedles, serving } of WORKFLOWS) {
  describe(`${file} gate ordering`, () => {
    const steps = parseWorkflow(file).jobs.deploy.steps as Step[];
    const deployCapable = steps
      .map((s, i) => (DEPLOY_CAPABLE.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);

    test("migrations → 0027 backfill → zero-orphan gate → every deploy-capable step", () => {
      const gate = steps.findIndex((s) => s.name === GATE);
      expect(gate, `${file}: zero-orphan gate step is missing`).toBeGreaterThan(-1);
      expect(gate, `${file}: gate must follow the D1 migration`).toBeGreaterThan(
        steps.findIndex((s) => s.name === migrations),
      );
      expect(gate, `${file}: gate must follow the 0027 backfill`).toBeGreaterThan(
        steps.findIndex((s) => s.name === BACKFILL),
      );
      expect(deployCapable.length, `${file}: no deploy-capable step found`).toBeGreaterThan(0);
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the zero-orphan gate`).toBeGreaterThan(gate);
      }
    });

    test("ref identity is asserted before every deploy-capable step", () => {
      // The tenant-mode replay binding died with the mode; the REF IDENTITY
      // assertion is what remains, and it applies to every run: a ref that
      // moved between the approval and the deploy must never deploy.
      const index = steps.findIndex((s) => s.name === refIdentity);
      expect(index, `${file}: ref-identity step "${refIdentity}" is missing`).toBeGreaterThan(-1);
      const step = steps[index]!;
      for (const needle of refNeedles) {
        expect(step.run, `${file}: ref-identity step must resolve ${needle}`).toContain(needle);
      }
      expect(step.env?.RUN_SHA, `${file}: ref-identity step needs the run SHA`).toBe("${{ github.sha }}");
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the ref-identity assertion`).toBeGreaterThan(index);
      }
    });

    test("ref identity EXECUTES: the tree it checks out passes, a moved ref reds before any deploy", () => {
      // The property the deleted replay guard also carried: on a real repo the
      // step compares the resolved ref with the run's SHA, and a disagreement
      // must exit non-zero — a substring pin cannot see that.
      const step = steps.find((s) => s.name === refIdentity)!;
      const matching = runStep(
        step,
        { RUN_SHA: "@head", TAG: "@tag" },
        {},
        { withGit: true },
      );
      expect(matching.code, `${file}: a matching ref must pass\n${matching.out}`).toBe(0);
      expect(matching.out, `${file}: a matching ref must not report an error`).not.toContain("::error::");

      const moved = runStep(
        step,
        { RUN_SHA: "f".repeat(40), TAG: "@tag" },
        {},
        { withGit: true },
      );
      expect(moved.code, `${file}: a moved ref must red\n${moved.out}`).toBe(1);
      expect(moved.out, `${file}: a moved ref must say why`).toContain("::error::");
    });

    test("no deploy command passes the retired tenant-mode var, and the shape var is the only one", () => {
      // Scanned from the step bodies rather than the raw text so the assertion
      // is about what a deploy actually hands wrangler. The repo-wide grep for
      // the retired name lives in tests/contracts/wrangler-env-parity.test.ts.
      const passedVars = steps.flatMap((s) =>
        [...(s.run ?? "").matchAll(/--var\s+"?([A-Za-z_][A-Za-z0-9_]*):/g)].map((m) => m[1]!),
      );
      expect(passedVars, `${file}: a deploy still passes a mode var`).not.toContain(RETIRED_VAR);
      expect(passedVars, `${file}: the deployment shape var is missing`).toContain("DEPLOYMENT_MODE");
      for (const s of steps) {
        expect(s.run ?? "", `${file}: step "${s.name}" names the retired var`).not.toContain(RETIRED_VAR);
        expect(JSON.stringify(s.env ?? {}), `${file}: step "${s.name}" wires the retired var`).not.toContain(
          RETIRED_VAR,
        );
      }
    });

    test("the dispatch carries no mode or replay input", () => {
      const wf = parseWorkflow(file);
      const dispatch = (wf["true"] ?? wf.on).workflow_dispatch;
      expect(Object.keys(dispatch.inputs ?? {}).sort(), `${file}: dispatch inputs`).toEqual([
        "expected_container_digest",
      ]);
    });

    test("the summary delegates status to the script, fed by steps.deploy.outcome", () => {
      const deploy = steps.find((s) => (s.name ?? "").startsWith("Deploy Worker"))!;
      expect(deploy).toBeDefined();
      expect(deploy.id, `${file}: deploy step needs id: deploy`).toBe("deploy");
      // one writer: the deploy step itself must not append status to the summary
      expect(deploy.run, `${file}: deploy step must not write the summary`).not.toContain("GITHUB_STEP_SUMMARY");

      const summary = findSummaryStep(steps);
      expect(summary, `${file}: no always-run status summary calling the script`).toBeDefined();
      expect(summary!.env?.DEPLOY_OUTCOME, `${file}: summary must read the deploy outcome`).toBe(
        "${{ steps.deploy.outcome }}",
      );
      // Run it: the emitted keys are the contract, not the step's markdown shape.
      const sha = "c".repeat(40);
      const failed = runStep(summary!, { DEPLOY_OUTCOME: "failure", RUN_SHA: sha });
      expect(failed.code, `${file}: the summary step must never fail the run`).toBe(0);
      expect(failed.summary, `${file}: a failed deploy certifies nothing`).toContain(
        `deploy_status=not-deployed\nrequested_sha=${sha}`,
      );
      expect(failed.summary, `${file}: a failed deploy must not print a deployed SHA`).not.toContain("deployed_sha=");
    });

    test("the LAST version-creating step is a deploy that binds the deployment mode", () => {
      assertServingStepBindsDeploymentMode(file, steps);
    });

    test("the summary certifies a deployed SHA only when every version-creating deploy succeeded", () => {
      const summary = findSummaryStep(steps)!;
      const sha = "d".repeat(40);
      if (serving === undefined) {
        // Staging: one version-creating deploy, so its outcome alone decides and
        // a fourth argument would invent a step that does not exist.
        expect(summary.env?.SERVING_OUTCOME).toBeUndefined();
        const ok = runStep(summary, { DEPLOY_OUTCOME: "success", RUN_SHA: sha });
        expect(ok.summary).toContain(`deploy_status=deployed\ndeployed_sha=${sha}`);
        return;
      }

      const servingStep = steps.find((s) => s.name === serving.name)!;
      expect(servingStep, `${file}: serving step "${serving.name}" is missing`).toBeDefined();
      expect(servingStep.id).toBe(serving.id);
      expect(summary.env?.SERVING_OUTCOME, `${file}: the summary must read the serving outcome`).toBe(
        `\${{ steps.${serving.id}.outcome }}`,
      );

      // First deploy green, serving deploy failed → the SHA is NOT certified.
      const partial = runStep(summary, {
        DEPLOY_OUTCOME: "success",
        SERVING_OUTCOME: "failure",
        RUN_SHA: sha,
      });
      expect(partial.code).toBe(0);
      expect(partial.summary, `${file}: a failed serving deploy must not certify the SHA`).toContain(
        `deploy_status=not-deployed\nrequested_sha=${sha}`,
      );
      expect(partial.summary).not.toContain("deployed_sha=");

      // Both green → the SHA is what this run shipped.
      const both = runStep(summary, {
        DEPLOY_OUTCOME: "success",
        SERVING_OUTCOME: "success",
        RUN_SHA: sha,
      });
      expect(both.summary).toContain(`deploy_status=deployed\ndeployed_sha=${sha}`);
    });

    test("the evidence summary renders the Worker version as a markdown bullet", () => {
      // N3: pin the CONTENT the step emits, not the echo shape. Both summaries
      // carry the same evidence line; a bare `version_id=<uuid>` key renders as
      // plain text in the run summary, so the bullet is the contract.
      const evidence = steps.find(
        (s) => (s.run ?? "").includes("Worker version") && (s.run ?? "").includes("GITHUB_STEP_SUMMARY"),
      )!;
      expect(evidence, `${file}: no step emits the Worker version`).toBeDefined();
      const version = "11111111-2222-3333-4444-555555555555";
      const emitted = runStep(
        evidence,
        { EXPECTED_DIGEST: "", RUN_SHA: "e".repeat(40), DEPLOY_OUTCOME: "failure", SERVING_OUTCOME: "failure" },
        { "version_id.txt": `${version}\n`, "image_digest.txt": `sha256:${"f".repeat(64)}\n` },
      );
      expect(emitted.code, `${file}: the evidence step must never fail the run`).toBe(0);
      expect(emitted.summary).toContain(`Worker version: \`${version}\``);
      expect(emitted.summary, `${file}: the version must not be re-rendered as a bare key`).not.toMatch(
        /^version_id=[0-9a-f-]{36}$/m,
      );
    });

    test("mutation: an appended bulk after the serving deploy, or a serving deploy without the var, fails the pin", () => {
      // The hazard this pin exists for: every bulk write deploys a version from
      // the config, so anything version-creating appended after the
      // mode-binding deploy silently becomes the serving version.
      const src = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      const appended =
        src +
        '\n      - name: Late secret write\n        run: |\n          jq -n \'{}\' | bunx wrangler secret bulk\n';
      expect(appended).not.toBe(src);
      const appendedSteps = parseText(file, appended);
      expect(() => assertServingStepBindsDeploymentMode(file, appendedSteps)).toThrow();

      // and dropping the var from that last deploy leaves a serving version on
      // whatever the config declares.
      const lastIdx = src.lastIndexOf(DEPLOYMENT_VAR);
      expect(lastIdx).toBeGreaterThan(-1);
      const stripped = src.slice(0, lastIdx) + src.slice(lastIdx + DEPLOYMENT_VAR.length);
      expect(stripped).not.toBe(src);
      expect(() => assertServingStepBindsDeploymentMode(file, parseText(file, stripped))).toThrow();
    });

    if (file === "deploy.yml") {
      test("the version-id capture is a separate, non-fatal step", () => {
        const deploy = steps.find((s) => s.id === "deploy")!;
        // a missing version id must not turn a successful deploy into a failure
        expect(deploy.run, "deploy step must not depend on the version capture").not.toContain("version_id.txt");
        const capture = steps.find((s) => s.name === "Capture Worker version id")!;
        expect(capture, "version-id capture step is missing").toBeDefined();
        expect(capture["continue-on-error"]).toBe(true);
        expect(capture.if).toBeUndefined();
        expect(capture.run).toContain("unreported");
        expect(deploy.name).not.toBe(capture.name);
      });
    }
  });
}
