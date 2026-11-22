#!/usr/bin/env bun
/**
 * why: check-image-inputs.ts — fail a commit whose sandbox image inputs changed
 * without the Dockerfile recording them.
 *
 * Usage:
 *   bun scripts/check-image-inputs.ts --base <sha> [--ref <branch>] [--config wrangler.jsonc] [--write]
 *
 * `wrangler` hashes the container's Dockerfile alone — read from the config's
 * `containers[].images.sandbox.dockerfile`, never hardcoded here — so a
 * runner/shared change that does not touch that file deploys the Worker while
 * the container keeps running the previous build — silently. The Dockerfile is
 * the only lever a deploy reacts to, so the gate records the input set IN it:
 * one `# image-inputs: <hex>` line hashing every copied path's repo-relative
 * name and content plus the container block. Changing an input changes the
 * hash, so that line (and with it the hashed file) must move in the same
 * commit; `--write` recomputes it. The hash never covers the Dockerfile itself,
 * or writing the line would invalidate it.
 *
 * The fingerprint alone decides. `--base` supplies the message — WHICH families
 * the diff changed — and is not part of the verdict. Both container blocks
 * count: a named environment does not inherit `containers`, so `env.production`
 * declares its own image (`dockerfile`, `build_context`, `name`) and a prod
 * deploy builds from it.
 *
 * Exit codes: 0 = pass; 1 = a Dockerfile records a different input set than the
 * tree holds, or the tree/config could not be read (an unreadable answer is
 * never a pass).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Path families the image copies in — the gate's path vocabulary, as globs.
 * `AGENTS.md` § Sandbox image rebuild and `docs/deploy.md` § Image rebuild gate
 * state the same list; the parity test reads all three surfaces, so editing one
 * alone fails. The root `.dockerignore` belongs here because it decides which
 * of those sources reach the build context at all: excluding one changes the
 * image without touching anything the Dockerfile names.
 *
 * `wrangler.jsonc` is deliberately NOT a family: most of that file (vars,
 * queues, routes, observability) cannot change the image, and a whole-file
 * match would force a multi-minute image rebuild for every config edit. The
 * container block is compared by value instead — see `containerSignature`.
 */
export const IMAGE_INPUT_FAMILIES: readonly string[] = [
  "packages/runner/src/**",
  "packages/shared/src/**",
  "packages/runner/package.json",
  "packages/runner/bun.lock",
  "packages/runner/verify-synthesis.sh",
  "sandbox-image/**",
  ".dockerignore",
];

/**
 * One family glob as an anchored path regex. `**` crosses `/` (anything
 * below), `*` is one path segment, `?` is one character — the glob grammar,
 * not regex syntax, so an unescaped `?` never becomes an optional group.
 */
export function familyPattern(glob: string): RegExp {
  const GLOBSTAR = "\u0000";
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", GLOBSTAR)
    .replace(/[*?]/g, (meta) => (meta === "*" ? "[^/]*" : "[^/]"))
    .replaceAll(GLOBSTAR, ".*");
  return new RegExp(`^${source}$`);
}

const IMAGE_INPUT_PATTERNS: readonly RegExp[] = IMAGE_INPUT_FAMILIES.map(familyPattern);

/**
 * why: The instruction quoted on failure, read from `AGENTS.md` § Sandbox image
 * rebuild — the section itself, not a copy. A hand copy used to live here and
 * had already drifted (it named no Dockerfile while the doc names one); the
 * section is the single source, so the printed text cannot disagree with it.
 * The bullets are the doc's, and the parity test keeps them equal to
 * `IMAGE_INPUT_FAMILIES`.
 *
 * Read on the failure path only: a passing diff must not depend on the doc's
 * shape, so drift cannot block a clean run. The CLI catches the throw and
 * reports it as an `::error::` annotation instead of a stack trace.
 */
const AGENTS_SECTION = "## Sandbox image rebuild";
const INSTRUCTION_START = "The review container is built from";
const INSTRUCTION_END = "\nCheck before merging";

export function imageRebuildInstruction(): string {
  const agents = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8");
  const heading = agents.indexOf(AGENTS_SECTION);
  const start = heading < 0 ? -1 : agents.indexOf(INSTRUCTION_START, heading);
  const end = start < 0 ? -1 : agents.indexOf(INSTRUCTION_END, start);
  if (start < 0 || end < 0) {
    throw new Error(`AGENTS.md ${AGENTS_SECTION} no longer holds the instruction this gate quotes`);
  }
  return agents.slice(start, end).trimEnd();
}

