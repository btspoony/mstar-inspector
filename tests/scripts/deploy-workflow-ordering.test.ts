/**
 * Deploy gate ordering — both workflows.
 *
 * `wrangler secret bulk` creates AND deploys a Worker version, exactly like
 * `wrangler deploy`, so "fail before deploy" means: the D1 migration, the
 * idempotent `0027` backfill and the zero-orphan abort gate all run BEFORE the
 * first deploy-capable step — not merely before the final `wrangler deploy`.
 *
 * Also pinned here: the replay-identity assertion (same SHA as Deploy A) runs
 * before anything is deployed, the container-digest comparison is reported, and
 * the always-run summary never claims a deploy that did not happen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

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

const WORKFLOWS = [
  {
    file: "deploy.yml",
    migrations: "Apply D1 migrations (remote)",
    replay: { name: "Assert replay identity", needle: "REPLAY_SHA" },
  },
  {
    file: "deploy-prod.yml",
    migrations: "Apply prod D1 migrations (remote)",
    replay: { name: "Assert the deploy tag names the run SHA", needle: "refs/tags/" },
  },
] as const;

for (const { file, migrations, replay } of WORKFLOWS) {
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

    test("replay identity is asserted before every deploy-capable step", () => {
      const index = steps.findIndex((s) => s.name === replay.name);
      expect(index, `${file}: replay-identity step is missing`).toBeGreaterThan(-1);
      expect(steps[index]!.run, `${file}: replay step must compare the deploy SHA`).toContain(replay.needle);
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the replay-identity assertion`).toBeGreaterThan(index);
      }
    });

    test("the digest comparison is reported, and a non-deploy is never claimed", () => {
      const deploy = steps.find((s) => (s.name ?? "").startsWith("Deploy Worker"))!;
      expect(deploy).toBeDefined();
      // `steps.deploy.outcome` is what gates `deployed_sha` in the summary.
      expect(deploy.id, `${file}: deploy step needs id: deploy`).toBe("deploy");
      const body = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      expect(body, `${file}: container digest comparison missing`).toContain("container_digest_match=");
      expect(body, `${file}: a digest mismatch must warn with the rolling-base reason`).toContain(
        "::warning::container digest",
      );
      expect(body, `${file}: summary never records a non-deploy`).toContain("deploy_status=not-deployed");
      expect(body, `${file}: the requested SHA is recorded separately`).toContain("requested_sha=$GITHUB_SHA");
    });
  });
}
