/**
 * The `scripts/provider-catalog/` directory contract, checked against git.
 *
 * The README is the standard: a directory says who owns a file (`inputs/` = a
 * human or an external service writes it, `generated/` = a step rebuilds it,
 * `lib/` = pure functions, root = executable steps). Prose ages badly, so the
 * claims that decide behaviour are asserted here:
 *
 *   1. every tracked file in the directory is named in the README, and every
 *      file the README lists exists in git — the table cannot drift into
 *      describing a layout the repository does not have;
 *   2. nothing tracked there is gitignored (regenerable ≠ ignorable, because the
 *      Worker imports `generated/omp-provider-verify.json`), while a raw upstream
 *      response or a scratch copy WOULD be;
 *   3. the stored snapshot is the trimmed payload, never the upstream body.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const CATALOG_REL = "scripts/provider-catalog";
const CATALOG = join(REPO_ROOT, CATALOG_REL);
const README = readFileSync(join(CATALOG, "README.md"), "utf8");

/** Every tracked path under the directory, relative to the catalog root. */
function trackedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", CATALOG_REL], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  return proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => relative(CATALOG_REL, line));
}

function isIgnored(path: string): boolean {
  const proc = Bun.spawnSync(["git", "check-ignore", "-q", path], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

/** The first column of every data row — the file each row documents. */
function tablePaths(): string[] {
  return [...README.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!);
}

describe("provider-catalog directory contract", () => {
  const files = trackedFiles();

  test("every tracked file is named in the README", () => {
    for (const file of files) {
      expect(README, `${file} is tracked but the README does not name it`).toContain(file);
    }
  });

  test("the README's table is exactly `git ls-files` — no stale row, no undocumented file", () => {
    // Set equality, not one-way containment: this is what makes the table the
    // contract. A new file must gain a row, and a rename must move its row, in
    // the same commit that changes the layout.
    expect(tablePaths().sort()).toEqual(files.sort());
  });

  test("the layout is exactly the four documented owners", () => {
    expect(readdirSync(CATALOG).sort()).toEqual(
      [
        "README.md",
        "bump-pins.ts",
        "catalog-changes.ts",
        "extract-omp-snapshot.ts",
        "fetch-models-dev.ts",
        "generated",
        "inputs",
        "lib",
        "pr-verdict.ts",
      ].sort(),
    );
    for (const dir of ["inputs", "generated", "lib"]) {
      expect(statSync(join(CATALOG, dir)).isDirectory(), dir).toBe(true);
    }
  });

  test("inputs/ is the only writer-owned directory: one dated snapshot + overrides", () => {
    const inputs = readdirSync(join(CATALOG, "inputs")).sort();
    expect(inputs.filter((name) => /^models\.dev-\d{4}-\d{2}-\d{2}\.json$/.test(name))).toHaveLength(1);
    expect(inputs).toContain("overrides.json");
    // lib/ is pure: no JSON, no data of its own.
    expect(readdirSync(join(CATALOG, "lib")).every((name) => name.endsWith(".ts"))).toBe(true);
  });

  test("nothing tracked in the directory is gitignored (regenerable ≠ ignorable)", () => {
    for (const file of files) expect(isIgnored(`${CATALOG_REL}/${file}`), `${file} is tracked but ignored`).toBe(false);
  });

  test("the guard patterns catch a raw response and a scratch copy, and spare the tracked inputs", () => {
    // A raw `models.dev` body is ~6.7 MB and belongs in $RUNNER_TEMP.
    for (const raw of [`${CATALOG_REL}/inputs/raw-api.json`, `${CATALOG_REL}/inputs/api.json`]) {
      expect(isIgnored(raw), `${raw} would be committed`).toBe(true);
    }
    expect(isIgnored(`${CATALOG_REL}/bump-pins-scratch/bun.lock`)).toBe(true);
    for (const tracked of [`${CATALOG_REL}/inputs/overrides.json`, `${CATALOG_REL}/generated/omp-provider-verify.json`]) {
      expect(isIgnored(tracked), `${tracked} must stay tracked`).toBe(false);
    }
  });

  test("the stored snapshot is the trimmed payload, never the upstream body", () => {
    // Upstream providers carry `models` (id-keyed, ~6.7 MB), `npm`, `cost`,
    // `modalities` … The trimmed snapshot carries exactly the generator's fields;
    // a raw body copied in would blow past this bound and carry `models`.
    for (const name of readdirSync(join(CATALOG, "inputs")).filter((entry) => entry.startsWith("models.dev-"))) {
      const path = join(CATALOG, "inputs", name);
      expect(statSync(path).size, `${name} is the raw upstream body, not the trimmed snapshot`).toBeLessThan(
        2_000_000,
      );
      const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
      for (const [providerId, provider] of Object.entries(payload)) {
        expect(Object.keys(provider).sort(), providerId).toEqual([
          "api",
          "doc",
          "env",
          "id",
          "limits",
          "model_ids",
          "name",
        ]);
      }
    }
  });
});

describe("generated/ is disposable", () => {
  test("the extractor creates generated/ when it is missing", () => {
    // The README says `generated/` can be deleted and rebuilt. That claim broke
    // the moment the extractor started reading its own previous output to keep
    // the extraction date: with no directory it died on ENOENT. Asserted from
    // the source (the script reads the installed SDK, so it cannot run in a
    // unit test) plus the reproduction step in the PR body.
    const source = readFileSync(join(CATALOG, "extract-omp-snapshot.ts"), "utf8");
    expect(source).toContain("mkdir(GENERATED_DIR, { recursive: true })");
    expect(source.indexOf("mkdir(GENERATED_DIR")).toBeLessThan(source.indexOf("writeFile("));
    // And nothing in lib/ writes: a pure module that wrote would make `lib/`
    // just another output directory.
    for (const name of readdirSync(join(CATALOG, "lib"))) {
      const text = readFileSync(join(CATALOG, "lib", name), "utf8");
      expect(text, name).not.toMatch(/from "node:fs/);
      expect(text, name).not.toMatch(/writeFile|mkdir/);
    }
  });
});
