/**
 * The image rebuild gate's decision seam (`scripts/check-image-inputs.ts`).
 *
 * The git invocation is the CLI's, not this test's: what must hold is the
 * VERDICT — the declared path families fail without a marker change, nothing
 * else does, and a diff that changes the marker passes. The vocabulary is also
 * proved COMPLETE against the image: every `COPY <src>` in the Dockerfile must
 * be matched by a family, so a newly copied path cannot escape the gate.
 *
 * The vocabulary is hand-mirrored in prose (`AGENTS.md`, `docs/deploy.md`), so
 * the parity block below reads all three surfaces and fails when one drifts.
 * The Dockerfile path is NOT mirrored: the CLI reads it from `wrangler.jsonc`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  evaluateImageGate,
  IMAGE_INPUT_FAMILIES,
  IMAGE_INPUT_PATTERNS,
  readDockerfilePath,
  touchesImageInput,
  touchesRebuildMarker,
} from "./check-image-inputs";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Backticked repo paths on the BULLET lines of one prose slice — the documented
 * family list. Restricting to `- ` lines keeps a later prose sentence (which
 * names a concrete Dockerfile) out of the comparison.
 */
function documentedFamilies(text: string, startMarker: string, endMarker: string): string[] {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  expect(start, `marker "${startMarker}"`).toBeGreaterThan(-1);
  expect(end, `marker "${endMarker}"`).toBeGreaterThan(start);
  return text
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => [...line.matchAll(/`(packages\/[^`]+|sandbox-image\/[^`]+|\.dockerignore)`/g)].map((m) => m[1]!));
}

/**
 * The `COPY <src>…` sources of a Dockerfile. Multi-stage `COPY --from=` reads
 * from another image, not the build context, so it is not an input family.
 */
function copySources(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("COPY ") && !line.startsWith("COPY --from="))
    .flatMap((line) =>
      line
        .slice("COPY ".length)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, -1),
    );
}

