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
 * without Docker.
 *
 * Exit codes: 0 = pass; 1 = image input changed without the marker, or the
 * diff/config could not be read (an unreadable answer is never a pass).
 */
import { readFileSync } from "node:fs";

/**
 * Path families the image copies in — the gate's whole input vocabulary, as
 * globs. `AGENTS.md` § Sandbox image rebuild and `docs/deploy.md` § Image
 * rebuild gate state the same six; the parity test reads all three surfaces,
 * so editing one alone fails.
 */
export const IMAGE_INPUT_FAMILIES: readonly string[] = [
  "packages/runner/src/**",
  "packages/shared/src/**",
  "packages/runner/package.json",
  "packages/runner/bun.lock",
  "packages/runner/verify-synthesis.sh",
  "sandbox-image/**",
];

/** One family glob as an anchored path regex (`**` = anything below). */
function familyPattern(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("**", ".*")}$`);
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
].join("\n");

/**
 * The image's Dockerfile, repo-relative, read from `wrangler.jsonc`'s
 * `containers[].images.sandbox.dockerfile` — the config is the one surface a
 * deploy actually reads, so the gate diffs exactly the file `wrangler` hashes
 * instead of a hand-copied path. `undefined` when the config cannot be read or
 * declares no image: the caller then fails instead of guessing a path.
 */
export function readDockerfilePath(configText: string): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(configText));
  } catch {
    return undefined;
  }
  if (typeof config !== "object" || config === null || !("containers" in config)) return undefined;
  const containers = config.containers;
  if (!Array.isArray(containers)) return undefined;
  for (const container of containers) {
    if (typeof container !== "object" || container === null || !("images" in container)) continue;
    const images = container.images;
    if (typeof images !== "object" || images === null || !("sandbox" in images)) continue;
    const sandbox = images.sandbox;
    if (typeof sandbox !== "object" || sandbox === null || !("dockerfile" in sandbox)) continue;
    // The first declared image is the one this repo ships; wrangler's `./`
    // spelling is the repo-relative path git knows.
    if (typeof sandbox.dockerfile === "string" && sandbox.dockerfile !== "") {
      return sandbox.dockerfile.replace(/^\.\//, "");
    }
  }
  return undefined;
}

/**
 * Strip JSONC comments — no dependency. A scanner, not a regex, so a `//`
 * inside a string value is never mistaken for a comment.
 */
function stripJsonComments(text: string): string {
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

export function evaluateImageGate(paths: string[], dockerfileDiff: string): ImageGateVerdict {
  if (!touchesImageInput(paths)) return { ok: true };
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

  // The path comes from the config `wrangler` itself reads, so a hand-copied
  // Dockerfile path here can never drift from the file a deploy hashes.
  let dockerfilePath: string | undefined;
  try {
    dockerfilePath = readDockerfilePath(readFileSync(configPath, "utf8"));
  } catch {
    dockerfilePath = undefined;
  }
  if (dockerfilePath === undefined) {
    console.error(
      `::error::check-image-inputs: ${configPath} declares no \`containers[].images.sandbox.dockerfile\` — treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  const range = `${base}...HEAD`;
  // `--no-renames` keeps both sides of a move, so leaving an input family is
  // visible as a deletion; `-z` avoids Git's quoting of non-ASCII paths.
  const nameOnly = git(["diff", "--name-only", "--no-renames", "-z", range]);
  const dockerfileDiff = git(["diff", range, "--", dockerfilePath]);
  if (nameOnly === undefined || dockerfileDiff === undefined) {
    console.error("::error::check-image-inputs: could not read the diff — treat as unverified, not a pass");
    process.exit(1);
  }

  const paths = parseNameOnly(nameOnly);
  const verdict = evaluateImageGate(paths, dockerfileDiff);
  if (!verdict.ok) {
    console.error(
      `::error::${verdict.reason}: this diff changes image inputs but not the rebuild marker in ${dockerfilePath}.`,
    );
    console.error(IMAGE_REBUILD_INSTRUCTION);
    process.exit(1);
  }
  console.log("image inputs: no rebuild marker required");
}
