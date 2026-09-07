/**
 * Durable workflow-guard tests (plan 50 QC round B2; AC2's 守卫断言 made
 * permanent — previously only transient task-4 heredoc evidence).
 *
 * YAML-parses `.github/workflows/release-prep.yml` + `release.yml` and pins
 * the release-chain guard surface (also the 51/52 hook surface):
 *
 * - triggers: prep = workflow_dispatch with the optional `version` input;
 *   release = pull_request closed + branches [main];
 * - release job guard: merged == true AND title prefix `release v`;
 * - permission faces (AD-4): prep = contents + pull-requests write, no
 *   issues; release = contents write + actions read (the deploy-evidence
 *   `gh run list`/`gh run download` face, plan 52) and nothing else;
 * - concurrency: prep group `release-prep`, cancel-in-progress: false;
 * - checkout ref pins merge_commit_sha (release side);
 * - softprops/action-gh-release SHA pin string (byte-exact, sole
 *   third-party action; new-to-repo actions are SHA-pinned — pin convention);
 * - deploy-evidence append step (plan 52): exactly one `gh release edit`
 *   (count, not containment) and the notes file handed off from the extract
 *   step's `notes_file` output — never rebuilt from RUNNER_TEMP;
 * - timeout-minutes on both jobs.
 *
 * Parsing uses python3 + PyYAML (the method validated in task 4; preinstalled
 * on GitHub ubuntu runners) exported to JSON — no new dependencies. Structural
 * assertions only: a formatting change cannot silently drop a guard.
 */
import { readFileSync } from "node:fs";
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

const SOFTPROPS_PIN = "softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64";

describe("release-prep.yml guards", () => {
  const wf = parseWorkflow("release-prep.yml");

  test("trigger: workflow_dispatch with optional string `version` input", () => {
    const dispatch = triggers(wf)["workflow_dispatch"];
    expect(dispatch).toBeDefined();
    expect(dispatch.inputs.version).toEqual({
      description: expect.any(String),
      required: false,
      type: "string",
    });
  });

  test("permissions (AD-4): contents + pull-requests write, no issues", () => {
    expect(wf.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
  });

  test("concurrency: group release-prep, cancel-in-progress false", () => {
    expect(wf.concurrency).toEqual({ group: "release-prep", "cancel-in-progress": false });
  });

  test("job: timeout-minutes 30", () => {
    expect(wf.jobs.prepare["timeout-minutes"]).toBe(30);
  });

  test("no direct `${{ }}` interpolation inside run: scripts (env indirection)", () => {
    const runs = (wf.jobs.prepare.steps as { run?: string; env?: unknown }[])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).not.toContain("${{");
    }
  });

  test("chain steps present: tag-exists early fail, prepare, validate, jq resolve, PR open/update", () => {
    const runs = (wf.jobs.prepare.steps as { run?: string }[])
      .map((s) => s.run ?? "")
      .join("\n---step---\n");
    expect(runs).toContain('git rev-parse "v$V"');
    expect(runs).toContain("release:prepare");
    expect(runs).toContain("release:validate");
    expect(runs).toContain("jq -er .version package.json");
    expect(runs).toContain("gh pr create");
    expect(runs).toContain("gh pr edit");
    expect(runs).not.toContain("gh label");
  });
});

