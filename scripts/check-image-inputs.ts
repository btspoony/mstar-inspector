#!/usr/bin/env bun
/**
 * check-image-inputs.ts — fail a diff that changes the sources copied into the
 * sandbox image without touching the Dockerfile's `# rebuild:` marker block.
 *
 * Usage:
 *   bun scripts/check-image-inputs.ts --base <sha> [--config wrangler.jsonc]
 *
 * `wrangler` hashes the container's Dockerfile alone — read from the config's
 * `containers[].images.sandbox.dockerfile`, never hardcoded here — so a
 * runner/shared change that does not touch that file deploys the Worker while
 * the container keeps running the previous build — silently. The decision is
 * pure; the CLI only feeds it two git outputs, so the rule is unit-testable
 * without Docker. Both container blocks count: a named environment does not
 * inherit `containers`, so `env.production` declares its own image
 * (`dockerfile`, `build_context`, `name`) and a prod deploy builds from it.
 *
 * Exit codes: 0 = pass; 1 = image input changed without the marker, or the
 * diff/config could not be read (an unreadable answer is never a pass).
 */
import { readFileSync } from "node:fs";

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

export const IMAGE_INPUT_PATTERNS: readonly RegExp[] = IMAGE_INPUT_FAMILIES.map(familyPattern);

/** The instruction from `AGENTS.md` § Sandbox image rebuild, generated from the one family list. */
export const IMAGE_REBUILD_INSTRUCTION = [
  "The review container is built from the Dockerfile below, and `wrangler`",
  "hashes **that file alone** — not the sources the Dockerfile copies in. A change",
  "to those sources therefore deploys the Worker without rebuilding the image, and",
  "the container keeps running the previous build: no error, no warning, no",
  "failing check.",
  "",
  "Touch the `# rebuild:` marker block in that Dockerfile in the same commit",
  "whenever you change any of:",
  "",
  ...IMAGE_INPUT_FAMILIES.map((family) => `- \`${family}\``),
  "",
  "…or when either container block in `wrangler.jsonc` (top level or",
  "`env.production`) changes: the container's `name`, its `images` entry, or that",
  "entry's `dockerfile`/`build_context`. A config edit outside those blocks (vars,",
  "queues, routes, observability) needs no rebuild.",
].join("\n");

/**
 * A JSON object at `value`, or `undefined` for anything else — a config field
 * carries whatever the file holds, and only an object can be walked.
 */
function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Every `containers` array a deploy builds an image from, in config order: the
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
    // Wrangler's `./` spelling is the repo-relative path git knows.
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
 * shortcut: key order inside a block counts as a change; sort keys if a
 * reorder-only edit ever shows up in practice.
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

export type ImageGateVerdict = { ok: true } | { ok: false; reason: "image-input-without-marker" };

export function touchesImageInput(paths: string[]): boolean {
  return paths.some((path) => IMAGE_INPUT_PATTERNS.some((pattern) => pattern.test(path)));
}

/**
 * A marker change is an added or removed line carrying `rebuild:`. Diff
 * headers (`+++ b/...`, `--- a/...`) are not content lines.
 */
export function touchesRebuildMarker(dockerfileDiff: string): boolean {
  return dockerfileDiff.split("\n").some(
    (line) =>
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---") &&
      line.includes("rebuild:"),
  );
}

/**
 * `containersChanged` is the config half of the vocabulary: the parsed
 * container block differs between base and head, so the image a deploy builds
 * changed even when no copied path did.
 */
export function evaluateImageGate(
  paths: string[],
  dockerfileDiff: string,
  containersChanged: boolean,
): ImageGateVerdict {
  if (!touchesImageInput(paths) && !containersChanged) return { ok: true };
  if (touchesRebuildMarker(dockerfileDiff)) return { ok: true };
  return { ok: false, reason: "image-input-without-marker" };
}

/** `git diff --name-only -z` output: NUL-separated, never quoted or escaped. */
export function parseNameOnly(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

/** Run one git command; `undefined` when it fails (the diff is then unknown). */
function git(args: string[]): string | undefined {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    console.error(`check-image-inputs: git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`);
    return undefined;
  }
  return proc.stdout.toString();
}

function printUsage(): void {
  console.error("usage: bun scripts/check-image-inputs.ts --base <sha> [--config wrangler.jsonc]");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let base = "";
  let configPath = "wrangler.jsonc";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base") base = argv[++i] ?? "";
    else if (arg === "--config") configPath = argv[++i] ?? "";
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

  // The paths come from the config `wrangler` itself reads, so a hand-copied
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

  // The container blocks are read at BOTH revisions: a `build_context` or
  // Dockerfile repoint changes the image even though no copied path did. The
  // file itself is not a path family — every other config edit is image-neutral.
  const baseConfig = git(["show", `${base}:${configPath}`]);
  const baseSignature = baseConfig === undefined ? undefined : containerSignature(baseConfig);
  const headSignature = containerSignature(headConfig);
  if (baseSignature === undefined || headSignature === undefined) {
    console.error(
      `::error::check-image-inputs: could not read the container blocks of ${configPath} at ${base} and HEAD (the path must be repo-relative) — treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  const range = `${base}...HEAD`;
  // `--no-renames` keeps both sides of a move, so leaving an input family is
  // visible as a deletion; `-z` avoids Git's quoting of non-ASCII paths.
  const nameOnly = git(["diff", "--name-only", "--no-renames", "-z", range]);
  // Both Dockerfile paths: a marker change in EITHER satisfies the gate.
  const dockerfileDiff = git(["diff", range, "--", ...dockerfilePaths]);
  if (nameOnly === undefined || dockerfileDiff === undefined) {
    console.error("::error::check-image-inputs: could not read the diff — treat as unverified, not a pass");
    process.exit(1);
  }

  const paths = parseNameOnly(nameOnly);
  const verdict = evaluateImageGate(paths, dockerfileDiff, baseSignature !== headSignature);
  if (!verdict.ok) {
    console.error(
      `::error::${verdict.reason}: this diff changes image inputs but not the rebuild marker in ${dockerfileLabel}.`,
    );
    console.error(IMAGE_REBUILD_INSTRUCTION);
    process.exit(1);
  }
  console.log("image inputs: no rebuild marker required");
}
