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
  changedFamilies,
  containerSignature,
  evaluateImageGate,
  familyPattern,
  imageRebuildInstruction,
  IMAGE_INPUT_FAMILIES,
  readDockerfilePaths,
  resolveBase,
  touchesImageInput,
  touchesRebuildMarker,
} from "./check-image-inputs";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Backticked tokens on the BULLET lines of one prose slice — the documented
 * family list. Any backticked token counts, not a fixed prefix set: a new
 * family outside `packages/`, `sandbox-image/` or a root dotfile must not drift
 * in prose while the gate stays silent. Restricting to `- ` lines keeps a later
 * prose sentence (which names a concrete Dockerfile) out of the comparison.
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
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
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

  test("the printed instruction is the AGENTS.md section, not a copy of it", () => {
    const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
    // Independent boundaries: a hand copy that drifts, or a generator that
    // slices only a fragment of the section, misses this exact string.
    const quoted = agents
      .slice(
        agents.indexOf("The review container is built from"),
        agents.indexOf("\nCheck before merging"),
      )
      .trimEnd();
    expect(imageRebuildInstruction()).toBe(quoted);
    // The fact the retired hand copy had lost: the doc names the Dockerfile.
    expect(imageRebuildInstruction()).toContain("sandbox-image/Dockerfile");
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

  test("the CLI's Dockerfile paths are the ones wrangler.jsonc builds, and they exist", () => {
    // Both blocks declare the same file here, so the gate diffs it once — but
    // it is derived from the config, never hardcoded.
    const configured = readDockerfilePaths(readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8"));
    expect(configured).toEqual(["sandbox-image/Dockerfile"]);
    // Both wrangler configs agree, so the gate never diffs a file a deploy ignores.
    expect(readDockerfilePaths(readFileSync(join(REPO_ROOT, "wrangler.smoke.jsonc"), "utf8"))).toEqual(
      configured,
    );
    expect(readFileSync(join(REPO_ROOT, configured[0]!), "utf8")).toContain("rebuild:");
  });

  test("a config without a container image answers no paths instead of a guessed one", () => {
    expect(readDockerfilePaths("{}")).toEqual([]);
    expect(readDockerfilePaths("not json")).toEqual([]);
    expect(readDockerfilePaths('{"containers":[{"images":{}}]}')).toEqual([]);
    // JSONC comments are stripped before the parse.
    expect(
      readDockerfilePaths('{\n // the image\n "containers": [{"images": {"sandbox": {"dockerfile": "./a/Df"}}}]}'),
    ).toEqual(["a/Df"]);
    // A named environment does not inherit `containers` (wrangler), so
    // `env.production` declares its own Dockerfile path — the gate must read it.
    expect(
      readDockerfilePaths(
        '{"env":{"production":{"containers":[{"images":{"sandbox":{"dockerfile":"./prod/Df"}}}]}}}',
      ),
    ).toEqual(["prod/Df"]);
    expect(
      readDockerfilePaths(
        '{"containers":[{"images":{"sandbox":{"dockerfile":"./stage/Df"}}}],' +
          '"env":{"production":{"containers":[{"images":{"sandbox":{"dockerfile":"./prod/Df"}}}]}}}',
      ),
    ).toEqual(["stage/Df", "prod/Df"]);
  });
});

describe("image gate", () => {
  test("a runner source change without a marker change fails", () =>
    expect(evaluateImageGate(["packages/runner/src/index.ts"], "", false)).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["packages/runner/src/**"],
    }));

  test("the same change with a rebuild marker diff passes", () =>
    expect(
      evaluateImageGate(["packages/runner/src/index.ts"], "+# rebuild: runner source change", false),
    ).toEqual({ ok: true }));

  test("a docs-only change passes", () =>
    expect(evaluateImageGate(["docs/deploy.md"], "", false)).toEqual({ ok: true }));

  test("a sandbox-image shim change fails without the marker", () =>
    expect(evaluateImageGate(["sandbox-image/entry.sh"], "", false)).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["sandbox-image/**"],
    }));

  test("a verify-synthesis.sh change alone fails without the marker", () =>
    expect(evaluateImageGate(["packages/runner/verify-synthesis.sh"], "", false)).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["packages/runner/verify-synthesis.sh"],
    }));

  test("a Dockerfile change that does not touch the marker fails", () =>
    expect(evaluateImageGate(["sandbox-image/Dockerfile"], "-FROM old\n+FROM new", false)).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["sandbox-image/**"],
    }));

  test("the verdict names only the families the diff touches", () =>
    // The whole vocabulary printed for every failure tells an operator nothing
    // about which input moved; the verdict carries the diff-derived subset.
    expect(
      evaluateImageGate(
        ["packages/runner/src/pipeline/sandbox.ts", ".dockerignore", "docs/deploy.md"],
        "",
        false,
      ),
    ).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["packages/runner/src/**", ".dockerignore"],
    }));

  test("a container-block change alone fails without the marker", () =>
    // No copied path changed, but the image a deploy builds did.
    expect(evaluateImageGate([], "", true)).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["wrangler.jsonc containers block"],
    }));

  test("a config path override names that file's container block", () =>
    expect(evaluateImageGate([], "", true, "wrangler.staging.jsonc")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
      families: ["wrangler.staging.jsonc containers block"],
    }));

  test("a container-block change with the marker passes", () =>
    expect(evaluateImageGate([], "+# rebuild: build context repointed", true)).toEqual({ ok: true }));

  test("an unrelated wrangler.jsonc edit needs no marker", () =>
    // `wrangler.jsonc` is not a family: a vars-only change cannot move the image.
    expect(evaluateImageGate(["wrangler.jsonc"], "", false)).toEqual({ ok: true }));
});

