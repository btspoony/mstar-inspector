#!/usr/bin/env bun
/**
 * check-image-inputs.ts — fail a diff that changes the sources copied into the
 * sandbox image without touching the Dockerfile's `# rebuild:` marker block.
 *
 * Usage:
 *   bun scripts/check-image-inputs.ts --base <sha>
 *
 * `wrangler` hashes `sandbox-image/Dockerfile` alone, so a runner/shared change
 * that does not touch that file deploys the Worker while the container keeps
 * running the previous build — silently. The decision is pure; the CLI only
 * feeds it two git outputs, so the rule is unit-testable without Docker.
 *
 * Exit codes: 0 = pass; 1 = image input changed without the marker, or the
 * diff could not be read (an unreadable answer is never a pass).
 */

/** Path families the image copies in — the gate's whole input vocabulary. */
export const IMAGE_INPUT_PATTERNS: readonly RegExp[] = [
  /^packages\/runner\/src\//,
  /^packages\/shared\/src\//,
  /^packages\/runner\/package\.json$/,
  /^packages\/runner\/bun\.lock$/,
  /^sandbox-image\//,
];

/** The instruction from `AGENTS.md` § Sandbox image rebuild, verbatim. */
export const IMAGE_REBUILD_INSTRUCTION = [
  "The review container is built from `sandbox-image/Dockerfile`, and `wrangler`",
  "hashes **that file alone** — not the sources the Dockerfile copies in. A change",
  "to those sources therefore deploys the Worker without rebuilding the image, and",
  "the container keeps running the previous build: no error, no warning, no",
  "failing check.",
  "",
  "Touch the `# rebuild:` marker block in `sandbox-image/Dockerfile` in the same",
  "commit whenever you change any of:",
  "",
  "- `packages/runner/src/**`",
  "- `packages/shared/src/**`",
  "- `packages/runner/package.json` or `packages/runner/bun.lock` (the image",
  "  installs from them, so an omp SDK bump is an image change)",
  "- `sandbox-image/**` — the CLI shims and their lockfiles",
].join("\n");

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
  console.error("usage: bun scripts/check-image-inputs.ts --base <sha>");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let base = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--base") base = argv[++i] ?? "";
    else {
      console.error(`check-image-inputs: unknown argument ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (base === "") {
    printUsage();
    process.exit(1);
  }

  const range = `${base}...HEAD`;
  const nameOnly = git(["diff", "--name-only", range]);
  const dockerfileDiff = git(["diff", range, "--", "sandbox-image/Dockerfile"]);
  if (nameOnly === undefined || dockerfileDiff === undefined) {
    console.error("::error::check-image-inputs: could not read the diff — treat as unverified, not a pass");
    process.exit(1);
  }

  const paths = nameOnly.split("\n").filter((line) => line !== "");
  const verdict = evaluateImageGate(paths, dockerfileDiff);
  if (!verdict.ok) {
    console.error(`::error::${verdict.reason}: this diff changes image inputs but not the rebuild marker.`);
    console.error(IMAGE_REBUILD_INSTRUCTION);
    process.exit(1);
  }
  console.log("image inputs: no rebuild marker required");
}
