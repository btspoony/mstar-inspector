import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKER_ENTRY = join(REPO_ROOT, "src", "worker", "entry.ts");
const RUNNER_ENTRY = join(REPO_ROOT, "packages", "runner", "src", "runner.ts");

async function buildInputs(entry: string, external: string[]): Promise<string[]> {
  const outdir = mkdtempSync(join(tmpdir(), "bundle-boundary-"));
  try {
    const opts = { entrypoints: [entry], target: "bun" as const, external, outdir, metafile: true, throw: false };
    let result = await Bun.build(opts);
    if (!result.success) result = await Bun.build(opts);
    expect(result.success).toBe(true);
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    return inputs;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const WORKER_LEAK = "node_modules/@oh-my-pi/";
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
