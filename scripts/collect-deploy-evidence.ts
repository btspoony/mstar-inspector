#!/usr/bin/env bun
/**
 * collect-deploy-evidence.ts — bounded-wait deploy evidence collector
 * (plan 52 D1). Consumes the existing deploy.yml evidence chain: for the
 * release PR's merge commit SHA, wait for the Deploy workflow run to reach a
 * terminal state, download its `deploy-evidence` artifact, and print the
 * markdown section task 2 appends to the release notes.
 *
 * Usage:
 *   bun run scripts/collect-deploy-evidence.ts <merge-sha>
 *   MERGE_SHA=<sha> bun run scripts/collect-deploy-evidence.ts
 *   bun run scripts/collect-deploy-evidence.ts <sha> --wait-minutes 15 --interval-seconds 30
 *   bun run scripts/collect-deploy-evidence.ts --help
 *
 * Branches (evidence is a recording surface, never a gate — plan 52):
 *   - run concludes success -> download `deploy-evidence`, print Worker
 *     Version ID + image digest + run link;
 *   - run concludes failure -> explicit failed section (run link);
 *   - timeout with run still in flight -> explicit pending section (run link);
 *   - no run for the SHA after the wait window -> explicit no-run section
 *     (deploy.yml paths-ignore can legitimately skip a commit).
 *
 * Exit code: 0 for EVERY runtime outcome above, including collection errors
 * (`gh` missing, artifact download failure) which degrade to a section noting
 * the error. Exit 1 is reserved for usage errors (missing/invalid SHA) —
 * matching the release-script trio — so the release workflow never fails on
 * evidence absence.
 *
 * Output contract: the section (heading `### Deploy evidence` + bullets, no
 * trailing newline) on stdout; a one-line outcome summary on stderr. Error
 * text is collapsed to a single line and artifact-derived values are
 * shape-validated (single line, backtick-free, length-capped) before
 * interpolation — a violation degrades the section, never breaks its `- `
 * bullet shape. The run link falls back to the bare run id when
 * $GITHUB_SERVER_URL / $GITHUB_REPOSITORY are unset (local dry-runs).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEPLOY_EVIDENCE_ARTIFACT = "deploy-evidence";
export const DEFAULT_WAIT_MINUTES = 15;
export const DEFAULT_INTERVAL_SECONDS = 30;

/** One deploy.yml run as reported by `gh run list --json` (null conclusion until completed). */
export type GhRun = {
  databaseId: number;
  status: string;
  conclusion: string | null;
  displayTitle: string;
};

/**
 * The GH-touching layer, injectable so unit tests pin the wait/match/timeout
 * decision logic without network or the `gh` binary.
 */
export type GhRunner = {
  /** `gh run list --workflow deploy.yml --commit <sha> --json ...`; throws on gh failure. */
  listRuns(sha: string): GhRun[];
  /** `gh run download <id> -n deploy-evidence -D <dir>`; throws on failure. */
  downloadArtifact(runId: number, destDir: string): void;
};

export type CollectOptions = {
  sha: string;
  /** Total bounded-wait budget. Default via CLI: 15 min. */
  waitMs: number;
  /** Poll interval. Default via CLI: 30 s. */
  intervalMs: number;
  runner: GhRunner;
  /** Deadline clock — tests pass a fake. Default: Date.now. */
  now?: () => number;
  /** Inter-poll sleep — tests pass a no-op recorder. Default: Bun.sleepSync. */
  sleep?: (ms: number) => void;
  /** Env the run link resolves from. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Artifact download dir. Default: a fresh mkdtemp (removed after reading). */
  artifactDir?: string;
};

export type CollectKind = "success" | "deploy-failed" | "pending" | "no-run" | "degraded";

export type CollectResult = {
  kind: CollectKind;
  /** The markdown section (no trailing newline) for the release notes. */
  section: string;
};

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Upper bound for artifact-derived values interpolated into the public release body. */
export const EVIDENCE_VALUE_MAX_LENGTH = 256;

/**
 * Shape gate for artifact-derived strings (`version_id.txt` /
 * `image_digest.txt` values) before they reach the release body: single
 * line, no backticks (the bullets quote values in `code` spans), bounded
 * length. Throws naming the file and violation; `concludeRun` catches and
 * degrades — raw content is never interpolated.
 */
export function validateEvidenceShape(value: string, file: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${file} value is not a single line`);
  }
  if (value.includes("`")) {
    throw new Error(`${file} value contains a backtick`);
  }
  if (value.length > EVIDENCE_VALUE_MAX_LENGTH) {
    throw new Error(`${file} value exceeds ${EVIDENCE_VALUE_MAX_LENGTH} characters`);
  }
  return value;
}

