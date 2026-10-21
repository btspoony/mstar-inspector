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
 * reported, and the always-run summary derives its status keys from
 * `steps.deploy.outcome` — never from the non-fatal version-id capture.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
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

const WORKFLOWS = [
  {
    file: "deploy.yml",
    migrations: "Apply D1 migrations (remote)",
    replayNeedles: ["HEAD_SHA", "EXPECTED_DEPLOY_SHA"],
  },
  {
    file: "deploy-prod.yml",
    migrations: "Apply prod D1 migrations (remote)",
    replayNeedles: ["refs/tags/", "EXPECTED_DEPLOY_SHA"],
  },
] as const;

for (const { file, migrations, replayNeedles } of WORKFLOWS) {
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
      // The strict binding decision belongs to the executed script.
      expect(step.run, `${file}: replay step must call the guard`).toContain(
        'bash scripts/deploy-replay-guard.sh "$MODE" "$EXPECTED_DEPLOY_SHA" "$RUN_SHA"',
      );
      expect(step.env?.MODE, `${file}: replay step needs the resolved mode`).toBe("${{ steps.tenant.outputs.mode }}");
      expect(step.env?.EXPECTED_DEPLOY_SHA).toBe("${{ inputs.expected_deploy_sha }}");
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the replay-identity assertion`).toBeGreaterThan(index);
      }
    });

    test("the summary delegates status to the script, fed by steps.deploy.outcome", () => {
      const deploy = steps.find((s) => (s.name ?? "").startsWith("Deploy Worker"))!;
      expect(deploy).toBeDefined();
      expect(deploy.id, `${file}: deploy step needs id: deploy`).toBe("deploy");
      // one writer: the deploy step itself must not append status to the summary
      expect(deploy.run, `${file}: deploy step must not write the summary`).not.toContain("GITHUB_STEP_SUMMARY");

      const summary = steps.find(
        (s) =>
          s.if === "always()" &&
          (s.run ?? "").includes("GITHUB_STEP_SUMMARY") &&
          (s.run ?? "").includes("scripts/deploy-status.sh"),
      );
      expect(summary, `${file}: no always-run status summary calling the script`).toBeDefined();
      expect(summary!.env?.DEPLOY_OUTCOME, `${file}: summary must read the deploy outcome`).toBe(
        "${{ steps.deploy.outcome }}",
      );
      // the status shape itself (and the never-both invariant) is behaviour-tested
      // in tests/scripts/deploy-guards.test.ts, which executes the script.

      const body = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      expect(body, `${file}: container digest comparison missing`).toContain("container_digest_match=");
      expect(body, `${file}: a digest mismatch must warn with the rolling-base reason`).toContain(
        "::warning::container digest",
      );
    });

    test("the LAST version-creating step is a deploy that binds the resolved tenant mode", () => {
      assertServingStepBindsMode(file, steps);
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

      test("the summary renders the Worker version as a markdown bullet", () => {
        // Both run summaries carry the same evidence key; a bare `key=value`
        // line renders differently from the prod bullet for the same value.
        const body = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
        expect(body).toContain('echo "- Worker version: \\`$VERSION\\`"');
        expect(body).not.toContain('echo "version_id=$VERSION"');
      });
    }
  });
}
