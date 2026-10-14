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
 *   release through only when the Release's own `prerelease` flag is `false`
 *   AND its tag carries no `-` (the two are independent release properties, so
 *   the tag shape alone is not the release's prerelease status); the dispatch
 *   arm is evaluated FIRST so an absent `github.event.release` on dispatch
 *   cannot blow up the expression;
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
 *   never differ from the run SHA), the secret-injection step shape (SECRETS
 *   declared on each consuming step, `jq -n` payload, `--env production` so the
 *   prod Worker — never staging — receives the secrets) placed AFTER the
 *   deploy, prod D1 migrations,
 *   `wrangler deploy --env production`;
 * - the tag↔version validation step (`release:validate` against the run's tag)
 *   placed AFTER tag resolution and BEFORE the first mutating command — a `v*`
 *   tag naming a commit whose version surfaces differ must red the run before
 *   forward-only migrations are applied;
 * - the job-level `env:` carries NO `secrets.` — every production secret is
 *   declared on the exact step that consumes it, and no `uses:` step carries
 *   one (a third-party action revision can only read what its step was given);
 * - the three third-party actions are pinned to commit SHAs (mutable tag only
 *   in a trailing comment);
 * - the PURE required-secret preflight (`:?required`, no mutation) next to the
 *   marker assertion, BEFORE the first mutating wrangler step — a missing
 *   credential must red the run before production is migrated or deployed —
 *   while the `secret bulk` WRITES stay after `wrangler deploy`;
 * - the post-mutation live-version re-capture: after the last mutating step,
 *   `wrangler deployments list --env production --json` overrides the
 *   deploy-log `version_id.txt` with the version the secret uploads actually
 *   created, selecting the NEWEST deployment by `created_on` (the CLI lists
 *   them ascending, so index 0 is the oldest) and reading the live-verified
 *   `versions[0].version_id` shape; it records the explicit
 *   `unavailable (post-secret lookup failed)` marker — never the deploy-log
 *   predecessor — when that lookup cannot confirm the version;
 * - the healthz smoke comparing the live version to the deployed tag;
 * - the deploy step's version-id gate: the recorded value must be a UUID
 *   (`wrangler deploy` prints one) — a bare non-emptiness test passes on a lone
 *   newline, so the shape is asserted and the step fails loudly, while the
 *   deliberately non-fatal re-capture step keeps its own `unavailable …` marker;
 * - the digest-from-deploy-log rule and its never-fatal property (a no-push
 *   deploy records the literal `unchanged (no push in this deploy)` and exits 0);
 * - evidence artifact + run summary;
 * - no direct `${{ }}` interpolation inside any `run:` script (env indirection).
 *
 * Parsing uses python3 + PyYAML exported to JSON — no new dependencies, same
 * method as tests/scripts/release-workflow-guards.test.ts. Structural assertions
 * only: a formatting change cannot silently drop a guard.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("job guard: dispatch arm FIRST, release only for a non-prerelease flag AND a tag without `-` (exact condition)", () => {
    // Exact-normalized pin: swapping the release `&&` for `||`, dropping either
    // half of it, or inverting the flag comparison must fail. The dispatch arm
    // is evaluated FIRST because `github.event.release` is absent on a dispatch
    // event.
    expect(String(wf.jobs.deploy.if).replace(/\s+/g, " ")).toBe(
      "github.event_name == 'workflow_dispatch' || (github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-'))",
    );
  });

  test("mutation: `&&`→`||`, dropping either half, or inverting the flag comparison must fail the pin above", () => {
    // The pin above is what stops a Release flagged prerelease under a dashless
    // tag from reaching production. Show the pin catches each edit that reopens
    // that hole — or its mirror.
    const PINNED =
      "github.event_name == 'workflow_dispatch' || (github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-'))";
    const RELEASE_ARM =
      "github.event.release.prerelease == false && !contains(github.event.release.tag_name, '-')";
    const mutations: [string, string][] = [
      // `&&` → `||`: a prerelease-flagged Release under a dashless tag satisfies
      // the release arm again (the exact P1 this guard closes).
      [RELEASE_ARM, "github.event.release.prerelease == false || !contains(github.event.release.tag_name, '-')"],
      // dropping the flag half: the tag shape alone admits it.
      [RELEASE_ARM, "!contains(github.event.release.tag_name, '-')"],
      // dropping the tag half: a prerelease-flagged `-` tag is admitted.
      [RELEASE_ARM, "github.event.release.prerelease == false"],
      // inverting the flag comparison: every prerelease Release is admitted and
      // no ordinary release is.
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
        // i.e. the exact-normalized pin in the test above would now fail.
        expect(String(mwf.jobs.deploy.if).replace(/\s+/g, " ")).not.toBe(PINNED);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("job env: NON-SECRET only — no `secrets.` at job level; credentials are step-scoped", () => {
    // LOAD-BEARING: a job-level secret lands in the environment of EVERY step,
    // including the SHA-pinned third-party actions. Only the two public
    // identifiers stay job-level.
    expect(wf.jobs.deploy.env).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
      OAUTH_CLIENT_ID: "${{ vars.OAUTH_CLIENT_ID }}",
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

    // the preflight reads the three credentials it asserts (pure shell, no `uses:`)
    expectSecrets("Assert required secrets are set", [
      "OAUTH_CLIENT_SECRET",
      "DASHBOARD_SESSION_SECRET",
      "DASHBOARD_ENCRYPTION_KEY",
    ]);
    // the secret-bulk writes read the values they upload + the token that authenticates
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
    // every wrangler-authenticating step declares the token itself
    for (const n of [
      "Verify Cloudflare account",
      "Apply prod D1 migrations (remote)",
      "Deploy Worker (prod)",
      "Re-capture live Worker version",
    ]) {
      expectSecrets(n, [TOKEN]);
    }

    // LOAD-BEARING: a step that runs THIRD-PARTY action code must be
    // secret-free — a compromised action revision can only read what its step
    // was given, so the tag guard / approval cannot be the last line of defense.
    const actionSteps = steps.filter((s) => s.uses !== undefined);
    expect(actionSteps.length).toBe(3);
    for (const s of actionSteps) expect([s.uses, secretsOf(s)]).toEqual([s.uses, []]);

    // and no OTHER step smuggles one in: the seven above are the full carrier set
    expect(
      steps
        .filter((s) => secretsOf(s).length > 0)
        .map((s) => s.name)
        .sort(),
    ).toEqual(
      [
        "Apply prod D1 migrations (remote)",
        "Assert required secrets are set",
        "Deploy Worker (prod)",
        "Re-capture live Worker version",
        "Verify Cloudflare account",
        "Write ALERT_WEBHOOK_URL secret (bind, or null-delete when unset)",
        "Write required secrets",
      ].sort(),
    );
  });

  test("third-party actions are pinned to commit SHAs with the mutable tag only in a trailing comment", () => {
    const uses = steps.map((s) => s.uses).filter((u): u is string => !!u);
    // a mutable tag here would let a later publish of that tag decide which code
    // runs on the approved production deploy
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(uses).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(uses).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(uses).toContain("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    // the human-readable tag survives as a trailing comment only
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", WORKFLOW), "utf8");
    for (const line of text.split("\n").filter((l) => l.trimStart().startsWith("uses:"))) {
      expect(line).toMatch(/# v\d/);
      expect(line).not.toMatch(/@v\d/);
    }
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
    expect(idx("Write ALERT_WEBHOOK_URL secret")).toBeGreaterThan(idx("Write required secrets"));
    expect(idx("healthz")).toBeGreaterThan(idx("Write ALERT_WEBHOOK_URL secret"));
    expect(idx("Upload deploy evidence")).toBeGreaterThan(idx("healthz"));
  });

  test("the tag↔version validation runs after tag resolution and before the FIRST mutating command", () => {
    const validate = steps.find(
      (s) => s.name === "Validate the tag against the checked-out version surfaces",
    )!;
    expect(validate).toBeDefined();
    // the repository's own release gate, against the run's tag — a `v*` tag can
    // point at a commit whose version surfaces differ, and forward-only
    // migrations would already have been applied by the time healthz noticed.
    expect(validate.env?.TAG).toBe("${{ github.ref_name }}");
    expect(validate.run).toBe('bun run release:validate -- "$TAG"');
    expect(validate.if).toBeUndefined();   // never skipped — a skip re-opens the hole
    expect(validate.run).not.toContain("${{");
    const idx = (needle: string) => steps.findIndex((s) => (s.name ?? "").includes(needle));
    expect(idx("Validate the tag")).toBeGreaterThan(idx("Resolve deploy tag"));
    // strictly before EVERY mutating wrangler step (the D1 migration is first)
    const validateIdx = steps.indexOf(validate);
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(4);
    for (const i of mutatingIdx) expect(validateIdx).toBeLessThan(i);
  });

  test("validation script EXECUTES: a mismatched tag exits non-zero, an aligned tag exits 0", () => {
    // Substring pins cannot see a wrong invocation. Run the step's own body in a
    // synthetic repo whose HEAD carries a real tag, so both directions are
    // observable: the aligned tag passes (the gate's own self-heal case) and a
    // tag naming any other version fails loudly — the hole a hand-cut/re-pointed
    // tag would otherwise reach production through.
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
      // the gate reads package.json + src/version.ts and resolves the tag via
      // git — copy those four files, then tag HEAD.
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
      // the tag that names this tree's version surfaces: validated
      const aligned = runOnce(`v${version}`);
      expect(aligned.stdout.toString()).toContain("all surfaces aligned");
      expect(aligned.exitCode).toBe(0);
      // a tag whose version surface differs: loud, non-zero
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
    // Show both edits that reopen it — removal, and relocation past the D1
    // migration — make the pinned assertions fail.
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
      // 1. removed entirely
      const removed = parse(src.replace(block, ""));
      expect(
        removed.find((s) => s.name === "Validate the tag against the checked-out version surfaces"),
      ).toBeUndefined();
      // 2. relocated to AFTER the D1 migration (position pin now fails)
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
    // The assertion must live in its own step next to the environment-marker
    // assertion, not inside the `secret bulk` writer: inside the writer it runs
    // only AFTER the D1 migration and the Worker deploy, so a missing
    // credential would red a run that has already mutated production.
    const preflight = steps.find((s) => s.name === "Assert required secrets are set")!;
    expect(preflight).toBeDefined();
    // pure: no wrangler invocation, no mutation of any kind
    expect(preflight.run).not.toMatch(/bunx wrangler/);
    expect(preflight.if).toBeUndefined();
    const markerIdx = steps.findIndex((s) => s.name?.includes("production environment marker"));
    const preflightIdx = steps.indexOf(preflight);
    expect(preflightIdx).toBeGreaterThan(markerIdx);
    // every mutating invocation — the required-secret write, the ALERT
    // write/delete arm, the D1 migration and the deploy — comes strictly after
    // the preflight.
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(4);
    for (const i of mutatingIdx) expect(preflightIdx).toBeLessThan(i);
    // and the writer no longer carries the assertion itself.
    const writer = steps.find((s) => s.name === "Write required secrets")!;
    expect(writer.run).not.toContain(":?required");
  });

  test("mutation: folding the `:?required` assertion back into the writer fails the preflight pin", () => {
    // Re-create the reviewed bug — the assertion only inside the post-deploy
    // `secret bulk` step — and show the pin above now fails: there is no pure
    // preflight step, and the first mutation precedes the (relocated) assertion.
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
      // the pin's `name === "Assert required secrets are set"` lookup now finds
      // nothing — i.e. the pin above would fail.
      expect(msteps.find((s) => s.name === "Assert required secrets are set")).toBeUndefined();
      // and the assertion is back after the first mutation (the D1 migration
      // and the deploy precede it), which is the hole the pin closes.
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
    // read of the live deployment, prod-scoped and JSON
    expect(run).toContain("bunx wrangler deployments list --env production --json");
    // the extraction selects the NEWEST deployment by `created_on` — the CLI
    // lists deployments ASCENDING, so `.[0]` is the oldest of the returned page
    // and would report a stale version as live.
    const filter = run.replace(/[ \t]+/g, " ");
    expect(filter).toContain(
      "'max_by(.created_on) | ((.versions // [])[0].version_id) // empty'",
    );
    expect(run).not.toContain(".[0].version_id");
    expect(run).not.toContain("((.[0].versions");
    // the deploy-log predecessor is never written back as if it were live
    expect(run).toContain('"unavailable (post-secret lookup failed)"');
    expect(run).toContain("> version_id.txt");
    // the fallback is explicitly noticed and the step has no failure path
    expect(run).toContain("::notice::");
    expect(run).not.toContain("exit 1");
    expect(run).not.toContain("::error");
    // placement: after the LAST mutating step, still before the smoke
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
      // stub `bunx` only — the real `jq` does the extraction, so the pinned
      // filter expression is what is under test.
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
      // path 1 — resolved: the live CLI shape — an ASCENDING multi-entry page
      // where the newest is NOT first (index 0 is the oldest, exactly as the
      // CLI returns it). The newest must win, so a `.[0]` read is caught here.
      bunx(
        '[{"created_on":"2026-09-22T04:46:18Z","versions":[{"version_id":"451dc81c-0a75-4c1e-8e7d-eb5a4d88aedd","percentage":100}]},' +
          '{"created_on":"2026-10-01T09:12:00Z","versions":[{"version_id":"aaaa1111-0000-0000-0000-000000000000","percentage":100}]},' +
          '{"created_on":"2026-10-14T05:28:48Z","versions":[{"version_id":"40a71ea8-1111-2222-3333-444455556666","percentage":100}]}]',
      );
      const resolved = runOnce("deadbeef");
      expect(resolved.code).toBe(0);
      expect(resolved.out).toBe("40a71ea8-1111-2222-3333-444455556666");
      // the deployed predecessor is gone from the file, not merely overridden
      expect(resolved.out).not.toContain("deadbeef");
      // and NOT the oldest entry (the `.[0]` read the CLI's ascending order
      // used to make look correct)
      expect(resolved.out).not.toBe("451dc81c-0a75-4c1e-8e7d-eb5a4d88aedd");
      // path 2 — empty deployment list: the unavailable marker, NOT the
      // predecessor
      bunx("[]");
      const empty = runOnce("deadbeef");
      expect(empty.code).toBe(0);
      expect(empty.out).toBe("unavailable (post-secret lookup failed)");
      expect(empty.out).not.toContain("deadbeef");
      expect(empty.log).toContain("::notice::");
      // path 3 — the CLI itself fails (non-zero, no JSON): same marker, still
      // exit 0
      bunx("", 1);
      const failed = runOnce("deadbeef");
      expect(failed.code).toBe(0);
      expect(failed.out).toBe("unavailable (post-secret lookup failed)");
      expect(failed.out).not.toContain("deadbeef");
      expect(failed.log).toContain("::notice::");
      // path 3b — a payload of the wrong shape (flat, the form that does not
      // exist) is not read as a live version either.
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
    // The reviewed bug's third form: `.[0]` is the OLDEST of the page the CLI
    // returns, so a run would record a stale deployment's version as live.
    // Show the pinned filter expression no longer matches, and that the same
    // payload really does resolve differently under it.
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
      // i.e. the pin above (`toContain("'max_by(.created_on) | …'")`) now fails.
      expect(mrecap.run).not.toContain("max_by(.created_on) | ((.versions // [])[0].version_id)");
      // and the mutated expression genuinely picks the stale first entry.
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
    // The reviewed bug in its second form: the step exists but leaves the
    // deploy-log value in place when the lookup fails — evidence then names a
    // predecessor as if it were live. Show the pin above now fails.
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
    // Deleting the re-capture step is the reviewed bug (evidence names a
    // predecessor). Show the pin above now fails: no step reads the live
    // deployment after the secret uploads.
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
    // the prod Worker's binding names — the collector renames OAUTH_CLIENT_ID
    // to the GITHUB_OAUTH_CLIENT_ID the dashboard reads.
    expect(run).toContain("GITHUB_OAUTH_CLIENT_ID: env.OAUTH_CLIENT_ID");
    expect(run).toContain("GITHUB_OAUTH_CLIENT_SECRET: env.OAUTH_CLIENT_SECRET");
    expect(run).toContain("DASHBOARD_SESSION_SECRET: env.DASHBOARD_SESSION_SECRET");
    expect(run).toContain("DASHBOARD_ENCRYPTION_KEY: env.DASHBOARD_ENCRYPTION_KEY");
    // `--env production` is load-bearing: without it the command targets the
    // top-level Worker, i.e. staging, and overwrites its secrets.
    expect(run).toContain("bunx wrangler secret bulk --env production");
    // the alert pair is ONE step: a step-level env is not visible to that
    // step's own `if:`, so the set/unset branch lives in the shell — both arms
    // must still call the prod-scoped bulk write.
    const alert = steps.find((s) => s.name === "Write ALERT_WEBHOOK_URL secret (bind, or null-delete when unset)")!;
    expect(alert).toBeDefined();
    expect(alert.if).toBeUndefined();
    expect(alert.env?.ALERT_WEBHOOK_URL).toBe("${{ secrets.ALERT_WEBHOOK_URL }}");
    expect(alert.run).toContain('if [ -n "$ALERT_WEBHOOK_URL" ]; then');
    expect(alert.run).toContain("jq -n '{ALERT_WEBHOOK_URL: env.ALERT_WEBHOOK_URL}' | bunx wrangler secret bulk --env production");
    expect(alert.run).toContain("{ALERT_WEBHOOK_URL: null}");
    expect(alert.run).toContain("fi");
    expect(alert.run).not.toContain("${{");
    // the null-delete arm mutates the Worker too, and the set arm binds the
    // webhook — both carry `--env production` on the SAME line as the write.
    // every mutating Wrangler invocation in this workflow carries the flag.
    const mutating = stepRuns.filter((r) => /bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(r));
    expect(mutating.length).toBe(4);
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
    // required-secret write, the ALERT write/delete, the D1 migration and the
    // deploy — not merely account verification. Moving any one of them above
    // the resolver would let a branch run reach a production mutation before it
    // is rejected.
    const verIdx = steps.findIndex((s) => s.id === "ver");
    const mutatingIdx = steps
      .map((s, i) => (/bunx wrangler (secret bulk|d1 migrations apply|deploy)\b/.test(s.run ?? "") ? i : -1))
      .filter((i) => i >= 0);
    expect(mutatingIdx.length).toBe(4);
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

  /**
   * Execute a deploy-step body with a stubbed `bunx` (the step's only external
   * command) that prints a wrangler deploy log carrying `WRANGLER_VERSION_ID`:
   * `tee deploy.log` lands it on disk, so the extraction and its gate run for
   * real. `bash -eo pipefail` mirrors the step's `shell: bash`.
   */
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
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WRANGLER_VERSION_ID: payload },
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

  test("version-id gate asserts the UUID shape, not bare non-emptiness (nit e)", () => {
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const run = deploy.run!;
    // `test -s` passes on a lone newline — the value is this release's evidence,
    // so the SHAPE is what gets asserted, and only the deploy step's own
    // extraction fails loudly on it.
    expect(run).not.toContain("test -s version_id.txt");
    expect(run).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(run).toContain("::error::");
    expect(run).toContain("exit 1");
    // the deliberately non-fatal re-capture step keeps its own marker instead
    const recap = steps.find((s) => s.name === "Re-capture live Worker version")!;
    expect(recap.run).not.toContain("no Worker version id");
  });

  test("version-id gate script EXECUTES: a UUID is recorded, a non-UUID payload fails loudly", () => {
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const uuid = "40a71ea8-1111-2222-3333-444455556666";

    const ok = runDeployStep(deploy.run!, uuid);
    expect(ok.code).toBe(0);
    expect(ok.recorded).toBe(uuid);

    // a short/non-UUID token: the pre-fix gate (`test -s`) accepted it
    const short = runDeployStep(deploy.run!, "deadbeef");
    expect(short.code).not.toBe(0);
    expect(short.out).toContain("no Worker version id");

    // a value-less log line (trailing spaces): `cut` yields an empty field, the
    // file gets a lone newline — the exact hole `test -s` left open
    const blank = runDeployStep(deploy.run!, "  ");
    expect(blank.code).not.toBe(0);
    expect(blank.out).toContain("no Worker version id");
  });

  test("MUTATION/reverting to `test -s version_id.txt`: the value-less payload passes the old gate", () => {
    // The pin above is load-bearing: swap the shape gate back for the reviewed
    // bare non-emptiness test and the lone-newline payload sails through.
    const deploy = steps.find((s) => s.name === "Deploy Worker (prod)")!;
    const src = deploy.run!;
    const write = "printf '%s\\n' \"$VERSION_ID\" > version_id.txt";
    const start = src.indexOf("if ! printf '%s' \"$VERSION_ID\"");
    const end = src.indexOf(write);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const mutated =
      src.slice(0, start) + write + "\n          test -s version_id.txt\n          " + src.slice(end + write.length);
    expect(mutated).not.toBe(src);

    const fixed = runDeployStep(src, "  ");
    expect(fixed.code).not.toBe(0);
    const unfixed = runDeployStep(mutated, "  ");
    expect(unfixed.code).toBe(0);
    expect(unfixed.recorded).toBe("");
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