/**
 * note: A JSON object at `value`, or `undefined` for anything else — a config field
 * carries whatever the file holds, and only an object can be walked.
 */
function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * why: Every `containers` array a deploy builds an image from, in config order: the
 * TOP LEVEL (staging) and `env.production`. A wrangler named environment does
 * not inherit resource keys, so production declares its own container block
 * with its own `dockerfile`/`build_context`/`name` — reading only the top
 * level let an `env.production`-only repoint ship unguarded. `undefined` when
 * a declared block is not an array: the caller fails closed instead of
 * trusting half a config.
 */
function containerArrays(config: Record<string, unknown>): unknown[][] | undefined {
  const production = objectAt(objectAt(config.env)?.production);
  const arrays: unknown[][] = [];
  for (const containers of [config.containers, production?.containers]) {
    if (containers === undefined) continue;
    if (!Array.isArray(containers)) return undefined;
    arrays.push(containers);
  }
  return arrays;
}

/**
 * The image's Dockerfile paths, repo-relative, read from `wrangler.jsonc`'s
 * `containers[].images.sandbox.dockerfile` in BOTH blocks (top level and
 * `env.production`) — the config is the one surface a deploy actually reads,
 * so the gate diffs exactly the files `wrangler` hashes instead of a
 * hand-copied path. `[]` when the config cannot be read or declares no image:
 * the caller then fails instead of guessing a path.
 */
export function readDockerfilePaths(configText: string): string[] {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(configText));
  } catch {
    return [];
  }
  const root = objectAt(config);
  if (root === undefined) return [];
  const arrays = containerArrays(root);
  if (arrays === undefined) return [];
  const paths: string[] = [];
  for (const container of arrays.flat()) {
    const sandbox = objectAt(objectAt(objectAt(container)?.images)?.sandbox);
    const dockerfile = sandbox?.dockerfile;
    // why: Wrangler's `./` spelling is the repo-relative path git knows.
    if (typeof dockerfile !== "string" || dockerfile === "") continue;
    const path = dockerfile.replace(/^\.\//, "");
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Strip JSONC comments — no dependency. A scanner, not a regex, so a `//`
 * inside a string value is never mistaken for a comment.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The container blocks a deploy builds images from, serialized so two
 * revisions compare by value instead of by file bytes: each block's array of
 * containers, each with its `name` and its whole `images` map (whose entries
 * carry `dockerfile` and `build_context`). Both blocks count — the top level
 * (staging) and `env.production` — because a prod deploy builds from the
 * latter, so an `env.production`-only repoint changes the image too (round-8
 * review). Everything else in the config — vars, queues, routes,
 * observability — cannot change the image, so it must not force a rebuild.
 * `undefined` when the config cannot be read: the caller fails instead of
 * passing unverified.
 *
 * shortcut: key order inside a block counts as a change; upgrade: sort keys
 * once a reorder-only edit shows up in practice.
 */
export function containerSignature(configText: string): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(configText));
  } catch {
    return undefined;
  }
  const root = objectAt(config);
  if (root === undefined) return undefined;
  const arrays = containerArrays(root);
  if (arrays === undefined) return undefined;
  return JSON.stringify(
    arrays.map((containers) =>
      containers.map((container) => {
        const entry = objectAt(container);
        if (entry === undefined) return null;
        return { name: entry.name, images: entry.images };
      }),
    ),
  );
}

export type ImageGateVerdict =
  | { ok: true; fingerprint: string }
  | {
      ok: false;
      reason: "image-inputs-stale";
      fingerprint: string;
      recorded: string | undefined;
      families: readonly string[];
    };

export function touchesImageInput(paths: string[]): boolean {
  return changedFamilies(paths).length > 0;
}

/** The declared families this diff touches — the failure message's actionable subset. */
export function changedFamilies(paths: string[]): string[] {
  return IMAGE_INPUT_FAMILIES.filter((_, i) =>
    paths.some((path) => IMAGE_INPUT_PATTERNS[i]!.test(path)),
  );
}

/** note: The one machine-maintained line each Dockerfile carries. */
const IMAGE_INPUTS_LINE = /^\s*#\s*image-inputs:\s*([0-9a-f]+)\s*$/;

/** The fingerprint a Dockerfile records, or `undefined` when it records none. */
export function readImageInputsMarker(dockerfileText: string): string | undefined {
  for (const line of dockerfileText.split("\n")) {
    const match = IMAGE_INPUTS_LINE.exec(line);
    if (match !== null) return match[1]!;
  }
  return undefined;
}

