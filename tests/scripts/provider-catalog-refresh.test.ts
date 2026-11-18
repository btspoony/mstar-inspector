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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertModelsDev, refresh, renderSnapshot } from "../../scripts/provider-catalog/fetch-models-dev";
import { catalogRemovals, renderRemovals } from "../../scripts/provider-catalog/catalog-changes";
import { planEdits } from "../../scripts/provider-catalog/bump-pins";
import { failCount, passCount, verdict } from "../../scripts/provider-catalog/pr-verdict";
import { pickNewestSnapshot } from "../../scripts/provider-catalog/lib/snapshot";

const REPO_ROOT = join(import.meta.dir, "../..");
/** The committed harness ref (the Dockerfile anchor carries it verbatim). */
const REPO_HARNESS_REF = /harnessRef: "([0-9a-f]{40})"/.exec(
  readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8"),
)![1]!;

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
  test("the newest ISO-dated file wins and its date is returned", () => {
    // Pure: the names are the argument, so this needs no directory at all.
    expect(
      pickNewestSnapshot([
        "models.dev-2026-01-09.json",
        "models.dev-2026-01-10.json",
        "models.dev-2026-01-31.json",
        "overrides.json",
      ]),
    ).toEqual({ file: "models.dev-2026-01-31.json", date: "2026-01-31" });
  });

  test("no snapshot fails loudly instead of yielding an empty catalog", () => {
    expect(() => pickNewestSnapshot([])).toThrow(/no models\.dev snapshot/);
    expect(() => pickNewestSnapshot(["overrides.json"])).toThrow(/no models\.dev snapshot/);
  });

  test("the repo's committed snapshot is the one the generator reads", () => {
    // Regenerating against unchanged upstream data must produce no diff, which
    // holds only while the generator resolves the same file this does.
    const committed = pickNewestSnapshot(readdirSync(join(REPO_ROOT, "scripts/provider-catalog/inputs")));
    const generated = readFileSync(join(REPO_ROOT, "src/contracts/provider-catalog.generated.ts"), "utf8");
    expect(generated).toContain(`scripts/provider-catalog/inputs/${committed.file}`);
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

describe("PR verdict (the publication gate)", () => {
  const GREEN_LOG = " 5679 pass\n 0 fail\nRan 5679 tests across 235 files.\n";
  const RED_LOG = " 5600 pass\n 79 fail\nRan 5679 tests across 235 files.\n";

  test("both green checks allow publication", () => {
    const result = verdict("success", "success", GREEN_LOG);
    expect(result.green).toBe(true);
    expect(result.reason).toContain("5679");
  });

  test("a failing typecheck refuses publication", () => {
    expect(verdict("failure", "success", GREEN_LOG)).toMatchObject({ green: false });
    expect(verdict("failure", "success", GREEN_LOG).reason).toContain("typecheck");
  });

  test("a failing test step refuses publication", () => {
    expect(verdict("success", "failure", RED_LOG).green).toBe(false);
  });

  test("a green STEP outcome over a log recording failures still refuses", () => {
    // Round 1's bug: `bun test | tee` reports tee's 0, so the step says success
    // while the log says 79 fail. The log is the second witness; a red run must
    // publish nothing.
    const result = verdict("success", "success", RED_LOG);
    expect(result.green).toBe(false);
    expect(result.reason).toContain("79");
  });

  test("an empty log cannot claim green when the outcome is red", () => {
    expect(verdict("success", "failure", "").green).toBe(false);
  });

  test("counts come from the log's own summary lines", () => {
    expect(passCount(GREEN_LOG)).toBe("5679");
    expect(passCount("")).toBe("unknown");
    expect(failCount(RED_LOG)).toBe(79);
    expect(failCount(GREEN_LOG)).toBe(0);
    expect(failCount("")).toBe(0);
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

  test("every lock beside a bumped manifest really is rewritten by the run", () => {
    // Behaviour, not source text (round 2, TEST-03). A scratch repo pins BOTH
    // packages to packed stubs, so the bump — and its install — resolves
    // entirely offline. The engine 4.7.3 → 4.8.0 move is what forces three
    // locks to move: root, runner, and the CLI's. A lock the run forgot still
    // names the old version, which is what this reads.
    const root = mkdtempSync(join(tmpdir(), "bump-locks-"));
    try {
      const write = (rel: string, content: string): void => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), content);
      };
      // One tarball per (package, version): a shared filename would let a later
      // pack overwrite an earlier release, and the lock would then name the
      // wrong package — exactly the kind of silence this test exists to catch.
      const pack = (name: string, version: string): string => {
        const slug = `${name.replace(/[^a-z0-9]+/gi, "-")}-${version}`;
        const build = join(root, `build-${slug}`, "package");
        mkdirSync(build, { recursive: true });
        writeFileSync(join(build, "package.json"), JSON.stringify({ name, version }));
        const tarball = join(root, `stub-${slug}.tgz`);
        expect(
          Bun.spawnSync(["tar", "czf", tarball, "-C", join(root, `build-${slug}`), "package"], {
            stdout: "pipe",
            stderr: "pipe",
          }).exitCode,
        ).toBe(0);
        return tarball;
      };
      const ompStub = pack("@oh-my-pi/pi-coding-agent", "18.22.1");
      const engineStub = pack("@mstar-harness/engine", "4.8.0");
      const overrides = {
        "@oh-my-pi/pi-coding-agent": `file:${ompStub}`,
        "@mstar-harness/engine": `file:${engineStub}`,
      };
      // The root keeps a caret range on the engine, the runner pins exactly —
      // the shape the real manifests have.
      const manifest = (name: string, engineRange: string): string =>
        `${JSON.stringify({
          name,
          private: true,
          dependencies: { "@oh-my-pi/pi-coding-agent": "18.22.1", "@mstar-harness/engine": engineRange },
          overrides,
        }, null, 2)}\n`;
      write("package.json", manifest("bump-locks-fixture", "^4.7.3"));
      write("packages/runner/package.json", manifest("bump-locks-runner", "4.7.3"));
      // The CLI's own lock resolves to a stub at the version the engine names.
      write("sandbox-image/cli-global/package.json", `${JSON.stringify({
        dependencies: { "@mstar-harness/cli": "4.7.3" },
        overrides: { "@mstar-harness/cli": `file:${pack("@mstar-harness/cli", "4.8.0")}` },
      }, null, 2)}\n`);
      write(
        "src/contracts/sandbox-images.ts",
        `export const HARNESS_VERSION = "4.7.3";\nexport const P = { harnessRef: "${REPO_HARNESS_REF}" };\n`,
      );
      write(
        "sandbox-image/Dockerfile",
        `# mstar-harness plugin, pinned ref ${REPO_HARNESS_REF} (tag v4.7.3, bumped 2026-11-18).\n` +
          `RUN git -C /opt/mstar-harness fetch --depth 1 origin ${REPO_HARNESS_REF}\n`,
      );
      write("scripts/provider-catalog/bump-pins.ts", readFileSync(join(REPO_ROOT, "scripts/provider-catalog/bump-pins.ts"), "utf8"));

      const proc = Bun.spawnSync(["bun", "run", "scripts/provider-catalog/bump-pins.ts", "--engine", "4.8.0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);

      // All three locks moved with the pin. Bun records a `file:` override by
      // path in `packages`, so the version is asserted where the lock states it:
      // the workspace's declared range, which is what a frozen install checks.
      for (const [lock, name, declared] of [
        ["bun.lock", "@mstar-harness/engine", "^4.8.0"],
        ["packages/runner/bun.lock", "@mstar-harness/engine", "4.8.0"],
        ["sandbox-image/cli-global/bun.lock", "@mstar-harness/cli", "4.8.0"],
      ] as const) {
        const text = readFileSync(join(root, lock), "utf8");
        expect(text, lock).toContain(`"${name}": "${declared}"`);
        expect(text, lock).not.toContain(`"${name}": "${declared.replace("4.8.0", "4.7.3")}"`);
      }
      // And the installed tree proves the install ran.
      const installed = JSON.parse(
        readFileSync(join(root, "node_modules/@mstar-harness/engine/package.json"), "utf8"),
      ) as { version: string };
      expect(installed.version).toBe("4.8.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every planned literal really is in the committed file", () => {
    // Guards the anchors: a surface that drifts makes the workflow's bump step
    // fail at 04:17 with no PR instead of silently bumping half the pins.
    for (const edit of planEdits(from, { omp: "18.23.0", engine: "4.8.0", harnessRef: "b".repeat(40) })) {
      expect(readFileSync(join(REPO_ROOT, edit.file), "utf8"), edit.file).toContain(edit.from);
    }
  });
});
