/**
 * Provider-catalog refresh: the fetch/conversion contract, the pin-bump plan,
 * the removals report, and one regenerated-output determinism check.
 *
 * The nightly workflow (`.github/workflows/refresh-catalog.yml`) is the only
 * place these run unattended, so each rule it relies on is locked here: a
 * malformed upstream body must never replace the committed snapshot, an
 * unchanged body must never rewrite it, and the PR body must name what
 * disappeared.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertModelsDev, refresh, renderSnapshot } from "../../scripts/provider-catalog/fetch-models-dev";
import { catalogRemovals, renderRemovals } from "../../scripts/provider-catalog/catalog-changes";
import { planEdits } from "../../scripts/provider-catalog/bump-pins";
import { newestSnapshot } from "../../scripts/provider-catalog/snapshot";

const REPO_ROOT = join(import.meta.dir, "../..");

/** An upstream body in models.dev's real shape: `models` keyed by model id,
 *  sizes in each record's `limit`. */
const UPSTREAM = {
  zeta: {
    id: "zeta",
    name: "Zeta",
    env: ["ZETA_API_KEY"],
    api: "https://api.zeta.example/v1",
    doc: "https://zeta.example/docs",
    models: {
      // Deliberately unsorted: the snapshot vocabulary is sorted, not copied.
      "zeta-large": { id: "zeta-large", limit: { context: 200000, output: 64000 } },
      "zeta-small": { id: "zeta-small", limit: { context: 8000, output: 2000, input: 8000 } },
      // Upstream really ships 0-output models (audio, embeddings): no sizes.
      "zeta-audio": { id: "zeta-audio", limit: { context: 8192, output: 0 } },
      "zeta-unsized": { id: "zeta-unsized" },
    },
  },
  alpha: {
    id: "alpha",
    name: "Alpha",
    env: [],
    api: null,
    models: { "alpha-one": { limit: { context: 1000, output: 100 } } },
  },
};

/** A throwaway catalog directory. `test(fn)` and `test(name, fn)` both take it
 *  as `bun:test`'s first/second argument, so the body receives the path. */
function withTempDir(run: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-refresh-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("models.dev conversion", () => {
  test("an id-keyed `models` object becomes a sorted model_ids list plus mapped limits", () => {
    const snapshot = convertModelsDev(UPSTREAM);
    expect(snapshot.zeta).toEqual({
      id: "zeta",
      name: "Zeta",
      env: ["ZETA_API_KEY"],
      api: "https://api.zeta.example/v1",
      doc: "https://zeta.example/docs",
      model_ids: ["zeta-audio", "zeta-large", "zeta-small", "zeta-unsized"],
      // `input` is not a field the generator consumes and does not survive;
      // the unusable halves (0 output) and the absent row stay unsized.
      limits: {
        "zeta-large": { context: 200000, output: 64000 },
        "zeta-small": { context: 8000, output: 2000 },
      },
    });
    // The absent `doc` is stated as null, never omitted (the generator reads it).
    expect(snapshot.alpha).toEqual({
      id: "alpha",
      name: "Alpha",
      env: [],
      api: null,
      doc: null,
      model_ids: ["alpha-one"],
      limits: { "alpha-one": { context: 1000, output: 100 } },
    });
  });

  test("rendering is byte-stable and sorts provider keys", () => {
    const rendered = renderSnapshot(convertModelsDev(UPSTREAM));
    expect(rendered.startsWith('{"alpha":')).toBe(true);
    expect(rendered.endsWith("}\n")).toBe(true);
    // A second conversion of a re-ordered body renders the SAME bytes: nothing
    // machine-, clock- or input-order-dependent enters the payload.
    const reordered = { alpha: UPSTREAM.alpha, zeta: UPSTREAM.zeta };
    expect(renderSnapshot(convertModelsDev(reordered))).toBe(rendered);
  });

  test("a malformed body is rejected instead of written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-refresh-malformed-"));
    try {
      const committed = `${JSON.stringify({ keep: { id: "keep" } })}\n`;
      writeFileSync(join(dir, "models.dev-2026-01-01.json"), committed);
      const bad: unknown[] = [
        [], // not a map
        {}, // empty map
        { zeta: { name: "Zeta" } }, // no models
        { zeta: { name: "Zeta", models: ["zeta-large"] } }, // array, not an id-keyed map
        { zeta: { name: "", models: { a: {} } } }, // no name
      ];
      for (const body of bad) {
        await expect(refresh(dir, body, "2026-02-02")).rejects.toThrow();
      }
      // Nothing was written and nothing was pruned.
      expect(readdirSync(dir)).toEqual(["models.dev-2026-01-01.json"]);
      expect(readFileSync(join(dir, "models.dev-2026-01-01.json"), "utf8")).toBe(committed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unchanged data keeps the committed file and its date (no write, no prune)", withTempDir(async (dir) => {
    const payload = renderSnapshot(convertModelsDev(UPSTREAM));
    writeFileSync(join(dir, "models.dev-2026-01-01.json"), payload);
    const result = await refresh(dir, UPSTREAM, "2026-03-04");
    expect(result).toMatchObject({ changed: false, pruned: 0 });
    expect(result.file.endsWith("models.dev-2026-01-01.json")).toBe(true);
    expect(readdirSync(dir)).toEqual(["models.dev-2026-01-01.json"]);
  }));

  test("changed data lands as the fetch date and prunes every older snapshot", withTempDir(async (dir) => {
    writeFileSync(join(dir, "models.dev-2026-01-01.json"), "{}\n");
    writeFileSync(join(dir, "models.dev-2026-02-01.json"), "{}\n");
    writeFileSync(join(dir, "omp-api-key-providers.json"), "{}\n");
    const result = await refresh(dir, UPSTREAM, "2026-03-04");
    expect(result).toMatchObject({ changed: true, pruned: 2 });
    // Exactly one dated snapshot survives; the other vendored files are untouched.
    expect(readdirSync(dir).sort()).toEqual(["models.dev-2026-03-04.json", "omp-api-key-providers.json"]);
  }));
});