/**
 * The input set as one value: sorted repo-relative paths, their contents with
 * newlines normalized, and the container block. No absolute path, mtime or
 * machine fact enters it, so the same tree hashes the same everywhere — CI
 * reproducibility is the whole point of recording it in a committed file.
 *
 * 128 bits of SHA-256: a collision here would have to be adversarially
 * constructed against a value nobody gains from forging.
 */
export function imageInputFingerprint(
  files: readonly { path: string; content: string }[],
  containerBlock: string,
): string {
  const hash = createHash("sha256");
  const normalized = (text: string) => text.replace(/\r\n/g, "\n");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\0${normalized(file.content)}\0`);
  }
  // why: The container block decides which tree the Dockerfile sees and which file
  // a deploy hashes, so it belongs to the same value as the copied sources.
  hash.update(`containers\0${normalized(containerBlock)}\0`);
  return hash.digest("hex").slice(0, 32);
}

/** The Dockerfile with its fingerprint line replaced, or added above the first line. */
export function withImageInputsMarker(dockerfileText: string, fingerprint: string): string {
  const line = `# image-inputs: ${fingerprint}`;
  const lines = dockerfileText.split("\n");
  const at = lines.findIndex((candidate) => IMAGE_INPUTS_LINE.test(candidate));
  if (at >= 0) {
    lines[at] = line;
    return lines.join("\n");
  }
  // why: Above every instruction: nothing a build reads moves, only the file's bytes.
  return [line, ...lines].join("\n");
}

/**
 * The verdict is the recorded value against the tree's own — a Dockerfile with
 * no line records nothing, so it is stale. `families` is the message's part:
 * computed from the base diff when one can be read, and empty otherwise.
 */
export function evaluateImageGate(
  recorded: string | undefined,
  fingerprint: string,
  families: readonly string[] = [],
): ImageGateVerdict {
  if (recorded === fingerprint) return { ok: true, fingerprint };
  return { ok: false, reason: "image-inputs-stale", fingerprint, recorded, families };
}

/**
 * The repo-relative paths of every file the image copies in, from git's own
 * view (tracked plus untracked-but-not-ignored, so a run before the first
 * `git add` sees the same set a commit will), minus the Dockerfiles: the
 * fingerprint lives in those, and covering them would invalidate it on write.
 */
export function collectImageInputPaths(
  listFiles: (roots: readonly string[]) => string[],
  roots: readonly string[],
  dockerfilePaths: readonly string[],
): string[] {
  return listFiles(roots)
    .filter((path) => touchesImageInput([path]))
    .filter((path) => !dockerfilePaths.includes(path))
    .sort();
}

/**
 * The literal directory prefix of a family glob — the roots handed to git, so
 * the enumeration never walks the whole repository.
 */
export function familyRoot(family: string): string {
  const segments = family.split("/");
  const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
  // note: No wildcard: the family names one file, and that file is the root.
  const literal = wildcard < 0 ? segments : segments.slice(0, wildcard);
  return literal.join("/") === "" ? "." : literal.join("/");
}

/** `git diff --name-only -z` output: NUL-separated, never quoted or escaped. */
export function parseNameOnly(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

/** note: Run one git command; `undefined` when it fails (the diff is then unknown). */
function git(args: string[], quiet = false): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    if (!quiet) {
      const stderr = proc.stderr.toString().trim();
      console.error(`check-image-inputs: git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`);
    }
    return undefined;
  }
  return proc.stdout.toString();
}

/** A git call whose failure is an answer rather than a report. */
export type GitRun = (args: string[]) => string | undefined;

const gitQuiet: GitRun = (args) => git(args, true);

/** note: Whether `spec` names an object in the repository (`git cat-file -e`). */
function objectExists(spec: string, run: GitRun): boolean {
  return run(["cat-file", "-e", spec]) !== undefined;
}

/**
 * The commit the gate diffs from, or the recovery that answered when the named
 * one cannot be resolved.
 *
 * A push's `--base` is the ref's previous tip, and a force-push orphans it:
 * the depth-0 checkout fetched only what the new ref points at, so `git show`
 * failed and the gate blamed the config for an absent commit on every re-run.
 * Recovery still evaluates the diff instead of skipping it:
 *
 * 1. the named commit, when the checkout has it;
 * 2. the same commit fetched from `origin`, when the server still holds it;
 * 3. the merge base with `ref` (the target branch), where the new history
 *    actually diverged — never HEAD itself, which would diff an empty range.
 *
 * Every one of them answers only for a base BEHIND HEAD. A backwards
 * force-push leaves `before` a descendant, and the server still serves it
 * through the gc window, so the fetched path could accept a base newer than
 * the change: `git diff base...HEAD` then collapses to `diff(HEAD, HEAD)` —
 * an empty range, read as "nothing image-affecting changed". The guard is
 * global for that reason, not a property of the merge-base fallback.
 *
 * Only when none answers does the gate fail closed, with a cause that names
 * the unreachable base rather than the file it could not read.
 */