describe("release.yml guards", () => {
  const wf = parseWorkflow("release.yml");

  test("trigger: pull_request closed on main", () => {
    expect(triggers(wf).pull_request).toEqual({ types: ["closed"], branches: ["main"] });
  });

  test("job guard: merged == true AND title prefix `release v`", () => {
    const cond = String(wf.jobs.release.if).replace(/\s+/g, " ");
    expect(cond).toContain("github.event.pull_request.merged == true");
    expect(cond).toContain("startsWith(github.event.pull_request.title, 'release v')");
  });

  test("permissions (AD-4): contents write + actions read (evidence face), nothing else", () => {
    expect(wf.permissions).toEqual({ contents: "write", actions: "read" });
  });

  test("job: timeout-minutes 30", () => {
    expect(wf.jobs.release["timeout-minutes"]).toBe(30);
  });

  test("checkout pins merge_commit_sha", () => {
    const checkout = (wf.jobs.release.steps as { uses?: string; with?: { ref?: string } }[]).find(
      (s) => s.uses?.startsWith("actions/checkout"),
    );
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.merge_commit_sha }}");
  });

  test("softprops/action-gh-release is the sole third-party action, byte-exact SHA pin", () => {
    const uses = (wf.jobs.release.steps as { uses?: string }[])
      .map((s) => s.uses)
      .filter((u): u is string => typeof u === "string");
    expect(uses).toContain(SOFTPROPS_PIN);
    const third = uses.filter((u) => !u.startsWith("actions/") && !u.startsWith("oven-sh/"));
    expect(third).toEqual([SOFTPROPS_PIN]);
    // pin convention residue (QC B3): the SHA pin must carry the convention comment
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(text).toContain("actions NEW to this repo are SHA-pinned");
  });

  test("tag + notes steps: annotated tag with idempotent skip, bilingual notes + separator contract", () => {
    const runs = (wf.jobs.release.steps as { run?: string }[])
      .map((s) => s.run ?? "")
      .join("\n---step---\n");
    expect(runs).toContain("git tag -a");
    expect(runs).toContain("git rev-parse");
    expect(runs).toContain("--lang en");
    expect(runs).toContain("--lang cn");
    expect(runs).toContain("printf '\\n\\n---\\n\\n'");
  });

  test("deploy-evidence append step (plan 52): after release creation, never fails the release, env-indirected", () => {
    const steps = wf.jobs.release.steps as {
      id?: string;
      uses?: string;
      run?: string;
      env?: Record<string, string>;
      "continue-on-error"?: boolean;
    }[];
    const createIdx = steps.findIndex((s) => s.uses?.startsWith("softprops/action-gh-release"));
    const evidIdx = steps.findIndex((s) => s.run?.includes("collect-deploy-evidence"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(evidIdx).toBeGreaterThan(createIdx); // tag/Release creation never waits for evidence

    const evid = steps[evidIdx]!;
    const evidRun = evid.run!;
    // recording surface, not a gate: swallowed failures stay loud (::error) but green
    expect(evid["continue-on-error"]).toBe(true);
    expect(evidRun).toContain("::error::");
    // AD-3: single idempotent rewrite from the workspace notes file, same separator
    expect(evidRun).toContain("printf '\\n\\n---\\n\\n' >> \"$NOTES_FILE\"");
    expect(evidRun).toContain('gh release edit "v${VERSION}" --notes-file "$NOTES_FILE"');
    // folded T2 review: "one edit" is a count, not mere containment — a second
    // `gh release edit` call must fail this guard even if the first stays intact
    expect(evidRun.match(/gh release edit/g)).toHaveLength(1);
    expect(evidRun).not.toContain("${{");
    // plan-50 QC B1: version/SHA/token reach the script via step env, never raw interpolation
    expect(evid.env).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      VERSION: "${{ steps.ver.outputs.version }}",
      MERGE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
      // folded T2 review: the notes path is handed off from the extract step's
      // output (single shared path), not rebuilt here
      NOTES_FILE: "${{ steps.changelog.outputs.notes_file }}",
    });
    // shared-path handoff: the extract step exports the path exactly once …
    const extract = steps.find((s) => s.id === "changelog");
    expect(extract?.run).toContain('echo "notes_file=${NOTES_FILE}" >> "$GITHUB_OUTPUT"');
    // … and this step consumes it without re-deriving it from RUNNER_TEMP/VERSION
    expect(evidRun).not.toContain("RUNNER_TEMP");
  });

  test("no direct `${{ }}` interpolation inside run: scripts (env indirection)", () => {
    const runs = (wf.jobs.release.steps as { run?: string }[])
      .map((s) => s.run)
      .filter((r): r is string => typeof r === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).not.toContain("${{");
    }
  });
});
