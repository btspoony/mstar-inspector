/**
 * why: The image rebuild gate's decision seam (`scripts/check-image-inputs.ts`).
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
  collectImageInputPaths,
  containerSignature,
  evaluateImageGate,
  familyPattern,
  familyRoot,
  imageInputFingerprint,
  imageRebuildInstruction,
  IMAGE_INPUT_FAMILIES,
  readDockerfilePaths,
  readImageInputsMarker,
  resolveBase,
  touchesImageInput,
  withImageInputsMarker,
} from "./check-image-inputs";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * why: Backticked tokens on the BULLET lines of one prose slice — the documented
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
 * note: The `COPY <src>…` sources of a Dockerfile. Multi-stage `COPY --from=` reads
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
      "of everything the image is built from:",
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
    // why: Independent boundaries: a hand copy that drifts, or a generator that
    // slices only a fragment of the section, misses this exact string.
    const quoted = agents
      .slice(
        agents.indexOf("The review container is built from"),
        agents.indexOf("\nCheck before merging"),
      )
      .trimEnd();
    expect(imageRebuildInstruction()).toBe(quoted);
    // why: The fact the retired hand copy had lost: the doc names the Dockerfile.
    expect(imageRebuildInstruction()).toContain("sandbox-image/Dockerfile");
  });

  test("every COPY source in the Dockerfile is covered by an input family", () => {
    // why: The vocabulary is only complete if it covers what the image actually
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
    // note: Both blocks declare the same file here, so the gate diffs it once — but
    // it is derived from the config, never hardcoded.
    const configured = readDockerfilePaths(readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8"));
    expect(configured).toEqual(["sandbox-image/Dockerfile"]);
    // why: Both wrangler configs agree, so the gate never diffs a file a deploy ignores.
    expect(readDockerfilePaths(readFileSync(join(REPO_ROOT, "wrangler.smoke.jsonc"), "utf8"))).toEqual(
      configured,
    );
    // note: The configured file is the one the gate reads the fingerprint line from.
    expect(readFileSync(join(REPO_ROOT, configured[0]!), "utf8")).toContain("# image-inputs:");
  });

  test("a config without a container image answers no paths instead of a guessed one", () => {
    expect(readDockerfilePaths("{}")).toEqual([]);
    expect(readDockerfilePaths("not json")).toEqual([]);
    expect(readDockerfilePaths('{"containers":[{"images":{}}]}')).toEqual([]);
    // note: JSONC comments are stripped before the parse.
    expect(
      readDockerfilePaths('{\n // the image\n "containers": [{"images": {"sandbox": {"dockerfile": "./a/Df"}}}]}'),
    ).toEqual(["a/Df"]);
    // why: A named environment does not inherit `containers` (wrangler), so
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

describe("imageInputFingerprint", () => {
  const block = '[{"name":"c","images":{}}]';
  const file = (path: string, content = "export const x = 1;\n") => ({ path, content });

  test("the same tree hashes the same, whatever order it is listed in", () => {
    const a = imageInputFingerprint([file("a.ts"), file("b.ts", "x\n")], block);
    const b = imageInputFingerprint([file("b.ts", "x\n"), file("a.ts")], block);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a path rename, a content edit and a container-block edit each move it", () => {
    const base = imageInputFingerprint([file("a.ts")], block);
    // why: Same bytes at a new path: the deploy copies a different tree.
    expect(imageInputFingerprint([file("renamed.ts")], block)).not.toBe(base);
    expect(imageInputFingerprint([file("a.ts", "export const x = 2;\n")], block)).not.toBe(base);
    expect(imageInputFingerprint([file("a.ts")], '[{"name":"c","images":{"sandbox":{}}}]')).not.toBe(
      base,
    );
  });

  test("CRLF is the same file as LF, so a Windows checkout cannot force a rebuild", () => {
    expect(imageInputFingerprint([file("a.ts", "one\ntwo\n")], block)).toBe(
      imageInputFingerprint([file("a.ts", "one\r\ntwo\r\n")], block),
    );
  });
});

describe("the recorded fingerprint line", () => {
  test("a Dockerfile with no line records nothing; a malformed one is not a record", () => {
    expect(readImageInputsMarker("FROM scratch\n")).toBeUndefined();
    expect(readImageInputsMarker("# image-inputs: not-a-hash\nFROM scratch\n")).toBeUndefined();
    expect(readImageInputsMarker("# image-inputs:  deadbeef\n")).toBe("deadbeef");
  });

  test("writing replaces the existing line in place instead of accumulating lines", () => {
    const once = withImageInputsMarker("FROM scratch\n# image-inputs: aaaa\n", "bbbb");
    expect(once).toBe("FROM scratch\n# image-inputs: bbbb\n");
    expect(withImageInputsMarker(once, "cccc")).toBe("FROM scratch\n# image-inputs: cccc\n");
  });

  test("a Dockerfile without the line gets exactly one, and nothing else moves", () => {
    const written = withImageInputsMarker("FROM scratch\nRUN true\n", "ffff");
    expect(written).toBe("# image-inputs: ffff\nFROM scratch\nRUN true\n");
    expect(readImageInputsMarker(written)).toBe("ffff");
  });

  test("the committed Dockerfile records the tree it ships, and only that line mentions it", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "sandbox-image", "Dockerfile"), "utf8");
    expect(readImageInputsMarker(dockerfile)).toMatch(/^[0-9a-f]{32}$/);
    // note: The retired convention: a human-written changelog entry per change.
    expect(dockerfile).not.toMatch(/^\s*#\s*rebuild:/m);
  });
});

describe("image gate", () => {
  const FP = "0123456789abcdef0123456789abcdef";

  test("a Dockerfile recording the tree's own value passes", () =>
    expect(evaluateImageGate(FP, FP)).toEqual({ ok: true, fingerprint: FP }));

  test("a stale record fails, naming what it recorded and what the tree hashes to", () =>
    expect(evaluateImageGate("aaaa", FP, ["packages/runner/src/**"])).toEqual({
      ok: false,
      reason: "image-inputs-stale",
      fingerprint: FP,
      recorded: "aaaa",
      families: ["packages/runner/src/**"],
    }));

  test("a Dockerfile that records nothing is stale, not exempt", () =>
    expect(evaluateImageGate(undefined, FP)).toEqual({
      ok: false,
      reason: "image-inputs-stale",
      fingerprint: FP,
      recorded: undefined,
      families: [],
    }));

  test("the verdict does not depend on the base diff: families are the message only", () => {
    // why: A first push, a squashed base, an unreadable range — the fingerprint
    // already decided, so a missing family list still fails.
    expect(evaluateImageGate("aaaa", FP).ok).toBe(false);
    expect(evaluateImageGate(FP, FP).ok).toBe(true);
  });
});

describe("the input set the fingerprint covers", () => {
  test("the Dockerfiles are excluded, or writing the line would invalidate it", () => {
    const listed = [
      "packages/runner/src/index.ts",
      "sandbox-image/Dockerfile",
      "sandbox-image/Prod.Dockerfile",
      ".dockerignore",
      "docs/deploy.md",
    ];
    expect(
      collectImageInputPaths(
        () => listed,
        ["packages", "sandbox-image"],
        ["sandbox-image/Dockerfile", "sandbox-image/Prod.Dockerfile"],
      ),
    ).toEqual([".dockerignore", "packages/runner/src/index.ts"]);
  });

  test("the enumeration roots are the families' literal prefixes, never the repo root", () => {
    expect(familyRoot("packages/runner/src/**")).toBe("packages/runner/src");
    expect(familyRoot("packages/runner/package.json")).toBe("packages/runner/package.json");
    expect(familyRoot("sandbox-image/**")).toBe("sandbox-image");
    expect(familyRoot(".dockerignore")).toBe(".dockerignore");
    // why: A leading wildcard has no literal prefix: the walk widens rather than miss.
    expect(familyRoot("**/*.ts")).toBe(".");
  });
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
    // note: A JSONC comment is not a value either.
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
    // why: A named environment does not inherit `containers`, so a prod deploy
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
    // note: A production vars-only edit is not an image change.
    expect(
      containerSignature(
        `{\n  "env": { "production": { "vars": { "DEPLOYMENT_MODE": "saas" }, "containers": [${BLOCK}] } }\n}\n`,
      ),
    ).toBe(baseSignature);
    // note: A production block that is not an array fails closed like a top-level one.
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
    // why: Each family answers on a path it derives from itself, and answers with
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
    // note: `sandbox-image/*.sh` is one level only: the shell helpers the Dockerfile
    // copies live there, while a nested script (or the repo root) is not a
    // member of that family.
    const family = familyPattern("sandbox-image/*.sh");
    expect(family.test("sandbox-image/entry.sh")).toBe(true);
    expect(family.test("sandbox-image/verify-cli-lock.sh")).toBe(true);
    expect(family.test("sandbox-image/nested/entry.sh")).toBe(false);
    expect(family.test("entry.sh")).toBe(false);
    // note: `?` is one character, never the regex optional-quantifier it reads as.
    const single = familyPattern("sandbox-image/?.sh");
    expect(single.test("sandbox-image/a.sh")).toBe(true);
    expect(single.test("sandbox-image/.sh")).toBe(false);
    expect(single.test("sandbox-image/ab.sh")).toBe(false);
  });
});