export function resolveBase(
  requested: string,
  ref: string | undefined,
  run: GitRun,
): { sha: string; recovered?: "fetched" | "merge-base" } | { error: string } {
  const head = run(["rev-parse", "HEAD"])?.trim();
  const local = objectExists(`${requested}^{commit}`, run);
  const fetched =
    !local &&
    run(["fetch", "--no-tags", "--quiet", "origin", requested]) !== undefined &&
    objectExists(`${requested}^{commit}`, run);
  // why: The named/fetched commit answers only when it lies behind HEAD: a base at
  // HEAD or ahead of it diffs to `diff(HEAD, HEAD)` — empty, and read as a pass.
  if (
    (local || fetched) &&
    requested !== head &&
    run(["merge-base", "--is-ancestor", "HEAD", requested]) === undefined
  ) {
    return fetched ? { sha: requested, recovered: "fetched" } : { sha: requested };
  }
  if (ref !== undefined && ref !== "") {
    const mergeBase = run(["merge-base", "HEAD", ref])?.trim() ?? "";
    // why: Same rule as above, on the same terms: the fallback is no exception.
    if (
      mergeBase !== "" &&
      mergeBase !== head &&
      run(["merge-base", "--is-ancestor", "HEAD", mergeBase]) === undefined
    ) {
      return { sha: mergeBase, recovered: "merge-base" };
    }
  }
  const cause =
    local || fetched
      ? `the base commit ${requested} is not behind HEAD, so a diff from it is empty (a backwards force-push)`
      : `the base commit ${requested} is not reachable in this checkout (a force-push or a garbage-collected commit)`;
  return {
    error:
      cause +
      (ref === undefined || ref === "" ? "" : `, and ${ref} offers no older merge base`),
  };
}
function printUsage(): void {
  console.error(
    "usage: bun scripts/check-image-inputs.ts --base <sha> [--ref <branch>] [--config wrangler.jsonc] [--write]",
  );
}

