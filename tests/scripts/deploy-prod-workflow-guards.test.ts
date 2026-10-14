/**
 * Production deploy workflow guards.
 *
 * YAML-parses `.github/workflows/deploy-prod.yml` and pins the release-gated
 * prod deploy surface:
 *
 * - triggers: `release: types: [published]` + `workflow_dispatch` with NO
 *   inputs — the run's own ref IS the deploy ref (`gh workflow run
 *   deploy-prod.yml --ref <tag>`), so bring-up / rollback on the current
 *   prerelease tag needs no separate input;
 * - the prerelease guard: one job-level `if` that dispatches always and lets a
 *   release through only when the tag carries no `-`; the dispatch arm is
 *   evaluated FIRST so an absent `github.event.release` on dispatch cannot blow
 *   up the expression;
 * - a SECRETS-FREE `guard-tag-ref` job that asserts `github.ref_type == 'tag'`,
 *   carries no `environment:`/`env:`, and holds no step that runs a ref's code;
 *   the `deploy` job (the one with `environment: production` and the production
 *   secrets) carries `needs: guard-tag-ref`, so a non-tag ref can neither reach
 *   a job holding production secrets nor run repository code with them in scope;
 * - `environment: production`, concurrency group `deploy-prod-mstar-inspector`,
 *   `permissions: { contents: read }`, `timeout-minutes: 30`;
 * - the run-SHA checkout (`github.sha`, full history), the pre-repository-code
 *   HEAD == run-SHA assertion and the production-environment marker
 *   (`vars.PROD_ENV_MARKER`) assertion, the tag-ref assertion that fails a
 *   non-tag run loudly before any mutation (T3-3: the deployed checkout can
 *   never differ from the run SHA), the secret-injection step shape (job-level
 *   env, `jq -n` payload, `--env production` so the prod Worker — never staging
 *   — receives the secrets) placed AFTER the deploy, prod D1 migrations,
 *   `wrangler deploy --env production`;
 * - the healthz smoke comparing the live version to the deployed tag;
 * - the digest-from-deploy-log rule and its never-fatal property (a no-push
 *   deploy records the literal `unchanged (no push in this deploy)` and exits 0);
 * - evidence artifact + run summary;
 * - no direct `${{ }}` interpolation inside any `run:` script (env indirection).
 *
 * Parsing uses python3 + PyYAML exported to JSON — no new dependencies, same
 * method as tests/scripts/release-workflow-guards.test.ts. Structural assertions
 * only: a formatting change cannot silently drop a guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..", "..");

const PY_DUMP = "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))";

/** Parse a workflow YAML into a plain JS structure (throws loudly on failure). */
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

