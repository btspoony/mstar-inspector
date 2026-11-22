import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
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

function parseWorkflow(rel: string): Record<string, any> {
  const path = join(REPO_ROOT, ".github", "workflows", rel);
  const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`python3 yaml parse failed for ${rel}: ${proc.stderr.toString().trim()}`);
  }
  return JSON.parse(proc.stdout.toString());
}

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

const DEPLOY_CAPABLE = /bunx wrangler (deploy|secret bulk)\b/;
const VERSION_CREATING = /bunx wrangler (deploy|secret bulk|versions)\b/;
const DEPLOYMENT_VAR = '--var "DEPLOYMENT_MODE:saas"';
const RETIRED_VAR = ["WORKSPACE", "TENANT", "MODE"].join("_");
const GATE = "Assert zero orphan Apps (pre-deploy gate)";
const KEY_GATE = "Assert usable encryption key (pre-deploy gate)";
const BACKFILL = "Re-run App attribution repair (workspace-backfill.sql, idempotent)";

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
    dispatchInputs: ["base_sha", "expected_container_digest"],
    redNeedles: ["checked-out HEAD", "!= run SHA"],
    serving: undefined,
  },
  {
    file: "deploy-prod.yml",
    migrations: "Apply prod D1 migrations (remote)",
    refIdentity: "Assert tag identity",
    refNeedles: ["refs/tags/", "TAG_SHA"],
    dispatchInputs: ["expected_container_digest"],
    redNeedles: ["names", "but this run executes"],
    serving: { id: "serving", name: "Deploy serving version (prod)" },
  },
] as const;