/** note: A throwaway repo whose only commits are the ones this test writes. */
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
  // why: Git's default; a global `core.quotePath=false` would otherwise hide the quoting.
  git("config", "core.quotePath", "true");
  // why: The CLI reads the Dockerfile path from this config, so every fixture needs
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

/** note: The gate's actual CLI, run against `dir` for `base...HEAD`. */
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
    // why: The descendant guard is the only extra question: nothing is fetched and
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
      // note: HEAD is an ancestor of the requested commit: a backwards force-push.
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
      // note: HEAD is an ancestor of the fetched commit: a backwards force-push.
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
      // note: HEAD is not an ancestor of the merge base: the base lies behind HEAD.
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

  /** note: A temp repo whose image inputs are committed and whose line is current. */
  function seeded(): { dir: string; git: (...args: string[]) => string } {
    const repo = tempRepo();
    write(repo.dir, "sandbox-image/Dockerfile", "# image-inputs: 0000\nFROM scratch\n");
    write(repo.dir, "packages/runner/src/index.ts");
    repo.git("add", "-A");
    repo.git("commit", "-qm", "image + inputs");
    expect(runGate(repo.dir, repo.git("rev-parse", "HEAD~0"), script, "--write").code).toBe(0);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "recorded fingerprint");
    return repo;
  }

  test("a tree whose line records it passes, and so does an unchanged rerun", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
      const first = runGate(dir, base, script);
      expect(first.code).toBe(0);
      expect(first.out).toContain("recorded in");
      expect(runGate(dir, base, script).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an input changed without re-recording fails, and `--write` repairs it", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
      write(dir, "packages/runner/src/index.ts", "export const changed = true;\n");
      git("add", "-A");
      git("commit", "-qm", "touch an image input without the line");

      const stale = runGate(dir, base, script);
      expect(stale.code).toBe(1);
      expect(stale.out).toContain("::error::image-inputs-stale");
      // note: The message names the changed family and the exact repair command.
      expect(stale.out).toContain("- packages/runner/src/**");
      expect(stale.out).toContain("--write");

      expect(runGate(dir, base, script, "--write").code).toBe(0);
      expect(runGate(dir, base, script).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a new image input file fails until it is recorded too", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
      write(dir, "packages/shared/src/added.ts");
      git("add", "-A");
      git("commit", "-qm", "new shared file");

      const { code, out } = runGate(dir, base, script);
      expect(code).toBe(1);
      expect(out).toContain("- packages/shared/src/**");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-ASCII input path is fingerprinted despite Git quoting", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
      write(dir, "packages/runner/src/中文.ts");
      git("add", "-A");
      git("commit", "-qm", "non-ASCII runner source");
      expect(runGate(dir, base, script).code).toBe(1);
      expect(runGate(dir, base, script, "--write").code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wrangler.jsonc edit outside the container block moves nothing", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
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

  test("a build_context repoint fails until recorded, because the image it builds moved", () => {
    const { dir, git } = seeded();
    try {
      const base = git("rev-parse", "HEAD");
      write(
        dir,
        "wrangler.jsonc",
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile", "build_context": "." } } }]\n}\n',
      );
      git("add", "-A");
      git("commit", "-qm", "repoint the build context");

      const { code, out } = runGate(dir, base, script);
      expect(code).toBe(1);
      expect(out).toContain("wrangler.jsonc containers block");
      expect(runGate(dir, base, script, "--write").code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an env.production container block is recorded in the Dockerfile a prod deploy hashes", () => {
    const { dir, git } = seeded();
    try {
      const config = (buildContext: string) =>
        '{\n  "containers": [{ "images": { "sandbox": { "dockerfile": "./sandbox-image/Dockerfile" } } }],\n' +
        `  "env": { "production": { "containers": [{ "name": "prod", "images": { "sandbox": { "dockerfile": "./sandbox-image/Prod.Dockerfile", "build_context": "${buildContext}" } } }] } }\n}\n`;
      write(dir, "sandbox-image/Prod.Dockerfile", "FROM scratch\n");
      write(dir, "wrangler.jsonc", config("."));
      git("add", "-A");
      git("commit", "-qm", "production image");
      // note: Both configured files carry the same value.
      expect(runGate(dir, dir, script, "--write").code).toBe(0);
      git("add", "-A");
      git("commit", "-qm", "recorded in both");
      const base = git("rev-parse", "HEAD");

      write(dir, "wrangler.jsonc", config("./sandbox-image"));
      git("add", "-A");
      git("commit", "-qm", "repoint only the production build context");
      expect(runGate(dir, base, script).code).toBe(1);
      expect(runGate(dir, base, script, "--write").code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown base still decides the verdict, and the repair stays a command", () => {
    const { dir, git } = seeded();
    try {
      write(dir, "packages/runner/src/index.ts", "export const changed = true;\n");
      git("add", "-A");
      git("commit", "-qm", "touch an input");

      const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const { code, out } = runGate(dir, sha, script);
      expect(code).toBe(1);
      // why: The verdict is the fingerprint's, so it is unchanged by the bad base...
      expect(out).toContain("::error::image-inputs-stale");
      expect(out).toContain(`--base ${sha} --write`);
      // why: ...and the missing base is REPORTED, naming the commit and why it could
      // not be resolved, instead of an empty family list reading as "nothing
      // changed". This is the assertion the previous revision could not make:
      // it pinned the absence of an annotation the CLI never emitted.
      expect(out).toContain("::warning::image-gate-base-unresolved");
      expect(out).toContain(sha);
      expect(out).toContain("not reachable in this checkout");
      expect(out).not.toContain("image-gate-base-recovered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