/** Error text (`gh` stderr can be multi-line) collapsed to keep the `- ` bullet shape. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseArgs(argv: string[]): {
  sha?: string;
  waitMinutes: number;
  intervalSeconds: number;
  help: boolean;
} {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let sha: string | undefined;
  let waitMinutes = DEFAULT_WAIT_MINUTES;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let help = false;
  const numeric = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid ${flag} value: ${value ?? "<none>"} (expected a non-negative number)`);
    }
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--wait-minutes" || a.startsWith("--wait-minutes=")) {
      waitMinutes = numeric(
        "--wait-minutes",
        a === "--wait-minutes" ? rest[++i] : a.slice("--wait-minutes=".length),
      );
    } else if (a === "--interval-seconds" || a.startsWith("--interval-seconds=")) {
      intervalSeconds = numeric(
        "--interval-seconds",
        a === "--interval-seconds" ? rest[++i] : a.slice("--interval-seconds=".length),
      );
    } else if (FULL_SHA_RE.test(a)) sha = a.toLowerCase();
    else if (/^[0-9a-f]{7,40}$/i.test(a)) {
      throw new Error(
        `Invalid commit SHA: ${a} (expected the full 40-char merge commit SHA — gh matches runs by exact head SHA)`,
      );
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (intervalSeconds < 1) {
    throw new Error(`Invalid --interval-seconds value: ${intervalSeconds} (minimum 1)`);
  }
  return { sha, waitMinutes, intervalSeconds, help };
}

/** Run link: `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/<id>`, bare id without the env pair. */
export function runLink(runId: number, env: Record<string, string | undefined>): string {
  const server = env["GITHUB_SERVER_URL"];
  const repo = env["GITHUB_REPOSITORY"];
  if (server && repo) return `${server}/${repo}/actions/runs/${runId}`;
  return String(runId);
}

/** `gh run list` is newest-first; with several runs for one SHA (e.g. a manual re-dispatch), the newest is the live one. */
function pickRun(runs: GhRun[]): GhRun | undefined {
  return runs[0];
}

function waitMinutesLabel(waitMs: number): string {
  return `~${Math.max(1, Math.round(waitMs / 60000))} min`;
}

function section(lines: string[]): string {
  return ["### Deploy evidence", ...lines].join("\n");
}

function successSection(
  versionId: string,
  digest: string,
  run: GhRun,
  env: Record<string, string | undefined>,
): string {
  return section([
    `- Worker version: \`${versionId}\``,
    `- Image digest: \`${digest}\``,
    `- Actions run: ${runLink(run.databaseId, env)}`,
  ]);
}

function pendingSection(run: GhRun, waitMs: number, env: Record<string, string | undefined>): string {
  return section([
    `- Status: pending — deploy run still in flight after the ${waitMinutesLabel(waitMs)} bounded wait`,
    `- Actions run: ${runLink(run.databaseId, env)}`,
  ]);
}

function failedSection(run: GhRun, env: Record<string, string | undefined>): string {
  return section([
    `- Status: deploy failed — run concluded "${run.conclusion ?? "unknown"}"; see the run log`,
    `- Actions run: ${runLink(run.databaseId, env)}`,
  ]);
}

function noRunSection(sha: string, waitMs: number): string {
  return section([
    `- Status: no deploy run for commit \`${sha}\` after the ${waitMinutesLabel(waitMs)} bounded wait (deploy.yml paths-ignore may have skipped this commit)`,
  ]);
}

function degradedSection(
  err: unknown,
  run: GhRun | undefined,
  env: Record<string, string | undefined>,
): string {
  const lines = [
    `- Status: unavailable — ${oneLine(err instanceof Error ? err.message : String(err))}`,
  ];
  if (run) lines.push(`- Actions run: ${runLink(run.databaseId, env)}`);
  return section(lines);
}

/**
 * Terminal-state handling for a completed run: success downloads the
 * `deploy-evidence` artifact and reads `version_id.txt` + `image_digest.txt`;
 * any artifact-side failure degrades (never fails the release).
 */