/** PyYAML parses the bare `on:` key as boolean true → JSON key "true". */
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
    // ORDER matters: the guard job is declared first, and the secret-holding
    // deploy job declares `needs: guard-tag-ref` (pinned below).
    expect(Object.keys(wf.jobs)).toEqual(["guard-tag-ref", "deploy"]);
  });

  test("guard-tag-ref: secrets-free (no environment/env), checkout-free, asserts the run is on a tag", () => {
    const guard = wf.jobs["guard-tag-ref"];
    // LOAD-BEARING: no `environment:` means GitHub attaches no production
    // secret to this job, and no checkout means no ref's code runs here.
    expect(guard.environment).toBeUndefined();
    expect(guard.env).toBeUndefined();
    expect(guard.needs).toBeUndefined();
    expect(guard.permissions).toEqual({ contents: "read" });
    expect(guard["timeout-minutes"]).toBe(5);
    const gsteps = guard.steps as Step[];
    expect(gsteps.length).toBe(1);
    // no step pulls the ref's tree or uses an action at all
    expect(gsteps.every((s) => s.uses === undefined && typeof s.run === "string")).toBe(true);
    const g = gsteps[0]!;
    expect(g.env?.REF_TYPE).toBe("${{ github.ref_type }}");
    expect(g.env?.REF_NAME).toBe("${{ github.ref_name }}");
    expect(g.run).toContain('if [ "$REF_TYPE" != "tag" ]; then');
    expect(g.run).toContain("::error::");
    expect(g.run).toContain("exit 1");
    // `${{ }}` must not be interpolated straight into the guard's run script
    expect(g.run).not.toContain("${{");
  });

  test("guard-tag-ref: `continue-on-error` is absent at job and step level (the tag gate is load-bearing)", () => {
    // `needs: guard-tag-ref` is the only thing stopping a non-tag ref's code
    // from reaching the secret-bearing job. `continue-on-error: true` at either
    // level keeps every other assertion green while un-gating that path, so its
    // ABSENCE is pinned here — the same field the sibling release guard test
    // pins for the analogous step.
    const guard = wf.jobs["guard-tag-ref"];
    expect(guard["continue-on-error"]).toBeUndefined();
    const gsteps = guard.steps as Step[];
    expect(gsteps).toHaveLength(1);
    expect(gsteps[0]!["continue-on-error"]).toBeUndefined();
  });

  test("guard-tag-ref script: tag ref exits 0, branch ref exits non-zero with the ::error:: text", () => {
    const g = (wf.jobs["guard-tag-ref"].steps as Step[])[0]!;
    // GitHub's default `run:` shell is `bash -e {0}` — reproduce fail-fast.
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
    // The pin above asserts the field is ABSENT. Show that adding it (the one
    // edit that silently un-gates a branch ref) is what the pin catches.
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
    // Demonstrate the guard's job-boundary gate rather than merely asserting its
    // presence: strip `needs` from a copy of the workflow and show the same
    // check the pin above uses now fails. Guards against a refactor that drops
    // `needs` while the guard job itself survives.
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
      // i.e. the pin in the test above would now fail — gate is load-bearing.
      expect(mwf.jobs.deploy.needs).not.toEqual("guard-tag-ref");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("triggers: release published + workflow_dispatch with NO inputs (run ref is the deploy ref)", () => {
    expect(triggers(wf).release).toEqual({ types: ["published"] });
    const dispatch = triggers(wf).workflow_dispatch;
    // no `inputs:` block at all — T3-3: a `ref` input would let a run deploy a
    // tag other than the one it runs on. `null` is YAML's empty-mapping form.
    expect(dispatch).toBeNull();
    // a `push:` trigger would deploy production on every main push — this
    // workflow is release/dispatch only.
    expect(triggers(wf).push).toBeUndefined();
    // BOTH triggers must stay: dropping `release` closes the human/UI-release
    // belt, dropping `workflow_dispatch` closes the explicit-dispatch door.
    expect(Object.keys(triggers(wf)).sort()).toEqual(["release", "workflow_dispatch"]);
  });

  test("job guard: dispatch arm FIRST, release only for a tag without `-` (exact condition)", () => {
    // Exact-normalized pin: swapping `||` for `&&`, or reordering the arms,
    // must fail. The dispatch arm is evaluated FIRST because
    // `github.event.release` is absent on a dispatch event.
    expect(String(wf.jobs.deploy.if).replace(/\s+/g, " ")).toBe(
      "github.event_name == 'workflow_dispatch' || !contains(github.event.release.tag_name, '-')",
    );
  });

  test("environment: production, concurrency group, permissions, timeout", () => {
    expect(wf.jobs.deploy.environment).toBe("production");
    expect(wf.concurrency).toEqual({
      group: "deploy-prod-mstar-inspector",
      "cancel-in-progress": false,
    });
    expect(wf.jobs.deploy.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.deploy["timeout-minutes"]).toBe(30);
  });

  test("job env: five secrets + two vars, passed through step env (no inline interpolation)", () => {
    expect(wf.jobs.deploy.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
      OAUTH_CLIENT_ID: "${{ vars.OAUTH_CLIENT_ID }}",
      OAUTH_CLIENT_SECRET: "${{ secrets.OAUTH_CLIENT_SECRET }}",
      DASHBOARD_SESSION_SECRET: "${{ secrets.DASHBOARD_SESSION_SECRET }}",
      DASHBOARD_ENCRYPTION_KEY: "${{ secrets.DASHBOARD_ENCRYPTION_KEY }}",
      ALERT_WEBHOOK_URL: "${{ secrets.ALERT_WEBHOOK_URL }}",
    });
  });

  test("checkout pins the run's immutable SHA (github.sha) with full history", () => {
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    // A ref NAME is resolved at fetch time — a tag moved during the approval
    // wait would change the deployed tree. The SHA cannot move.
    expect(checkout?.with?.ref).toBe("${{ github.sha }}");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    // T3-3: the deployed checkout IS the run — never an independent input.
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
    // MUST precede every step that executes repository code or mutates.
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
    // Revert the must-fix in the parsed copy and show the pin above now fails:
    // `ref: github.ref_name` (fetch-time name resolution) must not pass.
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
    // the marker is NOT a job-level env passthrough — it is read in-step only,
    // so the job env pin below stays at the credential set.
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
    // Bring-up order: the Worker is created WITH its real bindings first, then
    // the secrets land. The reverse order used to materialise a bound-less
    // draft Worker holding production secrets.
    expect(idx("Write required secrets")).toBeGreaterThan(idx("Deploy Worker"));
    expect(idx("Write optional ALERT_WEBHOOK_URL secret")).toBeGreaterThan(idx("Write required secrets"));
    expect(idx("healthz")).toBeGreaterThan(idx("Remove ALERT_WEBHOOK_URL"));
    expect(idx("Upload deploy evidence")).toBeGreaterThan(idx("healthz"));
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

  test("secret injection: jq -n payload renamed to GITHUB_OAUTH_* + four keys, piped to `secret bulk --env production`", () => {
    const secretStep = steps.find((s) => s.name === "Write required secrets");
    expect(secretStep).toBeDefined();
    const run = secretStep!.run!;
    // the prod Worker's binding names — the collector renames OAUTH_CLIENT_ID
    // to the GITHUB_OAUTH_CLIENT_ID the dashboard reads.
    expect(run).toContain("GITHUB_OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID");
    expect(run).toContain("GITHUB_OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET");
    expect(run).toContain("DASHBOARD_SESSION_SECRET: env.DASHBOARD_SESSION_SECRET");
    expect(run).toContain("DASHBOARD_ENCRYPTION_KEY: env.DASHBOARD_ENCRYPTION_KEY");
    // `--env production` is load-bearing: without it the command targets the
    // top-level Worker, i.e. staging, and overwrites its secrets.
    expect(run).toContain("bunx wrangler secret bulk --env production");
    // optional alert pair: set when present, explicit null-delete when unset
    const alertSet = steps.find((s) => s.name === "Write optional ALERT_WEBHOOK_URL secret");
    const alertUnset = steps.find((s) => s.name?.includes("Remove ALERT_WEBHOOK_URL"));
    expect(alertSet?.if).toBe("env.ALERT_WEBHOOK_URL != ''");
    expect(alertSet?.run).toContain("bunx wrangler secret bulk --env production");
    expect(alertUnset?.if).toBe("env.ALERT_WEBHOOK_URL == ''");
    expect(alertUnset?.run).toContain("{ALERT_WEBHOOK_URL: null}");
    // the deletion mutates a Worker too — same `--env production` pin, else it
    // would delete staging's alert secret.
    expect(alertUnset?.run).toContain("bunx wrangler secret bulk --env production");
    // every mutating Wrangler invocation in this workflow carries the flag.
    const mutating = stepRuns.filter((r) => /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(r));
    expect(mutating.length).toBeGreaterThan(0);
    for (const r of mutating) expect(r).toMatch(/--env production/);
  });

  test("resolve deploy tag: tag-based version output + loud non-tag failure before mutations", () => {
    const resolve = steps.find((s) => s.id === "ver");
    expect(resolve?.name).toBe("Resolve deploy tag");
    // the run's own ref is the deploy identity — no independent input exists.
    expect(resolve?.env?.REF_TYPE).toBe("${{ github.ref_type }}");
    expect(resolve?.env?.REF_NAME).toBe("${{ github.ref_name }}");
    expect(JSON.stringify(resolve?.env)).not.toContain("inputs.");
    const run = resolve!.run!;
    // a non-tag run (e.g. dispatched on a branch) fails loudly here, before any
    // cloud mutation — production can only ever deploy a tag.
    expect(run).toContain('if [ "$REF_TYPE" != "tag" ]; then');
    expect(run).toContain("::error::");
    expect(run).toContain("exit 1");
    // the v-normalized tag is the expected healthz version
    expect(run).toContain('echo "version=v${REF_NAME#v}" >> "$GITHUB_OUTPUT"');
    // the tag-ref gate must precede EVERY mutating Wrangler step — the
    // required-secret write, both optional alert arms, the D1 migration and the
    // deploy — not merely account verification. Moving any one of them above
    // the resolver would let a branch run reach a production mutation before it
    // is rejected.
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
      // GitHub's default `run:` shell is `bash -e {0}` — reproduce fail-fast.
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
    // the STAGING database must never be migrated by this workflow
    expect(runsText).not.toMatch(/migrations apply mstar-inspector-db\b/);
  });

  test("no step targets the staging instance (comment narration excluded)", () => {
    // step runs + `uses`/`with` values — comments are narration, not behavior
    expect(runsText).not.toContain("42ch.dev");
    expect(runsText).not.toContain("mstar-inspector-sandbox-v2");
    expect(steps.map((s) => s.uses ?? "").join("\n")).not.toContain("staging");
  });

  test("deploy runs `wrangler deploy --env production`, tees deploy.log, records the Version ID", () => {
    expect(runsText).toContain("bunx wrangler deploy --env production 2>&1 | tee deploy.log");
    expect(runsText).toContain("Current Version ID:");
    expect(runsText).toContain("version_id.txt");
  });

  test("healthz smoke asserts the deployed tag's version, not mere liveness", () => {
    const smoke = steps.find((s) => s.name?.includes("healthz"));
    expect(smoke).toBeDefined();
    const run = smoke!.run!;
    const norm = run.replace(/[ \t]+/g, " ").trim();
    expect(run).toContain("https://inspector.mstar.page/healthz");
    // direction of the comparison: the live version must EQUAL the expected
    // tag (a flipped `!=`, or dropping the check, must fail the suite).
    expect(norm).toContain(
      `[ "$(printf '%s' "$body" | jq -r '.version')" = "$EXPECTED_VERSION" ]`,
    );
    expect(norm).toContain(`[ "$(printf '%s' "$body" | jq -r '.ok')" = "true" ]`);
    // exactly five attempts — a fresh Worker version takes a moment to reach
    // the edge; fewer retries must fail the suite.
    expect(norm).toContain("for _ in 1 2 3 4 5; do");
    // terminal arm: all attempts exhausted ⇒ loud, nonzero failure
    expect(norm).toContain('if [ "$ok" != 1 ]; then');
    expect(norm).toContain("::error::healthz did not report version $EXPECTED_VERSION within 5 attempts");
    expect(norm).toContain("exit 1");
    // the expected value comes from the tag resolved in the earlier step
    expect(smoke!.env?.EXPECTED_VERSION).toBe("${{ steps.ver.outputs.version }}");
    expect(smoke!.if).toBeUndefined();
  });

  test("healthz smoke script EXECUTES: matching version exits 0, mismatching version exits non-zero", () => {
    // Substring pins above cannot see a flipped comparison (`ok=0` → `ok=1`
    // would still pass). Execute the extracted script with a stubbed `curl` /
    // `sleep` so both directions are observable without touching the network.
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
    // Sandbox 1.0 durable_object: `containers list --json` reports an empty
    // image for this account, so it must not be the digest source.
    expect(run).not.toContain("containers list");
  });

  test("digest step is never fatal: suppression binds to the extraction pipeline, fallback is conditional", () => {
    const digest = steps.find((s) => s.name?.includes("image digest"));
    const run = digest!.run!;
    const norm = run.replace(/[ \t]+/g, " ");
    expect(run).toContain("unchanged (no push in this deploy)");
    // the suppression must sit on the EXTRACTION pipeline itself: a fail-fast
    // shell exits on the unmatched grep before any later fallback is reached.
    const extractionLine = norm.split("\n").find((l) => l.includes("> image_digest.txt"))!;
    expect(extractionLine.trim()).toMatch(/image_digest\.txt \|\| true$/);
    // fallback only when the file is empty — an unconditional echo would mask
    // a real digest.
    expect(norm).toContain("if ! test -s image_digest.txt; then");
    // an evidence step must carry no failure path of its own
    expect(run).not.toContain("exit 1");
    expect(run).not.toContain("::error");
  });

  test("digest script exits 0 under a fail-fast shell for both a pushed and a no-push log", () => {
    const digest = steps.find((s) => s.name?.includes("image digest"))!;
    const dir = mkdtempSync(join(tmpdir(), "digest-"));
    try {
      // GitHub's default `run:` shell is `bash -e {0}` — reproduce fail-fast.
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