describe("containerSignature", () => {
  const BLOCK =
    '{ "name": "c", "scheduling_policy": "durable_object", "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile", "build_context": "." } } }';
  const config = (container: string, extra = "") => `{\n${extra}  "containers": [${container}]\n}\n`;

  test("an edit outside the container block leaves the signature unchanged", () => {
    const base = config(BLOCK, '  "vars": { "DEPLOYMENT_MODE": "saas" },\n');
    const head = config(BLOCK, '  // deploy shape\n  "vars": { "DEPLOYMENT_MODE": "self-hosted" },\n  "keep_vars": true,\n');
    const baseSignature = containerSignature(base);
    expect(baseSignature).toBeDefined();
    // A JSONC comment is not a value either.
    expect(containerSignature(head)).toBe(baseSignature);
  });

  test("a dockerfile, build_context, image entry or container name change is a change", () => {
    const baseSignature = containerSignature(config(BLOCK));
    expect(baseSignature).toBeDefined();
    for (const changed of [
      BLOCK.replace('"./sandbox-image/Dockerfile"', '"./sandbox-image/Other.Dockerfile"'),
      BLOCK.replace('"build_context": "."', '"build_context": "./sandbox-image"'),
      BLOCK.replace('"sandbox":', '"sandbox-v2":'),
      BLOCK.replace('"name": "c"', '"name": "c2"'),
    ]) {
      expect(containerSignature(config(changed)), changed).not.toBe(baseSignature);
    }
  });

  test("a config without containers is an empty block; an unreadable one is undefined", () => {
    expect(containerSignature('{ "vars": {} }')).toBe(containerSignature("{}"));
    expect(containerSignature("not json")).toBeUndefined();
    expect(containerSignature('{"containers": "no"}')).toBeUndefined();
  });

  test("the env.production container block counts, not just the top level", () => {
    // A named environment does not inherit `containers`, so a prod deploy
    // builds from its own block: every image-deciding edit there is a change.
    const production = (container: string) =>
      `{\n  "env": { "production": { "containers": [${container}] } }\n}\n`;
    const baseSignature = containerSignature(production(BLOCK));
    expect(baseSignature).toBeDefined();
    expect(containerSignature("{}")).not.toBe(baseSignature);
    for (const changed of [
      BLOCK.replace('"./sandbox-image/Dockerfile"', '"./sandbox-image/Other.Dockerfile"'),
      BLOCK.replace('"build_context": "."', '"build_context": "./sandbox-image"'),
      BLOCK.replace('"sandbox":', '"sandbox-v2":'),
      BLOCK.replace('"name": "c"', '"name": "c2"'),
    ]) {
      expect(containerSignature(production(changed)), changed).not.toBe(baseSignature);
    }
    // A production vars-only edit is not an image change.
    expect(
      containerSignature(
        `{\n  "env": { "production": { "vars": { "DEPLOYMENT_MODE": "saas" }, "containers": [${BLOCK}] } }\n}\n`,
      ),
    ).toBe(baseSignature);
    // A production block that is not an array fails closed like a top-level one.
    expect(containerSignature('{"env": {"production": {"containers": "no"}}}')).toBeUndefined();
  });
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
    // Each family answers on a path it derives from itself, and answers with
    // only itself — so a pattern that stops matching, or a new family, fails
    // here even though the array length never moved.
    for (const family of IMAGE_INPUT_FAMILIES) {
      expect(changedFamilies([family.replace("**", "sample")]), family).toEqual([family]);
    }
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

  test("a single `*` stays inside one path segment", () => {
    // `sandbox-image/*.sh` is one level only: the shell helpers the Dockerfile
    // copies live there, while a nested script (or the repo root) is not a
    // member of that family.
    const family = familyPattern("sandbox-image/*.sh");
    expect(family.test("sandbox-image/entry.sh")).toBe(true);
    expect(family.test("sandbox-image/verify-cli-lock.sh")).toBe(true);
    expect(family.test("sandbox-image/nested/entry.sh")).toBe(false);
    expect(family.test("entry.sh")).toBe(false);
    // `?` is one character, never the regex optional-quantifier it reads as.
    const single = familyPattern("sandbox-image/?.sh");
    expect(single.test("sandbox-image/a.sh")).toBe(true);
    expect(single.test("sandbox-image/.sh")).toBe(false);
    expect(single.test("sandbox-image/ab.sh")).toBe(false);
  });
});

