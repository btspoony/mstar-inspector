import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

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

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
};

const WORKFLOW = "deploy-prod.yml";
const wf = parseWorkflow(WORKFLOW);
const steps = wf.jobs.deploy.steps as Step[];
const stepRuns = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
const runsText = stepRuns.join("\n---step---\n");

describe("deploy-prod.yml guards", () => {
  test("workflow name + exactly two jobs: the secrets-free guard, then deploy", () => {
    expect(wf.name).toBe("Deploy prod");
    expect(Object.keys(wf.jobs)).toEqual(["guard-tag-ref", "deploy"]);
  });

  test("guard-tag-ref: secrets-free (no environment/env), checkout-free, asserts the run is on a tag", () => {
    const guard = wf.jobs["guard-tag-ref"];
    expect(guard.environment).toBeUndefined();
    expect(guard.env).toBeUndefined();
    expect(guard.needs).toBeUndefined();
    expect(guard.permissions).toEqual({ contents: "read" });
    expect(guard["timeout-minutes"]).toBe(5);
    const gsteps = guard.steps as Step[];
    expect(gsteps.length).toBe(1);
    expect(gsteps.every((s) => s.uses === undefined && typeof s.run === "string")).toBe(true);
    const g = gsteps[0]!;
    expect(g.env?.REF_TYPE).toBe("${{ github.ref_type }}");
    expect(g.env?.REF_NAME).toBe("${{ github.ref_name }}");
    expect(g.run).toContain('if [ "$REF_TYPE" != "tag" ]; then');
    expect(g.run).toContain("::error::");
    expect(g.run).toContain("exit 1");
    expect(g.run).not.toContain("${{");
  });

  test("guard-tag-ref: `continue-on-error` is absent at job and step level (the tag gate is load-bearing)", () => {
    const guard = wf.jobs["guard-tag-ref"];
    expect(guard["continue-on-error"]).toBeUndefined();
    const gsteps = guard.steps as Step[];
    expect(gsteps).toHaveLength(1);
    expect(gsteps[0]!["continue-on-error"]).toBeUndefined();
  });

  test("guard-tag-ref script: tag ref exits 0, branch ref exits non-zero with the ::error:: text", () => {
    const g = (wf.jobs["guard-tag-ref"].steps as Step[])[0]!;
    const runOnce = (refType: string, refName: string) =>
      Bun.spawnSync(["bash", "-e", "-c", g.run!], {
        env: { ...process.env, REF_TYPE: refType, REF_NAME: refName },
      });
    const tag = runOnce("tag", "v1.2.3");
    expect(tag.exitCode).toBe(0);
    const branch = runOnce("branch", "main");
    expect(branch.exitCode).not.toBe(0);
    expect(branch.stdout.toString() + branch.stderr.toString()).toContain("deploys a tag");
  });

  test("mutation: `continue-on-error: true` on the guard step must fail the absence pin", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace(
      "      - name: Assert the run is on a tag\n",
      "      - name: Assert the run is on a tag\n        continue-on-error: true\n",
    );
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "coe-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const mwf = JSON.parse(proc.stdout.toString());
      expect((mwf.jobs["guard-tag-ref"].steps as Step[])[0]!["continue-on-error"]).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deploy job is gated on the guard (`needs`) and keeps environment: production", () => {
    expect(wf.jobs.deploy.needs).toEqual("guard-tag-ref");
    expect(wf.jobs.deploy.environment).toBe("production");
  });

  test("mutation: removing `needs` from deploy must fail the suite (the gate is load-bearing)", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace(/^\s*needs: guard-tag-ref.*$/m, "");
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "wf-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const mwf = JSON.parse(proc.stdout.toString());
      expect(mwf.jobs.deploy.needs).toBeUndefined();
      expect(mwf.jobs.deploy.needs).not.toEqual("guard-tag-ref");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("triggers: release published + workflow_dispatch whose only input is the digest audit", () => {
    expect(triggers(wf).release).toEqual({ types: ["published"] });
    const dispatch = triggers(wf).workflow_dispatch;
    expect(Object.keys(dispatch)).toEqual(["inputs"]);
    expect(Object.keys(dispatch.inputs).sort()).toEqual(["expected_container_digest"]);
    expect(dispatch.inputs.expected_container_digest).toMatchObject({ required: false, default: "" });
    expect(triggers(wf).push).toBeUndefined();
    expect(Object.keys(triggers(wf)).sort()).toEqual(["release", "workflow_dispatch"]);
  });

  test("job guard: dispatch arm FIRST, release only for a non-prerelease flag AND a tag without `-` (exact condition)", () => {
    expect(String(wf.jobs.deploy.if).replace(/\s+/g, " ")).toBe(
      "github.event_name == 'workflow_dispatch' || (github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-'))",
    );
  });

  test("mutation: `&&`→`||`, dropping either half, or inverting the flag comparison must fail the pin above", () => {
    const PINNED =
      "github.event_name == 'workflow_dispatch' || (github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-'))";
    const RELEASE_ARM =
      "github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-')";
    const mutations: [string, string][] = [
      [RELEASE_ARM, "github.event.release.prerelease == false || !contains(github.event.release.tag_name, '-')"],
      [RELEASE_ARM, "!contains(github.event.release.tag_name, '-')"],
      [RELEASE_ARM, "github.event.release.prerelease == false"],
      ["github.event.release.prerelease == false", "github.event.release.prerelease != false"],
    ];
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "wf-if-"));
    try {
      for (const [from, to] of mutations) {
        const mutated = src.replace(from, to);
        expect(mutated).not.toBe(src);
        const path = join(dir, "deploy-prod.yml");
        writeFileSync(path, mutated);
        const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
        expect(proc.exitCode).toBe(0);
        const mwf = JSON.parse(proc.stdout.toString());
        expect(String(mwf.jobs.deploy.if).replace(/\s+/g, " ")).not.toBe(PINNED);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("environment: production, concurrency group with `queue: max`, permissions, timeout", () => {
    expect(wf.jobs.deploy.environment).toBe("production");
    expect(wf.concurrency).toEqual({
      group: "deploy-prod-mstar-inspector",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(wf.jobs.deploy.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.deploy["timeout-minutes"]).toBe(30);
  });

  test("mutation: dropping `queue: max` must fail the concurrency pin (pending deploys are preserved)", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace(/^  queue: max\n/m, "");
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "qmax-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const mwf = JSON.parse(proc.stdout.toString());
      expect(mwf.concurrency.queue).toBeUndefined();
      expect(mwf.concurrency).not.toEqual({
        group: "deploy-prod-mstar-inspector",
        "cancel-in-progress": false,
        queue: "max",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("job env: NON-SECRET only — no `secrets.` at job level; credentials are step-scoped", () => {
    expect(wf.jobs.deploy.env).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
      OAUTH_CLIENT_ID: "${{ vars.OAUTH_CLIENT_ID }}",
      PLATFORM_OPERATORS: "${{ vars.PLATFORM_OPERATORS }}",
    });
    expect(JSON.stringify(wf.jobs.deploy.env)).not.toContain("secrets.");
  });

  test("every production secret is declared ONLY on the steps that consume it; no `uses:` step carries one", () => {
    const secretsOf = (s: Step) =>
      Object.entries(s.env ?? {})
        .filter(([, v]) => v.includes("secrets."))
        .map(([k]) => k)
        .sort();
    const byName = (n: string) => steps.find((s) => s.name === n)!;
    const TOKEN = "CLOUDFLARE_API_TOKEN";
    const expectSecrets = (name: string, keys: string[]) =>
      expect([name, secretsOf(byName(name))]).toEqual([name, [...keys].sort()]);

    expectSecrets("Assert required secrets are set", [
      "OAUTH_CLIENT_SECRET",
      "DASHBOARD_SESSION_SECRET",
      "DASHBOARD_ENCRYPTION_KEY",
    ]);
    expectSecrets("Assert usable encryption key (pre-deploy gate)", ["DASHBOARD_ENCRYPTION_KEY"]);
    expectSecrets("Write required secrets", [
      TOKEN,
      "OAUTH_CLIENT_SECRET",
      "DASHBOARD_SESSION_SECRET",
      "DASHBOARD_ENCRYPTION_KEY",
    ]);
    expectSecrets("Write ALERT_WEBHOOK_URL secret (bind, or null-delete when unset)", [
      TOKEN,
      "ALERT_WEBHOOK_URL",
    ]);
    for (const n of [
      "Verify Cloudflare account",
      "Apply prod D1 migrations (remote)",
      "Re-run App attribution repair (workspace-backfill.sql, idempotent)",
      "Assert zero orphan Apps (pre-deploy gate)",
      "Deploy Worker (prod)",
      "Deploy serving version (prod)",
      "Re-capture live Worker version",
      "Assert zero orphan Apps (post-deploy)",
      "Open the review routing gate (idempotent)",
    ]) {
      expectSecrets(n, [TOKEN]);
    }

    const actionSteps = steps.filter((s) => s.uses !== undefined);
    for (const s of actionSteps) expect([s.uses, secretsOf(s)]).toEqual([s.uses, []]);

    expect(
      steps
        .filter((s) => secretsOf(s).length > 0)
        .map((s) => s.name)
        .sort(),
    ).toEqual(
      [
        "Apply prod D1 migrations (remote)",
        "Assert required secrets are set",
        "Assert usable encryption key (pre-deploy gate)",
        "Assert zero orphan Apps (post-deploy)",
        "Assert zero orphan Apps (pre-deploy gate)",
        "Deploy serving version (prod)",
        "Deploy Worker (prod)",
        "Open the review routing gate (idempotent)",
        "Re-capture live Worker version",
        "Re-run App attribution repair (workspace-backfill.sql, idempotent)",
        "Verify Cloudflare account",
        "Write ALERT_WEBHOOK_URL secret (bind, or null-delete when unset)",
        "Write required secrets",
      ].sort(),
    );
  });

  test("third-party actions are pinned to commit SHAs with the mutable tag only in a trailing comment", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => !!u);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    for (const line of text.split("\n").filter((l) => l.trimStart().startsWith("uses:"))) {
      expect(line).toMatch(/# v\d/);
      expect(line).not.toMatch(/@v\d/);
    }
  });

  test("checkout pins the run's immutable SHA (github.sha) with full history", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(String(checkout?.with?.ref)).not.toContain("inputs.");
  });

  test("HEAD is asserted equal to the run SHA before any repository code runs", () => {
    const assertStep = steps.find((s) => s.name?.includes("matches the run SHA"))!;
    expect(assertStep).toBeDefined();
    expect(assertStep.env?.RUN_SHA).toBe("${{ github.sha }}");
    expect(assertStep.run).toContain("git rev-parse HEAD");
    expect(assertStep.run).toContain('if [ "$HEAD_SHA" != "$RUN_SHA" ]; then');
    expect(assertStep.run).toContain("::error::");
    expect(assertStep.run).toContain("exit 1");
    expect(assertStep.run).not.toContain("${{");
    const idx = (needle: string) => steps.findIndex((s) => (s.name ?? "").includes(needle));
    const assertIdx = steps.findIndex((s) => s.name?.includes("matches the run SHA"));
    for (const later of [
      "Install dependencies",
      "Typecheck",
      "Test",
      "Build SPA",
      "Verify Cloudflare account",
      "Deploy Worker",
    ]) {
      expect(idx(later)).toBeGreaterThan(assertIdx);
    }
  });

  test("mutation: a checkout that does NOT pin the run SHA fails the pin (immutability is load-bearing)", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace("ref: ${{ github.sha }}", "ref: ${{ github.ref_name }}");
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "sha-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const mwf = JSON.parse(proc.stdout.toString());
      const mcheckout = (mwf.jobs.deploy.steps as Step[]).find((s) =>
        s.uses?.startsWith("actions/checkout"),
      );
      expect(mcheckout?.with?.ref).not.toBe("${{ github.sha }}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production environment marker is asserted before any mutation", () => {
    const marker = steps.find((s) => s.name?.includes("production environment marker"))!;
    expect(marker).toBeDefined();
    expect(marker.env?.PROD_ENV_MARKER).toBe("${{ vars.PROD_ENV_MARKER }}");
    expect(marker.run).toContain('if [ "$PROD_ENV_MARKER" != "production" ]; then');
    expect(marker.run).toContain("::error::");
    expect(marker.run).toContain("exit 1");
    expect(wf.jobs.deploy.env.PROD_ENV_MARKER).toBeUndefined();
    const markerIdx = steps.findIndex((s) => s.name?.includes("production environment marker"));
    const firstMutation = steps.findIndex((s) =>
      /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? ""),
    );
    expect(firstMutation).toBeGreaterThan(markerIdx);
  });

  test("step order: assert+verify before deploy, secrets after deploy, smoke last", () => {
    const names = steps.map((s) => s.name ?? "");
    const idx = (needle: string) => names.findIndex((n) => n.includes(needle));
    expect(idx("matches the run SHA")).toBeGreaterThan(-1);
    expect(idx("production environment marker")).toBeGreaterThan(idx("matches the run SHA"));
    expect(idx("Setup Bun")).toBeGreaterThan(idx("production environment marker"));
    expect(idx("Install dependencies")).toBeGreaterThan(idx("Setup Bun"));
    expect(idx("Typecheck")).toBeGreaterThan(idx("Install dependencies"));
    expect(idx("Test")).toBeGreaterThan(idx("Typecheck"));
    expect(idx("Build SPA")).toBeGreaterThan(idx("Test"));
    expect(idx("Verify Cloudflare account")).toBeGreaterThan(idx("Build SPA"));
    expect(idx("Resolve deploy tag")).toBeGreaterThan(idx("Verify Cloudflare account"));
    expect(idx("Apply prod D1 migrations")).toBeGreaterThan(idx("Resolve deploy tag"));
    expect(idx("Deploy Worker")).toBeGreaterThan(idx("Apply prod D1 migrations"));
    expect(idx("Write required secrets")).toBeGreaterThan(idx("Deploy Worker"));
    expect(idx("Write ALERT_WEBHOOK_URL secret")).toBeGreaterThan(idx("Write required secrets"));
    expect(idx("Deploy serving version")).toBeGreaterThan(idx("Write ALERT_WEBHOOK_URL secret"));
    expect(idx("Re-capture live Worker version")).toBeGreaterThan(idx("Deploy serving version"));
    expect(idx("healthz")).toBeGreaterThan(idx("Write ALERT_WEBHOOK_URL secret"));
    expect(idx("Upload deploy evidence")).toBeGreaterThan(idx("healthz"));
  });

  test("the serving deploy binds the deployment shape, and the summary no longer reports a tenant mode", () => {
    const serving = steps.find((s) => s.name === "Deploy serving version (prod)")!;
    expect(serving).toBeDefined();
    expect(serving.run?.trim()).toBe(
      'bunx wrangler deploy --env production --var "DEPLOYMENT_MODE:saas" --var "PLATFORM_OPERATORS:${PLATFORM_OPERATORS:-}"',
    );
    expect(serving.if).toBeUndefined();

    const summary = steps.find((s) => s.name === "Record prod deploy evidence")!;
    expect(summary.run).not.toContain("Tenant mode");
  });

  test("the tag↔version validation runs after tag resolution and before the FIRST mutating command", () => {
    const validate = steps.find(
      (s) => s.name === "Validate the tag against the checked-out version surfaces",
    )!;
    expect(validate).toBeDefined();
    expect(validate.env?.TAG).toBe("${{ github.ref_name }}");
    expect(validate.run).toBe('bun run release:validate -- "$TAG"');
    expect(validate.if).toBeUndefined();
    expect(validate.run).not.toContain("${{");
    const idx = (needle: string) => steps.findIndex((s) => (s.name ?? "").includes(needle));
    expect(idx("Validate the tag")).toBeGreaterThan(idx("Resolve deploy tag"));
    const validateIdx = steps.indexOf(validate);
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(5);
    for (const i of mutatingIdx) expect(validateIdx).toBeLessThan(i);
  });

  test("validation script EXECUTES: a mismatched tag exits non-zero, an aligned tag exits 0", () => {
    const validate = steps.find(
      (s) => s.name === "Validate the tag against the checked-out version surfaces",
    )!;
    const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") {
      throw new Error("package.json carries no string `version` field");
    }
    const version = pkg.version;
    const dir = mkdtempSync(join(tmpdir(), "validate-tag-run-"));
    try {
      for (const rel of [
        "package.json",
        "src/version.ts",
        "scripts/release-surfaces.ts",
        "scripts/validate-release-version.ts",
      ]) {
        const dest = join(dir, rel);
        const parent = dest.slice(0, dest.lastIndexOf("/"));
        Bun.spawnSync(["mkdir", "-p", parent]);
        writeFileSync(dest, readFileSync(join(REPO_ROOT, rel)));
      }
      for (const args of [
        ["init", "-q"],
        ["add", "-A"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"],
        ["-c", "tag.gpgsign=false", "tag", `v${version}`],
      ]) {
        const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        expect(proc.exitCode).toBe(0);
      }
      const runOnce = (tag: string) =>
        Bun.spawnSync(["bash", "-e", "-c", validate.run!], {
          cwd: dir,
          env: { ...process.env, TAG: tag },
        });
      const aligned = runOnce(`v${version}`);
      expect(aligned.stdout.toString()).toContain("all surfaces aligned");
      expect(aligned.exitCode).toBe(0);
      const mismatch = runOnce("v9.9.9");
      expect(mismatch.exitCode).not.toBe(0);
      const log = mismatch.stdout.toString() + mismatch.stderr.toString();
      expect(log).toContain(`MISMATCH package.json (package.json): tag v9.9.9, file has ${version}`);
      expect(log).toContain("failed validation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mutation: dropping the validation step (or moving it after the migration) must fail the pin above", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "validate-tag-"));
    const parse = (text: string) => {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, text);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      return JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
    };
    const mutates = (s: Step) =>
      /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "");
    try {
      const block = src.slice(
        src.indexOf("      # LOAD-BEARING: the tag must match the tree it names"),
        src.indexOf("      # Prod D1 starts empty"),
      );
      const stepBlock = block.slice(block.indexOf("      - name: Validate the tag"));
      expect(stepBlock).toContain("release:validate");
      const removed = parse(src.replace(block, ""));
      expect(
        removed.find((s) => s.name === "Validate the tag against the checked-out version surfaces"),
      ).toBeUndefined();
      const relocated = parse(
        src.replace(block, "").replace(
          "      - name: Deploy Worker (prod)",
          stepBlock + "      - name: Deploy Worker (prod)",
        ),
      );
      const rvIdx = relocated.findIndex(
        (s) => s.name === "Validate the tag against the checked-out version surfaces",
      );
      expect(rvIdx).toBeGreaterThan(relocated.findIndex(mutates));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("typecheck + test + build:spa run before deploy (self-verification)", () => {
    expect(runsText).toContain("bun run typecheck");
    expect(runsText).toContain("bun test");
    expect(runsText).toContain("bun run build:spa");
  });

  test("account assertion + whoami, and the required-secret assertion", () => {
    expect(runsText).toContain('test -n "$CLOUDFLARE_ACCOUNT_ID"');
    expect(runsText).toContain("bunx wrangler whoami");
    expect(runsText).toContain(":?required");
  });

  test("required-secret preflight is PURE and precedes every mutating wrangler step", () => {
    const preflight = steps.find((s) => s.name === "Assert required secrets are set")!;
    expect(preflight).toBeDefined();
    expect(preflight.run).not.toMatch(/bunx wrangler/);
    expect(preflight.if).toBeUndefined();
    const markerIdx = steps.findIndex((s) => s.name?.includes("production environment marker"));
    const preflightIdx = steps.indexOf(preflight);
    expect(preflightIdx).toBeGreaterThan(markerIdx);
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(5);
    for (const i of mutatingIdx) expect(preflightIdx).toBeLessThan(i);
    const writer = steps.find((s) => s.name === "Write required secrets")!;
    expect(writer.run).not.toContain(":?required");
  });

  test("mutation: folding the `:?required` assertion back into the writer fails the preflight pin", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const start = src.indexOf("      # PURE preflight — no mutation.");
    const end = src.indexOf("      - name: Setup Bun");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mutation =
      '        run: |\n          : "${OAUTH_CLIENT_ID:?required}" "${OAUTH_CLIENT_SECRET:?required}" \\\n            "${DASHBOARD_SESSION_SECRET:?required}" "${DASHBOARD_ENCRYPTION_KEY:?required}"\n          jq -n \'';
    const mutated = (src.slice(0, start) + src.slice(end)).replace(
      "        run: |\n          jq -n '{",
      mutation + "{",
    );
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const msteps = JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
      expect(msteps.find((s) => s.name === "Assert required secrets are set")).toBeUndefined();
      const writerIdx = msteps.findIndex((s) => s.name === "Write required secrets");
      const deployIdx = msteps.findIndex((s) => (s.name ?? "").includes("Deploy Worker"));
      expect(msteps[writerIdx]!.run).toContain(":?required");
      expect(deployIdx).toBeLessThan(writerIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("live version is re-captured after the last mutation: verified shape, never a predecessor fallback", () => {
    const recap = steps.find((s) => s.name === "Re-capture live Worker version")!;
    expect(recap).toBeDefined();
    const run = recap.run!;
    expect(run).toContain("bunx wrangler deployments list --env production --json");
    const filter = run.replace(/[ \t]+/g, " ");
    expect(filter).toContain(
      "'max_by(.created_on) | ((.versions // [])[0].version_id) // empty'",
    );
    expect(run).not.toContain(".[0].version_id");
    expect(run).not.toContain("((.[0].versions");
    expect(run).toContain('"unavailable (post-secret lookup failed)"');
    expect(run).toContain("> version_id.txt");
    expect(run).toContain("::notice::");
    expect(run).not.toContain("exit 1");
    expect(run).not.toContain("::error");
    const recapIdx = steps.indexOf(recap);
    const lastMutation = Math.max(
      ...steps.map((s, i) =>
        /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1,
      ),
    );
    expect(recapIdx).toBeGreaterThan(lastMutation);
    expect(recapIdx).toBeLessThan(steps.findIndex((s) => (s.name ?? "").includes("healthz")));
    expect(steps[steps.length - 1]!.name).toContain("Record prod deploy evidence");
  });

  test("live version re-capture script EXECUTES: resolves / empty / CLI failure (never the predecessor)", () => {
    const recap = steps.find((s) => s.name === "Re-capture live Worker version")!;
    const dir = mkdtempSync(join(tmpdir(), "recap-"));
    try {
      writeFileSync(join(dir, "version_id.txt"), "deadbeef\n");
      const bunx = (out: string, code = 0) => {
        writeFileSync(
          join(dir, "bunx"),
          `#!/bin/sh\n${out === "" ? "" : `printf '%s\\n' '${out}'\n`}exit ${code}\n`,
        );
        Bun.spawnSync(["chmod", "+x", join(dir, "bunx")]);
      };
      const runOnce = (deployLogVersion: string) => {
        writeFileSync(join(dir, "version_id.txt"), deployLogVersion);
        const proc = Bun.spawnSync(["bash", "-e", "-c", recap.run!], {
          cwd: dir,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        });
        return {
          code: proc.exitCode,
          out: readFileSync(join(dir, "version_id.txt"), "utf8").trim(),
          log: proc.stdout.toString() + proc.stderr.toString(),
        };
      };
      bunx(
        '[{"created_on":"2026-09-22T04:46:18Z","versions":[{"version_id":"451dc81c-0a75-4c1e-8e7d-eb5a4d88aedd","percentage":100}]},' +
          '{"created_on":"2026-10-01T09:12:00Z","versions":[{"version_id":"aaaa1111-0000-0000-0000-000000000000","percentage":100}]},' +
          '{"created_on":"2026-10-14T05:28:48Z","versions":[{"version_id":"40a71ea8-1111-2222-3333-444455556666","percentage":100}]}]',
      );
      const resolved = runOnce("deadbeef");
      expect(resolved.code).toBe(0);
      expect(resolved.out).toBe("40a71ea8-1111-2222-3333-444455556666");
      expect(resolved.out).not.toContain("deadbeef");
      expect(resolved.out).not.toBe("451dc81c-0a75-4c1e-8e7d-eb5a4d88aedd");
      bunx("[]");
      const empty = runOnce("deadbeef");
      expect(empty.code).toBe(0);
      expect(empty.out).toBe("unavailable (post-secret lookup failed)");
      expect(empty.out).not.toContain("deadbeef");
      expect(empty.log).toContain("::notice::");
      bunx("", 1);
      const failed = runOnce("deadbeef");
      expect(failed.code).toBe(0);
      expect(failed.out).toBe("unavailable (post-secret lookup failed)");
      expect(failed.out).not.toContain("deadbeef");
      expect(failed.log).toContain("::notice::");
      bunx('[{"version_id":"beef4567"}]');
      const flat = runOnce("deadbeef");
      expect(flat.code).toBe(0);
      expect(flat.out).toBe("unavailable (post-secret lookup failed)");
      expect(flat.out).not.toContain("beef4567");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mutation: reverting the extraction to `.[0]` fails the pin (ascending order makes index 0 stale)", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace(
      "max_by(.created_on) | ((.versions // [])[0].version_id) // empty",
      "((.[0].versions // [])[0].version_id) // empty",
    );
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "recap-idx0-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const msteps = JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
      const mrecap = msteps.find((s) => s.name === "Re-capture live Worker version")!;
      expect(mrecap.run).not.toContain("max_by(.created_on) | ((.versions // [])[0].version_id)");
      const payload = JSON.stringify([
        { created_on: "2026-09-22T04:46:18Z", versions: [{ version_id: "451dc81c" }] },
        { created_on: "2026-10-14T05:28:48Z", versions: [{ version_id: "40a71ea8" }] },
      ]);
      const pick = (expr: string) =>
        Bun.spawnSync(["jq", "-r", expr], { stdin: new TextEncoder().encode(payload) })
          .stdout.toString()
          .trim();
      expect(pick("((.[0].versions // [])[0].version_id) // empty")).toBe("451dc81c");
      expect(pick("max_by(.created_on) | ((.versions // [])[0].version_id) // empty")).toBe(
        "40a71ea8",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mutation: a predecessor fallback in the re-capture must fail the pin", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const mutated = src.replace(
      'printf \'%s\\n\' "unavailable (post-secret lookup failed)" > version_id.txt',
      "true",
    );
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "recap-fallback-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const msteps = JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
      const mrecap = msteps.find((s) => s.name === "Re-capture live Worker version")!;
      expect(mrecap.run).not.toContain("unavailable (post-secret lookup failed)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mutation: dropping the live re-capture leaves the deploy-log value as the only version source", () => {
    const src = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    const start = src.indexOf("      # Every `secret bulk` above creates");
    const end = src.indexOf("      # Release identity, not mere liveness");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mutated = src.slice(0, start) + src.slice(end);
    expect(mutated).not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "recap-mut-"));
    try {
      const path = join(dir, "deploy-prod.yml");
      writeFileSync(path, mutated);
      const proc = Bun.spawnSync(["python3", "-c", PY_DUMP, path], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode).toBe(0);
      const msteps = JSON.parse(proc.stdout.toString()).jobs.deploy.steps as Step[];
      expect(msteps.find((s) => s.name === "Re-capture live Worker version")).toBeUndefined();
      const mtext = msteps.map((s) => s.run ?? "").join("\n");
      expect(mtext).not.toContain("deployments list --env production --json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("secret injection: jq -n payload renamed to GITHUB_OAUTH_* + four keys, piped to `secret bulk --env production`", () => {
    const secretStep = steps.find((s) => s.name === "Write required secrets");
    expect(secretStep).toBeDefined();
    const run = secretStep!.run!;
    expect(run).toContain("GITHUB_OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID");
    expect(run).toContain("GITHUB_OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET");
    expect(run).toContain("DASHBOARD_SESSION_SECRET: env.DASHBOARD_SESSION_SECRET");
    expect(run).toContain("DASHBOARD_ENCRYPTION_KEY: env.DASHBOARD_ENCRYPTION_KEY");
    expect(run).toContain("bunx wrangler secret bulk --env production");
    const alert = steps.find((s) => s.name === "Write ALERT_WEBHOOK_URL secret (bind, or null-delete when unset)")!;
    expect(alert).toBeDefined();
    expect(alert.if).toBeUndefined();
    expect(alert.env?.ALERT_WEBHOOK_URL).toBe("${{ secrets.ALERT_WEBHOOK_URL }}");
    expect(alert.run).toContain('if [ -n "$ALERT_WEBHOOK_URL" ]; then');
    expect(alert.run).toContain("jq -n '{ALERT_WEBHOOK_URL: env.ALERT_WEBHOOK_URL}' | bunx wrangler secret bulk --env production");
    expect(alert.run).toContain("{ALERT_WEBHOOK_URL: null}");
    expect(alert.run).toContain("fi");
    expect(alert.run).not.toContain("${{");
    const mutating = stepRuns.filter((r) => /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(r));
    expect(mutating.length).toBe(5);
    for (const r of mutating) expect(r).toMatch(/--env production/);
  });

  test("resolve deploy tag: tag-based version output + loud non-tag failure before mutations", () => {
    const resolve = steps.find((s) => s.id === "ver");
    expect(resolve?.name).toBe("Resolve deploy tag");
    expect(resolve?.env?.REF_TYPE).toBe("${{ github.ref_type }}");
    expect(resolve?.env?.REF_NAME).toBe("${{ github.ref_name }}");
    expect(JSON.stringify(resolve?.env)).not.toContain("inputs.");
    const run = resolve!.run!;
    expect(run).toContain('if [ "$REF_TYPE" != "tag" ]; then');
    expect(run).toContain("::error::");
    expect(run).toContain("exit 1");
    expect(run).toContain('echo "version=v${REF_NAME#v}" >> "$GITHUB_OUTPUT"');
    const verIdx = steps.findIndex((s) => s.id === "ver");
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(5);
    for (const i of mutatingIdx) expect(verIdx).toBeLessThan(i);
  });

  test("tag-ref gate fails a non-tag run under a fail-fast shell, passes a tag run", () => {
    const resolve = steps.find((s) => s.id === "ver")!;
    const dir = mkdtempSync(join(tmpdir(), "ver-"));
    try {
      const runOnce = (refType: string, refName: string) =>
        Bun.spawnSync(["bash", "-e", "-c", resolve.run!], {
          cwd: dir,
          env: {
            ...process.env,
            REF_TYPE: refType,
            REF_NAME: refName,
            GITHUB_OUTPUT: join(dir, "out.txt"),
          },
        });
      const branch = runOnce("branch", "main");
      expect(branch.exitCode).not.toBe(0);
      expect(branch.stdout.toString() + branch.stderr.toString()).toContain("deploys a tag");
      const tag = runOnce("tag", "v1.2.3");
      expect(tag.exitCode).toBe(0);
      expect(readFileSync(join(dir, "out.txt"), "utf8")).toContain("version=v1.2.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prod D1 migrations on the prod database, remote, --env production", () => {
    expect(runsText).toContain(
      "bunx wrangler d1 migrations apply mstar-inspector-prod-db --remote --env production",
    );
    expect(runsText).not.toMatch(/migrations apply mstar-inspector-db\b/);
  });

  test("no step targets the staging instance (comment narration excluded)", () => {
    expect(runsText).not.toContain("42ch.dev");
    expect(runsText).not.toContain("mstar-inspector-sandbox-v2");
    expect(steps.map((s) => s.uses ?? "").join("\n")).not.toContain("staging");
  });

  test("deploy runs `wrangler deploy --env production`, tees deploy.log, records the Version ID", () => {
    expect(runsText).toContain(
      'bunx wrangler deploy --env production --var "DEPLOYMENT_MODE:saas" --var "PLATFORM_OPERATORS:${PLATFORM_OPERATORS:-}" 2>&1 | tee deploy.log',
    );
    expect(runsText).toContain("Current Version ID:");
    expect(runsText).toContain("version_id.txt");
  });

  function runDeployStep(
    body: string,
    payload: string,
  ): { code: number; out: string; recorded: string } {
    const dir = mkdtempSync(join(tmpdir(), "deploy-step-"));
    try {
      writeFileSync(
        join(dir, "bunx"),
        `#!/usr/bin/env bash
printf 'Uploaded mstar-inspector-production\\nCurrent Version ID: %s\\n' "$WRANGLER_VERSION_ID"
`,
      );
      Bun.spawnSync(["chmod", "+x", join(dir, "bunx")]);
      const proc = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", body], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          WRANGLER_VERSION_ID: payload,
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        },
      });
      const file = join(dir, "version_id.txt");
      return {
        code: proc.exitCode,
        out: proc.stdout.toString() + proc.stderr.toString(),
        recorded: existsSync(file) ? readFileSync(file, "utf8").trim() : "<absent>",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("deploy-log version recording asserts the UUID shape and is NEVER fatal (nit e)", () => {
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const run = deploy.run!;
    expect(run).not.toContain("test -s version_id.txt");
    expect(run).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(run).toContain('"unavailable (deploy log had no version id)"');
    expect(run).toContain("::warning::");
    expect(run).not.toContain("::error");
    expect(run).not.toContain("exit 1");
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    expect(text).toContain("the post-secret re-capture overwrites it");
    const recap = steps.find((s) => s.name === "Re-capture live Worker version")!;
    expect(recap.run).not.toContain("no Worker version id");
  });

  test("version-id recording script EXECUTES: a UUID is recorded, a non-UUID payload records the marker and exits 0", () => {
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const uuid = "40a71ea8-1111-2222-3333-444455556666";

    const ok = runDeployStep(deploy.run!, uuid);
    expect(ok.code).toBe(0);
    expect(ok.recorded).toBe(uuid);

    const short = runDeployStep(deploy.run!, "deadbeef");
    expect(short.code).toBe(0);
    expect(short.recorded).toBe("unavailable (deploy log had no version id)");
    expect(short.out).toContain("::warning::");

    const blank = runDeployStep(deploy.run!, "  ");
    expect(blank.code).toBe(0);
    expect(blank.recorded).toBe("unavailable (deploy log had no version id)");
    expect(blank.out).toContain("::warning::");
  });

  test("MUTATION/reintroducing `exit 1` in the deploy-log recording: a first bring-up would strand the run", () => {
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const src = deploy.run!;
    const marker = 'printf \'%s\\n\' "unavailable (deploy log had no version id)" > version_id.txt';
    expect(src).toContain(marker);
    const mutated = src.replace(marker, "exit 1");
    expect(mutated).not.toBe(src);

    const fixed = runDeployStep(src, "  ");
    expect(fixed.code).toBe(0);
    expect(fixed.recorded).toBe("unavailable (deploy log had no version id)");
    const unfixed = runDeployStep(mutated, "  ");
    expect(unfixed.code).not.toBe(0);
    expect(unfixed.recorded).toBe("<absent>");
  });

  test("healthz smoke asserts the deployed tag's version, not mere liveness", () => {
    const smoke = steps.find((s) => s.name?.includes("healthz"));
    expect(smoke).toBeDefined();
    const run = smoke!.run!;
    const norm = run.replace(/[ \t]+/g, " ").trim();
    expect(run).toContain("https://inspector.mstar.page/healthz");
    expect(norm).toContain(
      `[ "$(printf '%s' "$body" | jq -r '.version')" = "$EXPECTED_VERSION" ]`,
    );
    expect(norm).toContain(`[ "$(printf '%s' "$body" | jq -r '.ok')" = "true" ]`);
    expect(norm).toContain("for _ in 1 2 3 4 5; do");
    expect(norm).toContain('if [ "$ok" != 1 ]; then');
    expect(norm).toContain("::error::healthz did not report version $EXPECTED_VERSION within 5 attempts");
    expect(norm).toContain("exit 1");
    expect(smoke!.env?.EXPECTED_VERSION).toBe("${{ steps.ver.outputs.version }}");
    expect(smoke!.if).toBeUndefined();
  });

  test("healthz smoke script EXECUTES: matching version exits 0, mismatching version exits non-zero", () => {
    const smoke = steps.find((s) => s.name?.includes("healthz"))!;
    const dir = mkdtempSync(join(tmpdir(), "healthz-"));
    try {
      writeFileSync(
        join(dir, "curl"),
        '#!/bin/sh\nprintf \'{"ok":true,"version":"%s"}\\n\' "$HEALTHZ_VERSION"\n',
      );
      writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
      Bun.spawnSync(["chmod", "+x", join(dir, "curl"), join(dir, "sleep")]);
      const runOnce = (live: string) =>
        Bun.spawnSync(["bash", "-e", "-c", smoke.run!], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            EXPECTED_VERSION: "v1.2.3",
            HEALTHZ_VERSION: live,
          },
        });
      expect(runOnce("v1.2.3").exitCode).toBe(0);
      const mismatch = runOnce("v9.9.9");
      expect(mismatch.exitCode).not.toBe(0);
      expect(mismatch.stdout.toString() + mismatch.stderr.toString()).toContain(
        "did not report version v1.2.3",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cron smoke reads the deploy log", () => {
    const cron = steps.find((s) => s.name?.includes("cron"));
    expect(cron?.run).toContain('grep -F "schedule: */15 * * * *" deploy.log');
  });

  test("digest comes from the account-scoped deploy-log anchor (never `containers list`)", () => {
    const digest = steps.find((s) => s.name?.includes("image digest"));
    expect(digest).toBeDefined();
    const run = digest!.run!;
    expect(run).toContain(
      'grep -oE "registry\\.cloudflare\\.com/${CLOUDFLARE_ACCOUNT_ID}/[a-z0-9-]+@sha256:[0-9a-f]{64}" deploy.log',
    );
    expect(run).toContain("sha256:[0-9a-f]{64}");
    expect(run).toContain("image_digest.txt");
    expect(run).not.toContain("containers list");
  });

  test("digest step is never fatal: suppression binds to the extraction pipeline, fallback is conditional", () => {
    const digest = steps.find((s) => s.name?.includes("image digest"));
    const run = digest!.run!;
    const norm = run.replace(/[ \t]+/g, " ");
    expect(run).toContain("unchanged (no push in this deploy)");
    const extractionLine = norm.split("\n").find((l) => l.includes("> image_digest.txt"))!;
    expect(extractionLine.trim()).toMatch(/image_digest\.txt \|\| true$/);
    expect(norm).toContain("if ! test -s image_digest.txt; then");
    expect(run).not.toContain("exit 1");
    expect(run).not.toContain("::error");
  });

  test("digest script exits 0 under a fail-fast shell for both a pushed and a no-push log", () => {
    const digest = steps.find((s) => s.name?.includes("image digest"))!;
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    try {
      const runOnce = (log: string) => {
        writeFileSync(join(dir, "deploy.log"), log);
        const proc = Bun.spawnSync(["bash", "-e", "-c", digest.run!], {
          cwd: dir,
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "abc123" },
        });
        return {
          code: proc.exitCode,
          out: readFileSync(join(dir, "image_digest.txt"), "utf8").trim(),
        };
      };
      expect(runOnce("No changes to be made\n")).toEqual({
        code: 0,
        out: "unchanged (no push in this deploy)",
      });
      const sha = `sha256:${"a".repeat(64)}`;
      expect(runOnce(`registry.cloudflare.com/abc123/worker@${sha}\n`)).toEqual({
        code: 0,
        out: sha,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("evidence artifact: deploy-evidence with three files, always uploaded", () => {
    const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(upload.with).toEqual({
      name: "deploy-evidence",
      path: "deploy.log\nversion_id.txt\nimage_digest.txt\n",
      "if-no-files-found": "error",
    });
    expect(upload.if).toBe("always()");
  });

  test("run summary step records version, digest and the run link", () => {
    const summary = steps.find((s) => s.name?.includes("Record prod deploy evidence"))!;
    const run = summary.run!;
    expect(run).toContain("GITHUB_STEP_SUMMARY");
    expect(run).toContain("$GITHUB_RUN_ID");
    expect(run).toContain("version_id.txt");
    expect(run).toContain("image_digest.txt");
    expect(run).toContain("https://inspector.mstar.page");
  });

  test("no direct `${{ }}` interpolation inside run: scripts (env indirection)", () => {
    expect(stepRuns.length).toBeGreaterThan(0);
    for (const run of stepRuns) {
      expect(run).not.toContain("${{");
    }
  });

  test("the workflow text carries no local process identifiers", () => {
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    expect(text).not.toMatch(/\.mstar\//);
  });
});
