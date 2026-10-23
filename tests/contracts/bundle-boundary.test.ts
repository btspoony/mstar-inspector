/**
 * Bidirectional bundle boundary (compass D12).
 *
 * Each side's entry is bundled with exactly its own legal runtime deps
 * externalized, so a dependency that belongs to the other side cannot be
 * hidden by an `external` list — it lands in `metafile.inputs` as a resolved
 * module path. Paths are the only reliable leak signal: package names need
 * not survive bundling/minification.
 *
 * `target: "bun"` is the closest bundler target (Bun has none for `workerd`);
 * engine and `zod` are legal Worker-side deps, and `cloudflare:*` is
 * platform-injected, hence external.
 *
 * Builds go to a temp directory — the repository tree is never touched.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKER_ENTRY = join(REPO_ROOT, "src", "worker", "entry.ts");
const RUNNER_ENTRY = join(REPO_ROOT, "packages", "runner", "src", "runner.ts");

/**
 * Resolved input paths of one bundle.
 *
 * shortcut: under `bun test` (Bun 1.4.0) the session's first build of a
 * repo-resident entry fails to resolve a plain relative import
 * (`../version`); the identical second build succeeds. Retry once so a real
 * resolution failure still fails twice; upgrade when Bun fixes it.
 */
async function buildInputs(entry: string, external: string[]): Promise<string[]> {
  const outdir = mkdtempSync(join(tmpdir(), "bundle-boundary-"));
  try {
    const opts = { entrypoints: [entry], target: "bun" as const, external, outdir, metafile: true, throw: false };
    let result = await Bun.build(opts);
    if (!result.success) result = await Bun.build(opts);
    expect(result.success).toBe(true);
    const inputs = Object.keys(result.metafile!.inputs);
    // An empty graph would make every leak filter below vacuous.
    expect(inputs.length).toBeGreaterThan(0);
    return inputs;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

// Runner-owned runtime dep, so never reachable from the Worker entry.
const WORKER_LEAK = "node_modules/@oh-my-pi/";
// Worker-owned deps, so never reachable from the runner entry.
const RUNNER_LEAKS = ["node_modules/hono", "node_modules/@octokit/"];

describe("bundle boundary", () => {
  test("Worker graph carries no runner dependency", async () => {
    const inputs = await buildInputs(WORKER_ENTRY, ["cloudflare:*"]);
    expect(inputs.filter((path) => path.includes(WORKER_LEAK))).toEqual([]);
  });

  test("runner graph carries no Worker dependency", async () => {
    const inputs = await buildInputs(RUNNER_ENTRY, ["@mstar-harness/engine", "@oh-my-pi/pi-coding-agent"]);
    expect(inputs.filter((path) => RUNNER_LEAKS.some((leak) => path.includes(leak)))).toEqual([]);
  });

  // Non-vacuity: a passed assertion is worthless if the predicate can never
  // match. Each predicate is fed a bundle that genuinely resolves into the
  // forbidden subtree.
  test("both predicates flag a real boundary import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-boundary-probe-"));
    try {
      const ompEntry = join(dir, "omp.ts");
      writeFileSync(ompEntry, `import cfg from ${JSON.stringify(Bun.resolveSync("@oh-my-pi/pi-coding-agent/package.json", REPO_ROOT))};\nexport default cfg;\n`);
      const workerDepEntry = join(dir, "hono.ts");
      writeFileSync(workerDepEntry, `import ${JSON.stringify(Bun.resolveSync("hono", REPO_ROOT))};\n`);

      expect((await buildInputs(ompEntry, [])).some((path) => path.includes(WORKER_LEAK))).toBe(true);
      expect((await buildInputs(workerDepEntry, [])).some((path) => RUNNER_LEAKS.some((leak) => path.includes(leak)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