function concludeRun(run: GhRun, opts: CollectOptions): CollectResult {
  if (run.conclusion !== "success") {
    return { kind: "deploy-failed", section: failedSection(run, opts.env ?? process.env) };
  }
  const env = opts.env ?? process.env;
  const ownDir = opts.artifactDir === undefined;
  const dir = opts.artifactDir ?? mkdtempSync(join(tmpdir(), "deploy-evidence-"));
  try {
    opts.runner.downloadArtifact(run.databaseId, dir);
    const versionId = validateEvidenceShape(
      readFileSync(join(dir, "version_id.txt"), "utf8").trim(),
      "version_id.txt",
    );
    const digest = validateEvidenceShape(
      readFileSync(join(dir, "image_digest.txt"), "utf8").trim(),
      "image_digest.txt",
    );
    if (!versionId || !digest) {
      throw new Error(
        `artifact ${DEPLOY_EVIDENCE_ARTIFACT} has empty version_id.txt / image_digest.txt`,
      );
    }
    return { kind: "success", section: successSection(versionId, digest, run, env) };
  } catch (err) {
    return { kind: "degraded", section: degradedSection(err, run, env) };
  } finally {
    if (ownDir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The bounded wait loop. Polls at `intervalMs` for the deploy run of `sha`
 * until it reaches a terminal state or `waitMs` elapses, then returns the
 * matching section. Only `runner.listRuns`/`downloadArtifact` failures and
 * artifact-shape problems can degrade; the wait itself never throws.
 */
export function collectDeployEvidence(opts: CollectOptions): CollectResult {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const env = opts.env ?? process.env;
  const deadline = now() + opts.waitMs;
  let seen: GhRun | undefined;
  for (;;) {
    let run: GhRun | undefined;
    try {
      run = pickRun(opts.runner.listRuns(opts.sha));
    } catch (err) {
      // gh missing / auth / network — deterministic enough to surface now
      // rather than burn the whole window retrying (evidence is not a gate).
      return { kind: "degraded", section: degradedSection(err, seen, env) };
    }
    if (run) seen = run;
    if (run?.status === "completed") return concludeRun(run, opts);
    if (now() >= deadline) {
      return seen
        ? { kind: "pending", section: pendingSection(seen, opts.waitMs, env) }
        : { kind: "no-run", section: noRunSection(opts.sha, opts.waitMs) };
    }
    sleep(Math.min(opts.intervalMs, deadline - now()));
  }
}

/** The real GH layer: local `gh` binary calls (spawnSync keeps the loop sync and test-injectable). */
export function createGhRunner(): GhRunner {
  const gh = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const proc = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      code: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  };
  return {
    listRuns(sha: string): GhRun[] {
      const proc = gh([
        "run",
        "list",
        "--workflow",
        "deploy.yml",
        "--commit",
        sha,
        "--json",
        "status,conclusion,databaseId,displayTitle",
      ]);
      if (proc.code !== 0) {
        throw new Error(`gh run list failed (${proc.code}): ${proc.stderr.trim()}`);
      }
      return JSON.parse(proc.stdout) as GhRun[];
    },
    downloadArtifact(runId: number, destDir: string): void {
      const proc = gh(["run", "download", String(runId), "-n", DEPLOY_EVIDENCE_ARTIFACT, "-D", destDir]);
      if (proc.code !== 0) {
        throw new Error(`gh run download failed (${proc.code}): ${proc.stderr.trim()}`);
      }
    },
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/collect-deploy-evidence.ts <merge-sha> [--wait-minutes 15] [--interval-seconds 30]
  MERGE_SHA=<merge-sha> bun run scripts/collect-deploy-evidence.ts`);
}

export type CliDeps = {
  runner?: GhRunner;
  now?: () => number;
  sleep?: (ms: number) => void;
  stdout?: (s: string) => void;
};

/**
 * CLI entry. Returns the process exit code: 0 for every runtime outcome
 * (including degraded), 1 for usage errors only. Injectable deps keep the
 * exit-0 invariant unit-testable without touching `gh` or the network.
 */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: CliDeps = {},
): number {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
  if (parsed.help) {
    printUsage();
    return 0;
  }
  const sha = parsed.sha ?? env["MERGE_SHA"]?.toLowerCase();
  if (!sha) {
    console.error("Usage: bun run scripts/collect-deploy-evidence.ts <merge-sha> (or set MERGE_SHA)");
    return 1;
  }
  // Same gate as positional SHAs (folded task-1 review fix): env-provided
  // values must not bypass the full-SHA validation gh's exact-match relies on.
  if (!FULL_SHA_RE.test(sha)) {
    console.error(
      `Invalid commit SHA: ${sha} (expected the full 40-char merge commit SHA — gh matches runs by exact head SHA)`,
    );
    return 1;
  }
  const write = deps.stdout ?? ((s: string) => process.stdout.write(s));
  let result: CollectResult;
  try {
    result = collectDeployEvidence({
      sha,
      waitMs: parsed.waitMinutes * 60_000,
      intervalMs: parsed.intervalSeconds * 1000,
      runner: deps.runner ?? createGhRunner(),
      now: deps.now,
      sleep: deps.sleep,
      env,
    });
  } catch (err) {
    // Catch-all: an unexpected bug must still not fail the release (exit 0).
    result = { kind: "degraded", section: degradedSection(err, undefined, env) };
  }
  write(result.section + "\n");
  console.error(`collect-deploy-evidence: ${result.kind}`);
  return 0;
}

// Run only when executed directly — importing the module (unit tests) must
// not spawn gh or sleep.
if (import.meta.main) {
  process.exit(runCli(process.argv, process.env));
}
