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
import { readFileSync } from "node:fs";
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

/** Steps that publish a Worker version (a `secret bulk` write does too). */
const DEPLOY_CAPABLE = /bunx wrangler (deploy|secret bulk)\b/;
const GATE = "Assert zero orphan Apps (pre-deploy gate)";
const BACKFILL = "Re-run workspace backfill (0027, idempotent)";
const REPLAY = "Assert replay identity";

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

    test("replay identity binds Deploy A's SHA, before every deploy-capable step", () => {
      const index = steps.findIndex((s) => s.name === REPLAY);
      expect(index, `${file}: replay-identity step is missing`).toBeGreaterThan(-1);
      for (const needle of replayNeedles) {
        expect(steps[index]!.run, `${file}: replay step must use ${needle}`).toContain(needle);
      }
      // strict without a SHA is a replay that cannot prove anything
      expect(steps[index]!.run).toContain("strict replay requires the SHA deployed by Deploy A");
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the replay-identity assertion`).toBeGreaterThan(index);
      }
    });

    test("the summary decides status from steps.deploy.outcome, never from the version capture", () => {
      const deploy = steps.find((s) => (s.name ?? "").startsWith("Deploy Worker"))!;
      expect(deploy).toBeDefined();
      expect(deploy.id, `${file}: deploy step needs id: deploy`).toBe("deploy");
      // one writer: the deploy step itself must not append status to the summary
      expect(deploy.run, `${file}: deploy step must not write the summary`).not.toContain("GITHUB_STEP_SUMMARY");

      const summary = steps.find(
        (s) =>
          s.if === "always()" &&
          (s.run ?? "").includes("GITHUB_STEP_SUMMARY") &&
          (s.run ?? "").includes("deploy_status="),
      );
      expect(summary, `${file}: no always-run status summary`).toBeDefined();
      expect(summary!.env?.DEPLOY_OUTCOME, `${file}: summary must read the deploy outcome`).toBe(
        "${{ steps.deploy.outcome }}",
      );
      expect(summary!.run, `${file}: positive status`).toContain("deploy_status=deployed");
      expect(summary!.run, `${file}: negative status`).toContain("deploy_status=not-deployed");
      expect(summary!.run, `${file}: deployed sha`).toContain("deployed_sha=$GITHUB_SHA");
      expect(summary!.run, `${file}: requested sha`).toContain("requested_sha=$GITHUB_SHA");

      const body = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      expect(body, `${file}: container digest comparison missing`).toContain("container_digest_match=");
      expect(body, `${file}: a digest mismatch must warn with the rolling-base reason`).toContain(
        "::warning::container digest",
      );
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