for (const { file, migrations, refIdentity, refNeedles, redNeedles, serving, dispatchInputs } of WORKFLOWS) {
  describe(`${file} gate ordering`, () => {
    const steps = parseWorkflow(file).jobs.deploy.steps as Step[];
    const deployCapable = steps
      .map((s, i) => (DEPLOY_CAPABLE.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);

    test("migrations → backfill replay → zero-orphan gate → every deploy-capable step", () => {
      const gate = steps.findIndex((s) => s.name === GATE);
      expect(gate, `${file}: zero-orphan gate step is missing`).toBeGreaterThan(-1);
      expect(gate, `${file}: gate must follow the D1 migration`).toBeGreaterThan(
        steps.findIndex((s) => s.name === migrations),
      );
      expect(gate, `${file}: gate must follow the attribution backfill`).toBeGreaterThan(
        steps.findIndex((s) => s.name === BACKFILL),
      );
      expect(deployCapable.length, `${file}: no deploy-capable step found`).toBeGreaterThan(0);
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the zero-orphan gate`).toBeGreaterThan(gate);
      }
    });

    test("the encryption-key gate sits beside the zero-orphan gate, before every deploy-capable step", () => {
      const keyGate = steps.findIndex((s) => s.name === KEY_GATE);
      expect(keyGate, `${file}: encryption-key gate step is missing`).toBeGreaterThan(-1);
      expect(steps[keyGate]!.run, `${file}: the gate must run the script`).toBe(
        "bun scripts/assert-encryption-key.ts",
      );
      expect(keyGate, `${file}: the key gate must follow the attribution gate`).toBeGreaterThan(
        steps.findIndex((s) => s.name === GATE),
      );
      for (const i of deployCapable) {
        expect(i, `${file}: "${steps[i]!.name}" runs before the encryption-key gate`).toBeGreaterThan(keyGate);
      }
    });

    test("the encryption-key gate feeds the secret it checks", () => {
      const step = steps.find((s) => s.name === KEY_GATE)!;
      const jobValue = (parseWorkflow(file).jobs.deploy.env ?? {}).DASHBOARD_ENCRYPTION_KEY as
        | string
        | undefined;
      expect(step.env?.DASHBOARD_ENCRYPTION_KEY ?? jobValue).toBe(
        "${{ secrets.DASHBOARD_ENCRYPTION_KEY }}",
      );
    });

    test("the replayed file the deploy hands wrangler writes no workspace membership", () => {
      const step = steps.find((s) => s.name === BACKFILL)!;
      expect(step, `${file}: backfill step is missing`).toBeDefined();
      const path = /--file\s+(\S+\.sql)/.exec(step.run ?? "")?.[1];
      expect(path, `${file}: backfill step must name a --file migration`).toBeTruthy();
      const source = readFileSync(join(REPO_ROOT, path!), "utf8").replace(/--.*$/gm, "");

      expect(source, `${file}: ${path} replays a workspace_members write`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+workspace_members\b/i,
      );
      expect(source, `${file}: ${path} must still map Apps`).toMatch(
        /INSERT\s+INTO\s+bot_workspaces\b/i,
      );
    });

    test("ref identity is asserted before every deploy-capable step", () => {
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
      for (const needle of redNeedles) {
        expect(moved.out, `${file}: red must name the moved ref (${needle})`).toContain(needle);
      }
    });

    test("no deploy command passes the retired tenant-mode var, and the shape var is the only one", () => {
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
        ...dispatchInputs,
      ]);
    });

    test("the summary delegates status to the script, fed by steps.deploy.outcome", () => {
      const deploy = steps.find((s) => (s.name ?? "").startsWith("Deploy Worker"))!;
      expect(deploy).toBeDefined();
      expect(deploy.id, `${file}: deploy step needs id: deploy`).toBe("deploy");
      expect(deploy.run, `${file}: deploy step must not write the summary`).not.toContain("GITHUB_STEP_SUMMARY");

      const summary = findSummaryStep(steps);
      expect(summary, `${file}: no always-run status summary calling the script`).toBeDefined();
      expect(summary!.env?.DEPLOY_OUTCOME, `${file}: summary must read the deploy outcome`).toBe(
        "${{ steps.deploy.outcome }}",
      );
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

      const both = runStep(summary, {
        DEPLOY_OUTCOME: "success",
        SERVING_OUTCOME: "success",
        RUN_SHA: sha,
      });
      expect(both.summary).toContain(`deploy_status=deployed\ndeployed_sha=${sha}`);
    });

    test("the evidence summary renders the Worker version as a markdown bullet", () => {
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
      const src = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
      const appended =
        src +
        '\n      - name: Late secret write\n        run: |\n          jq -n \'{}\' | bunx wrangler secret bulk\n';
      expect(appended).not.toBe(src);
      const appendedSteps = parseText(file, appended);
      expect(() => assertServingStepBindsDeploymentMode(file, appendedSteps)).toThrow();

      const lastIdx = src.lastIndexOf(DEPLOYMENT_VAR);
      expect(lastIdx).toBeGreaterThan(-1);
      const stripped = src.slice(0, lastIdx) + src.slice(lastIdx + DEPLOYMENT_VAR.length);
      expect(stripped).not.toBe(src);
      expect(() => assertServingStepBindsDeploymentMode(file, parseText(file, stripped))).toThrow();
    });

    if (file === "deploy.yml") {
      test("the version-id capture is a separate, non-fatal step", () => {
        const deploy = steps.find((s) => s.id === "deploy")!;
        expect(deploy.run, "deploy step must not depend on the version capture").not.toContain("version_id.txt");
        const capture = steps.find((s) => s.name === "Capture Worker version id")!;
        expect(capture, "version-id capture step is missing").toBeDefined();
        expect(capture["continue-on-error"]).toBe(true);
        expect(capture.if).toBeUndefined();
        expect(capture.run).toContain("unreported");
        expect(deploy.name).not.toBe(capture.name);
      });

      test("the image rebuild gate runs after Setup Bun, before install and every version-creating step", () => {
        const gate = steps.findIndex((s) => s.name === "Image rebuild gate");
        expect(gate, "deploy.yml: image rebuild gate is missing").toBeGreaterThan(-1);
        expect(gate, "deploy.yml: the gate must follow Setup Bun").toBeGreaterThan(
          steps.findIndex((s) => (s.name ?? "").includes("Setup Bun")),
        );
        expect(gate, "deploy.yml: the gate must precede Install dependencies").toBeLessThan(
          steps.findIndex((s) => (s.name ?? "").includes("Install dependencies")),
        );
        const versionCreating = steps
          .map((s, i) => (VERSION_CREATING.test(s.run ?? "") ? i : -1))
          .filter((i) => i >= 0);
        expect(versionCreating.length, "deploy.yml: no version-creating step found").toBeGreaterThan(0);
        for (const i of versionCreating) {
          expect(i, `deploy.yml: "${steps[i]!.name}" runs before the image rebuild gate`).toBeGreaterThan(gate);
        }
      });

      test("the image rebuild gate mirrors CI's base rule for this job's triggers", () => {
        const gate = steps.find((s) => s.name === "Image rebuild gate")!;
        expect(gate, "deploy.yml: image rebuild gate is missing").toBeDefined();
        expect(gate.env?.EVENT_NAME, "deploy.yml: the gate must read the trigger").toBe("${{ github.event_name }}");
        expect(gate.env?.BASE_SHA, "deploy.yml: the gate must diff the push's previous tip").toBe(
          "${{ github.event.before }}",
        );
        expect(
          gate.env?.DISPATCH_BASE_SHA,
          "deploy.yml: the dispatch must be able to name the base it diffs",
        ).toBe("${{ inputs.base_sha }}");
        expect(gate.run).toContain('bun scripts/check-image-inputs.ts --base "$base" --ref "$REF_NAME"');
        expect(gate.run).not.toContain("exit 1");

        const ran = (event: string, base: string, dispatchBase: string) =>
          runStep(gate, {
            EVENT_NAME: event,
            BASE_SHA: base,
            DISPATCH_BASE_SHA: dispatchBase,
            REF_NAME: "main",
          });

        const dispatch = ran("workflow_dispatch", "", "");
        expect(dispatch.code, `deploy.yml: a dispatch must not fail\n${dispatch.out}`).toBe(0);
        expect(dispatch.out, "deploy.yml: a dispatch skip must name the trigger").toContain("workflow_dispatch");

        const withBase = ran("workflow_dispatch", "", "f".repeat(40));
        expect(withBase.code, `deploy.yml: a dispatch with a base must evaluate\n${withBase.out}`).toBe(1);
        expect(withBase.out, "deploy.yml: the recovery must run the gate").toContain("::error::");
        expect(withBase.out, "deploy.yml: an unreadable tree is never a pass").toContain(
          "treat as unverified, not a pass",
        );

        const firstPush = ran("push", "0".repeat(40), "");
        expect(firstPush.code, `deploy.yml: the all-zeros base must not fail\n${firstPush.out}`).toBe(0);
        expect(firstPush.out, "deploy.yml: the first-push skip must say why").toContain("no previous commit");
      });
    }
  });
}

describe("ci.yml image rebuild gate", () => {
  const steps = parseWorkflow("ci.yml").jobs.test.steps as Step[];
  const index = steps.findIndex((s) => s.name === "Image rebuild gate");

  test("the gate exists, runs after Setup Bun and before install", () => {
    expect(index, "ci.yml: image rebuild gate is missing").toBeGreaterThan(-1);
    expect(index, "ci.yml: the gate must follow Setup Bun").toBeGreaterThan(
      steps.findIndex((s) => (s.name ?? "").includes("Setup Bun")),
    );
    expect(index, "ci.yml: the gate must precede Install dependencies").toBeLessThan(
      steps.findIndex((s) => (s.name ?? "").includes("Install dependencies")),
    );
  });

  test("the gate reads every event value through env:, never through the script", () => {
    const gate = steps[index]!;
    expect(gate.run, "ci.yml: the gate splices an expression into its script").not.toContain("${{");
    expect(gate.env?.EVENT_NAME, "ci.yml: the gate must read the trigger").toBe("${{ github.event_name }}");
    expect(gate.env?.PR_BASE_SHA, "ci.yml: the gate must diff a pull request's base").toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
    expect(gate.env?.PUSH_BEFORE_SHA, "ci.yml: the gate must diff a push's previous tip").toBe(
      "${{ github.event.before }}",
    );
    expect(gate.run).toContain('bun scripts/check-image-inputs.ts --base "$base"');
    expect(gate.run).not.toContain("exit 1");
  });

  test("the first push's all-zeros base executes as a printed skip", () => {
    const firstPush = runStep(steps[index]!, {
      EVENT_NAME: "push",
      PUSH_BEFORE_SHA: "0".repeat(40),
      BASE_REF: "",
      REF_NAME: "main",
    });
    expect(firstPush.code, `ci.yml: the all-zeros base must not fail\n${firstPush.out}`).toBe(0);
    expect(firstPush.out, "ci.yml: the first-push skip must say why").toContain("no previous commit");
  });
});
