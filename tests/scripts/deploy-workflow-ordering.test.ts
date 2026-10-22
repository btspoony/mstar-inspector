/**
 * Deploy gate ordering — both workflows.
 *
 * `wrangler secret bulk` creates AND deploys a Worker version, exactly like
 * `wrangler deploy`, so "fail before deploy" means: the D1 migration, the
 * idempotent `0027` backfill and the zero-orphan abort gate all run BEFORE the
 * first deploy-capable step — not merely before the final `wrangler deploy`.
 *
 * Also pinned here: replay identity is bound to the SHA Deploy A shipped (not
 * to whatever the ref points at now), the container-digest comparison is
 * reported, the routine (`push` / `release`) arm takes its tenant mode from the
 * steady-state variable instead of hardcoding `off`, and the always-run summary
 * derives its status keys from the deploy steps' outcomes — never from the
 * non-fatal version-id capture. The summary pins assert the CONTENT the step
 * actually writes into `$GITHUB_STEP_SUMMARY` (the step body is executed), not
 * the markdown source shape.
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

/** The `workflow_dispatch` input defaults — the values Actions supplies for a no-field dispatch. */
function dispatchDefaults(rel: string): Record<string, string> {
  const wf = parseWorkflow(rel);
  const dispatch = (wf["true"] ?? wf.on)?.workflow_dispatch;
  expect(dispatch, `${rel}: no workflow_dispatch trigger`).toBeDefined();
  const inputs: Record<string, { default?: unknown }> = dispatch.inputs ?? {};
  const defaults: Record<string, string> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    defaults[name] = String(spec.default ?? "");
  }
  return defaults;
}

/**
 * The env Actions hands a step for one trigger shape: the step's OWN `env:`
 * map, with every `${{ … }}` expression resolved from that shape's context.
 * Feeding the values in by hand instead would test the resolver while the
 * wiring that supplies it stayed unpinned — which is exactly how I-000070
 * shipped green (I-000083).
 */
function stepEnv(step: Step, ctx: Record<string, string | undefined>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(step.env ?? {})) {
    resolved[key] = raw.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_match, expr: string) => ctx[expr] ?? "");
  }
  return resolved;
}

/** Steps that publish a Worker version (a `secret bulk` write does too). */
const DEPLOY_CAPABLE = /bunx wrangler (deploy|secret bulk)\b/;
/**
 * Every wrangler command that CREATES a Worker version — the one serving
 * traffic is the version made by the LAST of these, whatever its kind.
 */
const VERSION_CREATING = /bunx wrangler (deploy|secret bulk|versions)\b/;
/** The var that decides which tenant face the created version serves. */
const MODE_VAR = '--var "WORKSPACE_TENANT_MODE:$TENANT_MODE"';
const GATE = "Assert zero orphan Apps (pre-deploy gate)";
const BACKFILL = "Re-run workspace backfill (0027, idempotent)";
const REPLAY = "Assert replay identity";

/**
 * The version that serves a deploy is created by the LAST version-creating
 * command, and it must bind the resolved tenant mode. `wrangler secret bulk`
 * cannot carry `--var` (a named environment rejects `keep_vars`, so the bulk
 * version always falls back to the config default `off`), so the last such
 * command has to be a `wrangler deploy` that passes the var.
 */
function assertServingStepBindsMode(file: string, steps: Step[]): void {
  const versionCreating = steps.filter((s) => VERSION_CREATING.test(s.run ?? ""));
  expect(versionCreating.length, `${file}: no version-creating step found`).toBeGreaterThan(0);
  const last = versionCreating[versionCreating.length - 1]!;
  expect(last.run, `${file}: last version-creating step "${last.name}" is not a mode-binding deploy`).toContain(
    "bunx wrangler deploy",
  );
  expect(last.run, `${file}: last version-creating step "${last.name}" drops the tenant mode var`).toContain(
    MODE_VAR,
  );
  expect(last.env?.TENANT_MODE, `${file}: the serving deploy needs the resolved mode`).toBe(
    "${{ steps.tenant.outputs.mode }}",
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
    replayNeedles: ["HEAD_SHA", "EXPECTED_DEPLOY_SHA"],
    // Staging's `wrangler deploy` IS the last version-creating step, so the
    // summary takes no separate serving outcome.
    serving: undefined,
  },
  {
    file: "deploy-prod.yml",
    migrations: "Apply prod D1 migrations (remote)",
    replayNeedles: ["refs/tags/", "EXPECTED_DEPLOY_SHA"],
    // Production re-deploys the mode-bearing version in a LATER step: the
    // summary must consume that outcome too (I-000071).
    serving: { id: "serving", name: "Deploy serving version (prod, mode var)" },
  },
] as const;