describe("touchesRebuildMarker", () => {
  test("an added marker line counts", () =>
    expect(touchesRebuildMarker("+# rebuild: new runner source")).toBe(true));

  test("a removed marker line counts", () =>
    expect(touchesRebuildMarker("-# rebuild: stale note")).toBe(true));

  test("an indented comment marker still counts", () =>
    expect(touchesRebuildMarker("+  # rebuild: indented marker")).toBe(true));

  test("a comment marker with no space after the hash counts", () =>
    expect(touchesRebuildMarker("-#rebuild: tight marker")).toBe(true));

  test("prose that merely mentions the marker does not count", () =>
    expect(touchesRebuildMarker("+# the rebuild: note moved to AGENTS.md")).toBe(false));

  test("an instruction line echoing the marker text does not count", () =>
    expect(touchesRebuildMarker('+RUN echo "rebuild: stale image" > /tmp/note')).toBe(false));

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
function runGate(
  dir: string,
  base: string,
  script: string,
  ...extra: string[]
): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", script, "--base", base, ...extra], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode!, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("resolveBase", () => {
  const BASE = "a".repeat(40);
  const HEAD = "c".repeat(40);

  test("a reachable base is used as-is, with no fallback attempted", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "cat-file") return "";
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      if (args[0] === "merge-base") return undefined;
      return undefined;
    };
    expect(resolveBase(BASE, "main", run)).toEqual({ sha: BASE });
    // The descendant guard is the only extra question: nothing is fetched and
    // no merge base is sought.
    expect(calls.some(([command]) => command === "fetch")).toBe(false);
    expect(calls.some(([command, sub]) => command === "merge-base" && sub !== "--is-ancestor")).toBe(
      false,
    );
  });

  test("an unreachable push base is fetched from origin and still evaluated", () => {
    let fetched = false;
    const run = (args: string[]) => {
      if (args[0] === "fetch") {
        fetched = true;
        return "";
      }
      if (args[0] === "cat-file") return fetched ? "" : undefined;
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      return undefined;
    };
    expect(resolveBase(BASE, "main", run)).toEqual({ sha: BASE, recovered: "fetched" });
  });

  test("a local base at or ahead of HEAD is not a base: it would diff an empty range", () => {
    const behind = "b".repeat(40);
    const run = (args: string[]) => {
      if (args[0] === "cat-file") return "";
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      // HEAD is an ancestor of the requested commit: a backwards force-push.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return args[3] === BASE ? "" : undefined;
      }
      if (args[0] === "merge-base") return `${behind}\n`;
      return undefined;
    };
    expect(resolveBase(BASE, "main", run)).toEqual({ sha: behind, recovered: "merge-base" });
  });

  test("a fetched base ahead of HEAD is refused too, not passed as an empty diff", () => {
    let fetched = false;
    const run = (args: string[]) => {
      if (args[0] === "fetch") {
        fetched = true;
        return "";
      }
      if (args[0] === "cat-file") return fetched ? "" : undefined;
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      // HEAD is an ancestor of the fetched commit: a backwards force-push.
      if (args[0] === "merge-base") return "";
      return undefined;
    };
    const resolved = resolveBase(BASE, undefined, run);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain(BASE);
      expect(resolved.error).toContain("not behind HEAD");
    }
  });

  test("an unreachable base recovers to the merge base with the target branch", () => {
    const mergeBase = "b".repeat(40);
    const run = (args: string[]) => {
      if (args[0] === "cat-file") return undefined;
      // HEAD is not an ancestor of the merge base: the base lies behind HEAD.
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") return undefined;
      if (args[0] === "merge-base") return `${mergeBase}\n`;
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      return undefined;
    };
    expect(resolveBase(BASE, "main", run)).toEqual({ sha: mergeBase, recovered: "merge-base" });
  });

  test("a merge base equal to HEAD is not a base: it would diff an empty range", () => {
    const run = (args: string[]) => {
      if (args[0] === "cat-file") return undefined;
      if (args[0] === "merge-base") return `${HEAD}\n`;
      if (args[0] === "rev-parse") return `${HEAD}\n`;
      return undefined;
    };
    const resolved = resolveBase(BASE, "main", run);
    expect("error" in resolved).toBe(true);
  });

  test("no base at all fails closed and names the unreachable commit", () => {
    const resolved = resolveBase(BASE, undefined, () => undefined);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain(BASE);
      expect(resolved.error).toContain("not reachable");
    }
  });
});

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

      expect(runGate(dir, base, script).code).toBe(1);
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

      expect(runGate(dir, base, script).code).toBe(0);
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

      expect(runGate(dir, base, script).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrangler.jsonc edit outside the container block needs no marker", () => {
    const { dir, git } = tempRepo();
    try {
      git("add", "-A");
      git("commit", "-qm", "config");
      const base = git("rev-parse", "HEAD");

      // The container block is byte-for-byte the same; only deploy settings moved.
      write(
        dir,
        "wrangler.jsonc",
        '{\n  "vars": { "DEPLOYMENT_MODE": "saas" },\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }]\n}\n',
      );
      git("add", "-A");
      git("commit", "-qm", "vars only");

      expect(runGate(dir, base, script).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a build_context repoint fails without the marker, and passes with it", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "sandbox-image/Dockerfile", "# rebuild: initial\nFROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "config + image");
      const base = git("rev-parse", "HEAD");

      const repointed =
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile", "build_context": "." } } }]\n}\n';
      write(dir, "wrangler.jsonc", repointed);
      git("add", "-A");
      git("commit", "-qm", "repoint the build context");
      expect(runGate(dir, base, script).code).toBe(1);

      write(
        dir,
        "sandbox-image/Dockerfile",
        "# rebuild: initial\n# rebuild: build context repointed\nFROM scratch\n",
      );
      git("add", "-A");
      git("commit", "-qm", "marker");
      expect(runGate(dir, base, script).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an env.production-only image edit is gated against the production Dockerfile", () => {
    const { dir, git } = tempRepo();
    try {
      // Production builds from its own container block and its own Dockerfile.
      // The CLI diffs every configured Dockerfile together and accepts any
      // `rebuild:` line in that diff, so a marker in either file passes.
      const config = (buildContext: string) =>
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }],\n' +
        `  "env": { "production": { "containers": [{ "name": "prod", "images": { "sandbox": { "dockerfile": "./sandbox-image/Prod.Dockerfile", "build_context": "${buildContext}" } } }] } }\n}\n`;
      write(dir, "sandbox-image/Dockerfile", "# rebuild: staging\nFROM scratch\n");
      write(dir, "sandbox-image/Prod.Dockerfile", "# rebuild: production\nFROM scratch\n");
      write(dir, "wrangler.jsonc", config("."));
      git("add", "-A");
      git("commit", "-qm", "config + both images");
      const base = git("rev-parse", "HEAD");

      // No copied path changed: the container signature is the only signal.
      write(dir, "wrangler.jsonc", config("./sandbox-image"));
      git("add", "-A");
      git("commit", "-qm", "repoint only the production build context");
      expect(runGate(dir, base, script).code).toBe(1);

      // Marked in the production file: either file's marker line clears the
      // gate, and this is the file the production deploy hashes.
      write(dir, "sandbox-image/Prod.Dockerfile", "# rebuild: production\n# rebuild: prod context\nFROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "production marker");
      expect(runGate(dir, base, script).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the failure names the CHANGED families and the marker repair", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "packages/runner/src/gate.ts");
      write(dir, "sandbox-image/entry.sh", "#!/bin/sh\n");
      git("add", "-A");
      git("commit", "-qm", "image inputs");
      const base = git("rev-parse", "HEAD");

      write(dir, "packages/runner/src/gate.ts", "export const changed = true;\n");
      git("add", "-A");
      git("commit", "-qm", "touch one image input");

      const { code, out } = runGate(dir, base, script);
      expect(code).toBe(1);
      expect(out).toContain("::error::image-input-without-marker");
      expect(out).toContain("Changed image inputs:");
      expect(out).toContain("- packages/runner/src/**");
      // `sandbox-image/entry.sh` did not change in this range, so its family
      // must not be listed as a changed input (the doc's own bullets stay).
      expect(out).not.toContain("- sandbox-image/**");
      expect(out).toContain("# rebuild:");
      expect(out).toContain("sandbox-image/Dockerfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown --base refuses instead of passing, and names the base", () => {
    const { dir, git } = tempRepo();
    try {
      git("add", "-A");
      git("commit", "-qm", "config");

      // A base that was never fetched, e.g. an orphaned force-push tip.
      const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const { code, out } = runGate(dir, sha, script);
      expect(code).toBe(1);
      expect(out).toContain("::error::image-gate-base-unreachable");
      expect(out).toContain(sha);
      // The wrong cause this fix removes: the config was readable all along.
      expect(out).not.toContain("could not read the container blocks");
      expect(out).toContain("treat as unverified, not a pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable base recovers to the merge base and the gate still evaluates", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "sandbox-image/Dockerfile", "FROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      // The target branch stays at the divergence point; the feature branch
      // moves on, so its merge base with the target is the base commit.
      git("branch", "target");

      write(dir, "packages/runner/src/gate.ts", "export const changed = true;\n");
      git("add", "-A");
      git("commit", "-qm", "feature work");

      // The push's previous tip is gone (force-push): the fallback names what
      // it used and the diff is still evaluated — a failure, not a skip.
      const { code, out } = runGate(dir, "f".repeat(40), script, "--ref", "target");
      expect(code).toBe(1);
      expect(out).toContain("::warning::image-gate-base-recovered");
      expect(out).toContain("::error::image-input-without-marker");
      expect(out).toContain("- packages/runner/src/**");
      expect(out).not.toContain("image-gate-base-unreachable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a config that is new in this diff gets the family list, not the unverified message", () => {
    const { dir, git } = tempRepo();
    try {
      // The base revision predates the containers block entirely.
      rmSync(join(dir, "wrangler.jsonc"));
      write(dir, "packages/runner/src/gate.ts");
      write(dir, "sandbox-image/Dockerfile", "FROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "no config yet");
      const base = git("rev-parse", "HEAD");

      write(
        dir,
        "wrangler.jsonc",
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }]\n}\n',
      );
      write(dir, "packages/runner/src/gate.ts", "export const changed = true;\n");
      git("add", "-A");
      git("commit", "-qm", "add the containers block and touch an input");

      const { code, out } = runGate(dir, base, script);
      expect(code).toBe(1);
      expect(out).toContain("::error::image-input-without-marker");
      expect(out).toContain("- packages/runner/src/**");
      expect(out).toContain("wrangler.jsonc containers block");
      expect(out).not.toContain("unverified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a base with no merge base makes the diff unreadable and refuses", () => {
    const { dir, git } = tempRepo();
    try {
      git("add", "-A");
      git("commit", "-qm", "config");
      const head = git("rev-parse", "HEAD");

      // The config is readable at this revision, but the unrelated history has
      // no merge base, so `git diff <base>...HEAD` fails.
      git("checkout", "-q", "--orphan", "unrelated");
      git("rm", "-rqf", ".");
      write(
        dir,
        "wrangler.jsonc",
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }]\n}\n',
      );
      write(dir, "sandbox-image/Dockerfile", "# rebuild: unrelated\nFROM scratch\n");
      git("add", "-A");
      git("commit", "-qm", "unrelated history");
      const unrelated = git("rev-parse", "HEAD");
      git("checkout", "-q", head);

      const { code, out } = runGate(dir, unrelated, script);
      expect(code).toBe(1);
      expect(out).toContain("could not read the diff");
      expect(out).toContain("treat as unverified, not a pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