describe("image input vocabulary parity", () => {
  test("AGENTS.md, docs/deploy.md and the gate declare the same families", () => {
    const agents = documentedFamilies(
      readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
      "Touch the `# rebuild:` marker block",
      "\nCheck before merging",
    );
    const deploy = documentedFamilies(
      readFileSync(join(REPO_ROOT, "docs", "deploy.md"), "utf8"),
      "The input path families it covers",
      "`scripts/check-image-inputs.test.ts` proves the list is complete",
    );
    const declared = [...IMAGE_INPUT_FAMILIES].sort();
    expect([...new Set(agents)].sort()).toEqual(declared);
    expect([...new Set(deploy)].sort()).toEqual(declared);
  });

  test("every COPY source in the Dockerfile is covered by an input family", () => {
    // The vocabulary is only complete if it covers what the image actually
    // copies in: a new `COPY` that no family matches would change the image
    // while the gate stayed silent. Families name paths INSIDE a directory
    // (`X/**`), so a `COPY <dir>` is covered by the family for its contents.
    const sources = copySources(readFileSync(join(REPO_ROOT, "sandbox-image", "Dockerfile"), "utf8"));
    expect(sources.length).toBeGreaterThan(0);
    const uncovered = sources.filter(
      (source) => !touchesImageInput([source]) && !touchesImageInput([`${source}/probe`]),
    );
    expect(uncovered).toEqual([]);
  });

  test("the CLI's Dockerfile path is the one wrangler.jsonc builds, and it exists", () => {
    const configured = readDockerfilePath(readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8"));
    expect(configured).toBe("sandbox-image/Dockerfile");
    // Both wrangler configs agree, so the gate never diffs a file a deploy ignores.
    expect(readDockerfilePath(readFileSync(join(REPO_ROOT, "wrangler.smoke.jsonc"), "utf8"))).toBe(configured);
    expect(readFileSync(join(REPO_ROOT, configured!), "utf8")).toContain("rebuild:");
  });

  test("a config without a container image answers undefined instead of a guessed path", () => {
    expect(readDockerfilePath("{}")).toBeUndefined();
    expect(readDockerfilePath("not json")).toBeUndefined();
    expect(readDockerfilePath('{"containers":[{"images":{}}]}')).toBeUndefined();
    // JSONC comments are stripped before the parse.
    expect(
      readDockerfilePath('{\n // the image\n "containers": [{"images": {"sandbox": {"dockerfile": "./a/Df"}}}]}'),
    ).toBe("a/Df");
  });
});

describe("image gate", () => {
  test("a runner source change without a marker change fails", () =>
    expect(evaluateImageGate(["packages/runner/src/index.ts"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("the same change with a rebuild marker diff passes", () =>
    expect(
      evaluateImageGate(["packages/runner/src/index.ts"], "+# rebuild: runner source change"),
    ).toEqual({ ok: true }));

  test("a docs-only change passes", () =>
    expect(evaluateImageGate(["docs/deploy.md"], "")).toEqual({ ok: true }));

  test("a sandbox-image shim change fails without the marker", () =>
    expect(evaluateImageGate(["sandbox-image/entry.sh"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("a verify-synthesis.sh change alone fails without the marker", () =>
    expect(evaluateImageGate(["packages/runner/verify-synthesis.sh"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("a Dockerfile change that does not touch the marker fails", () =>
    expect(evaluateImageGate(["sandbox-image/Dockerfile"], "-FROM old\n+FROM new")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));
});

describe("touchesImageInput", () => {
  const declared = [
    "packages/runner/src/pipeline/sandbox.ts",
    "packages/shared/src/credential-payload.ts",
    "packages/runner/package.json",
    "packages/runner/bun.lock",
    "packages/runner/verify-synthesis.sh",
    "sandbox-image/cli-global/package.json",
    ".dockerignore",
  ];

  test("matches each declared path family", () => {
    for (const path of declared) expect(touchesImageInput([path])).toBe(true);
    expect(IMAGE_INPUT_PATTERNS).toHaveLength(declared.length);
  });

  test("an untouched path list passes", () => {
    for (const path of [
      "docs/deploy.md",
      "src/index.ts",
      "packages/shared/bun.lock",
      "packages/runner/src-extra/index.ts",
      "packages/runner/tsconfig.json",
      "sandbox-image-notes.md",
    ]) {
      expect(touchesImageInput([path])).toBe(false);
    }
  });
});

describe("touchesRebuildMarker", () => {
  test("an added marker line counts", () =>
    expect(touchesRebuildMarker("+# rebuild: new runner source")).toBe(true));

  test("a removed marker line counts", () =>
    expect(touchesRebuildMarker("-# rebuild: stale note")).toBe(true));

  test("diff headers naming the file do not count", () =>
    expect(touchesRebuildMarker("--- a/sandbox-image/Dockerfile\n+++ b/sandbox-image/Dockerfile")).toBe(
      false,
    ));

  test("context lines and unrelated hunks do not count", () =>
    expect(touchesRebuildMarker(" # rebuild: context only\n+FROM new")).toBe(false));
});

/** A throwaway repo whose only commits are the ones this test writes. */
function tempRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "image-gate-"));
  const git = (...args: string[]): string => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  // Git's default; a global `core.quotePath=false` would otherwise hide the quoting.
  git("config", "core.quotePath", "true");
  // The CLI reads the Dockerfile path from this config, so every fixture needs
  // one — without it the run would fail on the missing config, not on the diff.
  write(
    dir,
    "wrangler.jsonc",
    '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }]\n}\n',
  );
  return { dir, git };
}

function write(dir: string, path: string, content = "export const x = 1;\n"): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** The gate's actual CLI, run against `dir` for `base...HEAD`. */
function runGate(dir: string, base: string, script: string): number {
  return Bun.spawnSync(["bun", script, "--base", base], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode!;
}

describe("image gate CLI", () => {
  const script = join(import.meta.dir, "check-image-inputs.ts");

  test("a rename out of an input family fails the gate", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "packages/runner/src/moved.ts");
      write(dir, "docs/notes.md", "notes\n");
      git("add", "-A");
      git("commit", "-qm", "add runner source");
      const base = git("rev-parse", "HEAD");

      git("mv", "packages/runner/src/moved.ts", "docs/moved.ts");
      git("commit", "-qm", "move it out of the image inputs");

      expect(runGate(dir, base, script)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed Dockerfile at the CONFIGURED path carries the marker and passes", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "sandbox-image/Dockerfile", "# rebuild: initial\nFROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "image");
      const base = git("rev-parse", "HEAD");

      write(dir, "sandbox-image/Dockerfile", "# rebuild: initial\n# rebuild: runner source changed\nFROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "marker");

      expect(runGate(dir, base, script)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-ASCII input path is matched despite Git quoting", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "docs/notes.md", "notes\n");
      git("add", "-A");
      git("commit", "-qm", "docs only");
      const base = git("rev-parse", "HEAD");

      write(dir, "packages/runner/src/中文.ts");
      git("add", "-A");
      git("commit", "-qm", "non-ASCII runner source");

      expect(runGate(dir, base, script)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