for (const { file, migrations, replayNeedles, serving } of WORKFLOWS) {
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

    test("replay identity is delegated to the guard script, before every deploy-capable step", () => {
      const index = steps.findIndex((s) => s.name === REPLAY);
      expect(index, `${file}: replay-identity step is missing`).toBeGreaterThan(-1);
      const step = steps[index]!;
      for (const needle of replayNeedles) {
        expect(step.run, `${file}: replay step must resolve ${needle}`).toContain(needle);
      }
      // The strict binding decision belongs to the executed script, which takes
      // the RESOLVER's replay intent — not the mode. A steady-state run serving
      // `strict` from the variable must not be treated as Deploy B.
      expect(step.run, `${file}: replay step must call the guard`).toContain(
        'bash scripts/deploy-replay-guard.sh "$REPLAY" "$EXPECTED_DEPLOY_SHA" "$RUN_SHA"',
      );
      expect(step.env?.REPLAY, `${file}: replay step needs the resolver's replay intent`).toBe(
        "${{ steps.tenant.outputs.replay }}",
      );
      expect(step.env?.MODE, `${file}: the replay step must not key off the mode`).toBeUndefined();
      expect(step.env?.EXPECTED_DEPLOY_SHA).toBe("${{ inputs.expected_deploy_sha }}");
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the replay-identity assertion`).toBeGreaterThan(index);
      }
    });

    test("every real trigger shape resolves the mode, its warning, and the replay intent", () => {
      // One executed case per shape GitHub actually creates. The step's OWN
      // `env:` supplies the inputs — with `${{ }}` resolved from that shape's
      // context — so the declared default, not a hand-fed value, is what a
      // no-field dispatch gets (I-000083). The resolver's real `replay` output
      // then feeds the guard step, exactly as `steps.tenant.outputs.replay` does.
      const tenant = steps.find((s) => s.name === "Resolve tenant mode")!;
      const guardStep = steps.find((s) => s.name === REPLAY)!;

      /** Resolve for one shape, then guard with the resolver's own replay intent. */
      const run = (
        shape: Record<string, string>,
        steady: string,
        guard: Record<string, string> = { EXPECTED_DEPLOY_SHA: "", RUN_SHA: "@head", TAG: "@tag" },
      ) => {
        const resolved = runStep(tenant, stepEnv(tenant, { ...shape, "vars.WORKSPACE_TENANT_MODE": steady }));
        const field = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(resolved.output)?.[1];
        expect(resolved.code, `${file}: resolution failed\n${resolved.out}`).toBe(0);
        const replay = field("replay")!;
        const guarded = runStep(guardStep, { REPLAY: replay, ...guard }, {}, { withGit: true });
        return {
          mode: field("mode"),
          replay,
          change: resolved.summary.trim(),
          warned: resolved.out.includes("::warning::"),
          code: guarded.code,
          out: guarded.out,
        };
      };

      // A dispatch nobody filled in carries the DECLARED DEFAULT
      // (`on.workflow_dispatch.inputs.tenant_mode.default`); a `push` /
      // `release: published` event carries no `inputs` context at all.
      const defaults = dispatchDefaults(file);
      const noFields = { "inputs.tenant_mode": defaults.tenant_mode ?? "" };
      const routineShapes: { label: string; ctx: Record<string, string> }[] =
        file === "deploy-prod.yml"
          ? [
              // the Release workflow's `gh workflow run deploy-prod.yml --ref <tag>`: no fields
              { label: "release-workflow dispatch (no fields)", ctx: noFields },
              { label: "release: published", ctx: {} },
            ]
          : [
              { label: "push to main", ctx: {} },
              { label: "workflow_dispatch with no fields", ctx: noFields },
            ];

      for (const { label, ctx } of routineShapes) {
        // a strict installation survives an ordinary release/push
        const strict = run(ctx, "strict");
        expect(strict.mode, `${file}: ${label} demoted a strict installation`).toBe("strict");
        expect(strict.replay, `${file}: ${label} must not demand a Deploy-A SHA`).toBe("none");
        expect(strict.change, `${file}: ${label} reports a change it did not make`).toBe("tenant_mode_change=none");
        expect(strict.warned, `${file}: ${label} warned on a steady strict deploy`).toBe(false);
        expect(strict.code, `${file}: ${label} aborted a steady strict deploy\n${strict.out}`).toBe(0);

        // no variable → off, and the unproven demotion is reported
        const unset = run(ctx, "");
        expect(unset.mode, `${file}: ${label} with no variable`).toBe("off");
        expect(unset.replay).toBe("none");
        expect(unset.warned, `${file}: ${label} demoted silently`).toBe(true);
        expect(unset.change, `${file}: ${label} must record the unproven change`).toBe(
          "tenant_mode_change=unproven->off",
        );
      }

      // The release path really is a no-field dispatch: it supplies no
      // `-f tenant_mode`, so the declared default decides there. Reverting that
      // default to `off` fails the "release-workflow dispatch" case above.
      if (file === "deploy-prod.yml") {
        const release = parseWorkflow("release.yml");
        const dispatchStep = (release.jobs.release.steps as Step[]).find((s) =>
          (s.run ?? "").includes("gh workflow run deploy-prod.yml"),
        )!;
        expect(dispatchStep, "release.yml no longer dispatches deploy-prod.yml").toBeDefined();
        expect(dispatchStep.run, "release.yml must not pick a tenant mode").not.toMatch(/-f\s+tenant_mode/);
        expect(defaults.tenant_mode, "the no-field dispatch default must be the non-deciding steady").toBe("steady");
      }

      // An EXPLICIT human dispatch: off and strict override the variable, and
      // only an explicit strict is a replay.
      const off = run({ "inputs.tenant_mode": "off" }, "strict");
      expect(off.mode).toBe("off");
      expect(off.replay).toBe("none");
      expect(off.change).toBe("tenant_mode_change=none");
      expect(off.warned).toBe(false);
      expect(off.code).toBe(0);

      const strictDispatch = run({ "inputs.tenant_mode": "strict" }, "");
      expect(strictDispatch.mode).toBe("strict");
      expect(strictDispatch.replay).toBe("required");
      expect(
        strictDispatch.code,
        `${file}: a strict dispatch without the Deploy-A SHA must abort\n${strictDispatch.out}`,
      ).toBe(1);

      // `steady` is the operator saying "the variable decides" — a steady-state
      // deploy, never a replay: if it demanded a Deploy-A SHA every routine
      // strict deploy would abort.
      const steadyDispatch = run({ "inputs.tenant_mode": "steady" }, "strict");
      expect(steadyDispatch.mode).toBe("strict");
      expect(steadyDispatch.replay).toBe("none");
      expect(steadyDispatch.warned).toBe(false);
      expect(steadyDispatch.code, `${file}: steady + strict aborted\n${steadyDispatch.out}`).toBe(0);
      expect(run({ "inputs.tenant_mode": "steady" }, "").change).toBe("tenant_mode_change=unproven->off");

      // the ref identity assertion survives every non-replay shape
      const moved = run({ "inputs.tenant_mode": "steady" }, "strict", {
        EXPECTED_DEPLOY_SHA: "",
        RUN_SHA: "f".repeat(40),
        TAG: "@tag",
      });
      expect(moved.replay).toBe("none");
      expect(moved.code, `${file}: a moved ref must still red`).toBe(1);
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
      expect(failed.summary, `${file}: a failed deploy must not print a replay SHA`).not.toContain("deployed_sha=");
    });

    test("the mode step runs before every deploy-capable step", () => {
      const tenant = steps.findIndex((s) => s.name === "Resolve tenant mode");
      expect(tenant).toBeGreaterThan(-1);
      for (const i of deployCapable) {
        expect(tenant, `${file}: mode resolution must precede "${steps[i]!.name}"`).toBeLessThan(i);
      }
    });

    test("the LAST version-creating step is a deploy that binds the resolved tenant mode", () => {
      assertServingStepBindsMode(file, steps);
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

      // First deploy green, serving deploy failed → the SHA is NOT replayable.
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

      // Both green → the SHA is the replay source Deploy B needs.
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
        { TENANT_MODE: "off", EXPECTED_DIGEST: "", RUN_SHA: "e".repeat(40), DEPLOY_OUTCOME: "failure", SERVING_OUTCOME: "failure" },
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
      // the config default (`off`), so anything version-creating appended after
      // the mode-binding deploy silently becomes the serving version.
      const src = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      const appended =
        src +
        '\n      - name: Late secret write\n        run: |\n          jq -n \'{}\' | bunx wrangler secret bulk\n';
      expect(appended).not.toBe(src);
      const appendedSteps = parseText(file, appended);
      expect(() => assertServingStepBindsMode(file, appendedSteps)).toThrow();

      // and dropping the var from that last deploy leaves a serving version on
      // the config default while the run summary claims a mode.
      const lastIdx = src.lastIndexOf(MODE_VAR);
      expect(lastIdx).toBeGreaterThan(-1);
      const stripped = src.slice(0, lastIdx) + src.slice(lastIdx + MODE_VAR.length);
      expect(stripped).not.toBe(src);
      expect(() => assertServingStepBindsMode(file, parseText(file, stripped))).toThrow();
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