/** note: `git ls-files` over the family roots: tracked plus untracked, never ignored. */
function listImageInputPaths(roots: readonly string[]): string[] {
  const output = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots]);
  if (output === undefined) {
    throw new Error(`could not enumerate the image inputs under ${roots.join(", ")}`);
  }
  return parseNameOnly(output);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let base = "";
  let ref = "";
  let configPath = "wrangler.jsonc";
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base") base = argv[++i] ?? "";
    else if (arg === "--ref") ref = argv[++i] ?? "";
    else if (arg === "--config") configPath = argv[++i] ?? "";
    else if (arg === "--write") write = true;
    else {
      console.error(`check-image-inputs: unknown argument ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (base === "" || configPath === "") {
    printUsage();
    process.exit(1);
  }

  // why: The paths come from the config `wrangler` itself reads, so a hand-copied
  // Dockerfile path here can never drift from the files a deploy hashes.
  let headConfig: string;
  try {
    headConfig = readFileSync(configPath, "utf8");
  } catch {
    console.error(
      `::error::check-image-inputs: ${configPath} could not be read — treat as unverified, not a pass`,
    );
    process.exit(1);
  }
  const dockerfilePaths = readDockerfilePaths(headConfig);
  if (dockerfilePaths.length === 0) {
    console.error(
      `::error::check-image-inputs: ${configPath} declares no \`containers[].images.sandbox.dockerfile\` (top level or env.production) — treat as unverified, not a pass`,
    );
    process.exit(1);
  }
  const dockerfileLabel = dockerfilePaths.join(" / ");

  // why: The container block is part of the input set: a `build_context` or
  // Dockerfile repoint changes the image even though no copied path did. Every
  // other config edit (vars, queues, routes, observability) cannot.
  const headBlock = containerSignature(headConfig);
  if (headBlock === undefined) {
    console.error(
      `::error::check-image-inputs: ${configPath} declares no readable container blocks — treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  // why: The tree's own answer: every copied file's path and content, enumerated
  // from git so ignored trees (node_modules, .wrangler) never enter the hash.
  const roots = [...new Set(IMAGE_INPUT_FAMILIES.map(familyRoot))];
  let inputPaths: string[];
  try {
    inputPaths = collectImageInputPaths(listImageInputPaths, roots, dockerfilePaths);
  } catch (error) {
    console.error(
      `::error::check-image-inputs: ${error instanceof Error ? error.message : String(error)} — treat as unverified, not a pass`,
    );
    process.exit(1);
  }
  const files: { path: string; content: string }[] = [];
  for (const path of inputPaths) {
    try {
      files.push({ path, content: readFileSync(path, "utf8") });
    } catch {
      console.error(
        `::error::check-image-inputs: image input ${path} could not be read — treat as unverified, not a pass`,
      );
      process.exit(1);
    }
  }
  const fingerprint = imageInputFingerprint(files, headBlock);

  // why: `--write` is the repair: recompute, record it in every configured
  // Dockerfile, and report what moved. It still fails a tree it could not
  // fingerprint above, so it can never paper over an unreadable input.
  if (write) {
    let changed = 0;
    for (const path of dockerfilePaths) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        console.error(`::error::check-image-inputs: ${path} does not exist — nothing to record the fingerprint in`);
        process.exit(1);
      }
      const next = withImageInputsMarker(text, fingerprint);
      if (next === text) continue;
      writeFileSync(path, next);
      changed++;
    }
    console.log(
      `image inputs: ${fingerprint} written to ${dockerfileLabel}${changed === 0 ? " (already current)" : ""}`,
    );
    process.exit(0);
  }

  // invariant: Every configured Dockerfile records the SAME value: a deploy hashes one of
  // them, so a stale line in either is a stale image.
  let verdict: ImageGateVerdict | undefined;
  for (const path of dockerfilePaths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      console.error(`::error::check-image-inputs: ${path} could not be read — treat as unverified, not a pass`);
      process.exit(1);
    }
    const current = evaluateImageGate(readImageInputsMarker(text), fingerprint);
    if (!current.ok) verdict = current;
  }
  if (verdict !== undefined && !verdict.ok) {
    // why: `--base` supplies the MESSAGE only: which families moved since the base
    // revision. A base that cannot be resolved leaves the list empty rather
    // than failing a verdict the fingerprint already decided — but it says so:
    // "no family list" and "the base is gone" are different facts, and an
    // operator who cannot see which one happened reads the empty list as
    // "nothing changed".
    const resolved = resolveBase(base, ref, gitQuiet);
    const families = new Set<string>();
    if ("error" in resolved) {
      console.error(
        `::warning::image-gate-base-unresolved: ${resolved.error} — the verdict below stands on the fingerprint; only the changed-family list is missing. Pass --base <sha> with a commit this checkout has to see it.`,
      );
    } else {
      if (resolved.recovered !== undefined) {
        const how = resolved.recovered === "fetched" ? "fetched from origin" : `the merge base with ${ref}`;
        console.error(
          `::warning::image-gate-base-recovered: ${base} is unreachable in this checkout (a force-push or a garbage-collected commit); listing families against ${resolved.sha}, ${how}`,
        );
      }
      const nameOnly = git(["diff", "--name-only", "--no-renames", "-z", `${resolved.sha}...HEAD`]);
      const baseConfig = git(["show", `${resolved.sha}:${configPath}`]);
      if (nameOnly !== undefined) for (const family of changedFamilies(parseNameOnly(nameOnly))) families.add(family);
      const baseBlock = baseConfig === undefined ? undefined : containerSignature(baseConfig);
      if (baseConfig === undefined ? objectExists(`${resolved.sha}:${configPath}`, gitQuiet) : baseBlock !== headBlock) {
        families.add(`${configPath} containers block`);
      }
    }
    console.error(
      `::error::${verdict.reason}: ${dockerfileLabel} records image inputs ${verdict.recorded === undefined ? "(none)" : verdict.recorded} but the tree hashes to ${verdict.fingerprint}.`,
    );
    if (families.size > 0) {
      console.error("Changed image inputs:");
      for (const family of [...families].sort()) console.error(`- ${family}`);
    }
    console.error(
      `Repair: bun scripts/check-image-inputs.ts --base ${base} --write — it recomputes the fingerprint and rewrites the \`# image-inputs:\` line in ${dockerfileLabel}.`,
    );
    console.error("");
    try {
      console.error(imageRebuildInstruction());
    } catch (error) {
      console.error(
        `::error::image-rebuild-instruction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exit(1);
  }
  console.log(`image inputs: ${fingerprint} recorded in ${dockerfileLabel}`);
}