describe("snapshot discovery", () => {
  test("the newest ISO-dated file wins and its date is returned", withTempDir((dir) => {
    writeFileSync(join(dir, "models.dev-2026-01-09.json"), "{}");
    writeFileSync(join(dir, "models.dev-2026-01-10.json"), "{}");
    writeFileSync(join(dir, "models.dev-2026-01-31.json"), "{}");
    writeFileSync(join(dir, "overrides.json"), "{}");
    expect(newestSnapshot(dir)).toEqual({ file: "models.dev-2026-01-31.json", date: "2026-01-31" });
  }));

  test("no snapshot fails loudly instead of yielding an empty catalog", withTempDir((dir) => {
    expect(() => newestSnapshot(dir)).toThrow(/no models\.dev snapshot/);
  }));

  test("the repo's committed snapshot is the one the generator reads", () => {
    // Regenerating against unchanged upstream data must produce no diff, which
    // holds only while the generator resolves the same file this does.
    const committed = newestSnapshot(join(REPO_ROOT, "scripts/provider-catalog"));
    const generated = readFileSync(join(REPO_ROOT, "src/contracts/provider-catalog.generated.ts"), "utf8");
    expect(generated).toContain(`scripts/provider-catalog/${committed.file}`);
    const limits = readFileSync(join(REPO_ROOT, "src/contracts/provider-model-limits.generated.ts"), "utf8");
    expect(limits).toContain(`export const MODEL_LIMITS_SNAPSHOT = "${committed.date}"`);
  });
});

describe("catalog removals report", () => {
  const before = {
    kept: { models: ["a", "b"] },
    shrunk: { models: ["x", "y"], protocols: [{ models: ["z"] }] },
    dropped: { models: ["only"] },
  };

  test("lists removed model ids per surviving provider and dropped providers", () => {
    const after = { kept: { models: ["a", "b"] }, shrunk: { models: ["x"], protocols: [{ models: ["z"] }] } };
    expect(catalogRemovals(before, after)).toEqual({
      providersDropped: ["dropped"],
      // A protocol's vocabulary counts too — `y` lived in the row's own list.
      modelsRemoved: { shrunk: ["y"] },
    });
  });

  test("a protocol-only removal is caught (a chain can name a secondary protocol's model)", () => {
    const after = { ...before, shrunk: { models: ["x", "y"], protocols: [{ models: [] }] } };
    expect(catalogRemovals(before, after).modelsRemoved).toEqual({ shrunk: ["z"] });
  });

  test("nothing removed renders one explicit clean line, never an empty section", () => {
    const text = renderRemovals({ providersDropped: [], modelsRemoved: {} });
    expect(text).toContain("No provider and no model id was removed");
    const dirty = renderRemovals({ providersDropped: ["gone"], modelsRemoved: { p: ["m"] } });
    expect(dirty).toContain("`gone`");
    expect(dirty).toContain("`p`: `m`");
  });
});

describe("pin bump plan", () => {
  const from = {
    omp: "18.22.2",
    engine: "^4.7.3",
    harness: "4.7.3",
    harnessRef: "30e6c0844db11583ec5e92d7b03fb0c2c1ec72f0",
    bumped: "2026-11-18",
  };

  test("a moved engine rewrites every surface that carries it, CLI lock included", () => {
    const edits = planEdits(from, { engine: "4.8.0", harnessRef: "a".repeat(40) }, "2026-12-01");
    const files = new Set(edits.map((edit) => edit.file));
    expect([...files].sort()).toEqual([
      "package.json",
      "packages/runner/package.json",
      "sandbox-image/Dockerfile",
      "sandbox-image/cli-global/package.json",
      "src/contracts/sandbox-images.ts",
    ]);
    // The root manifest keeps its caret range; the runner's stays exact.
    expect(edits).toContainEqual({
      file: "package.json",
      from: '"@mstar-harness/engine": "^4.7.3"',
      to: '"@mstar-harness/engine": "^4.8.0"',
    });
    expect(edits).toContainEqual({
      file: "packages/runner/package.json",
      from: '"@mstar-harness/engine": "4.7.3"',
      to: '"@mstar-harness/engine": "4.8.0"',
    });
    // The anchor comment names ref, tag AND the day it moved (both are pinned
    // by tests/contracts/sandbox-images.test.ts).
    expect(edits).toContainEqual({
      file: "sandbox-image/Dockerfile",
      from: `# mstar-harness plugin, pinned ref ${from.harnessRef} (tag v4.7.3, bumped ${from.bumped})`,
      to: `# mstar-harness plugin, pinned ref ${"a".repeat(40)} (tag v4.8.0, bumped 2026-12-01)`,
    });
  });

  test("the same versions plan no edit at all (the workflow's no-op path)", () => {
    expect(planEdits(from, { omp: from.omp, engine: "4.7.3" })).toEqual([]);
  });

  test("every planned literal really is in the committed file", () => {
    // Guards the anchors: a surface that drifts makes the workflow's bump step
    // fail at 04:17 with no PR instead of silently bumping half the pins.
    for (const edit of planEdits(from, { omp: "18.23.0", engine: "4.8.0", harnessRef: "b".repeat(40) })) {
      expect(readFileSync(join(REPO_ROOT, edit.file), "utf8"), edit.file).toContain(edit.from);
    }
  });
});
