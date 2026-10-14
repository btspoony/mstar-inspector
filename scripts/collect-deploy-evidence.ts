#!/usr/bin/env bun
/**
 * collect-deploy-evidence.ts — bounded-wait deploy evidence collector.
 * Consumes the evidence chain of one deploy workflow (`--workflow`, default
 * `deploy.yml`; the Release workflow passes `deploy-prod.yml` so the section
 * cites the production deploy): for the
 * release PR's merge commit SHA, wait for that workflow's run to reach a
 * terminal state, download its `deploy-evidence` artifact, and print the
 * markdown section the Release workflow appends to the release notes.
 *
 * Usage:
 *   bun run scripts/collect-deploy-evidence.ts <merge-sha>
 *   MERGE_SHA=<sha> bun run scripts/collect-deploy-evidence.ts
 *   bun run scripts/collect-deploy-evidence.ts <sha> --workflow deploy-prod.yml --ref v1.2.3
 *   bun run scripts/collect-deploy-evidence.ts <sha> --ref v1.2.3 --since-run 12345
 *   bun run scripts/collect-deploy-evidence.ts <sha> --wait-minutes 15 --interval-seconds 30
 *   bun run scripts/collect-deploy-evidence.ts --help
 *
 * Branches (evidence is a recording surface, never a gate):
 *   - run concludes success -> download `deploy-evidence`, print Worker
 *     Version ID + image digest + run link;
 *   - run concludes failure -> explicit failed section (run link);
 *   - timeout with run still in flight -> explicit pending section (run link);
 *   - no run for the SHA after the wait window -> explicit no-run section
 *     (a workflow's paths-ignore can legitimately skip a commit, so the
 *     section states only that no run was created for it).
 *
 * Release identity (`--ref <tag>`): the run set is filtered by workflow +
 * head SHA, which a manual rollback dispatched on the same SHA also matches.
 * `--ref` (the release tag) therefore PREFERS the first (newest) run whose own
 * `headBranch` equals it — and for `deploy-prod.yml` that match is proof of
 * identity, not just of the run's dispatch ref: the workflow takes no `ref`
 * input and refuses a non-tag ref before mutating anything, so a run whose
 * `headBranch` is this tag deployed exactly that tag. When no run matches, the
 * plain newest-for-SHA pick is used and the section says so — the fallback
 * line is what discloses that the reported run did not match the expected ref.
 * Evidence must never degrade to "no run" because of the preference — except
 * above a dispatch boundary, where the fallback is withheld (see below).
 * The `gh run list` lookup asks for an explicit page size (100 rows, never gh's
 * 20-row default): the run set is commit-keyed, and this tag's own run can sit
 * behind many newer runs of other tags for the same commit, so a short page
 * would defeat the preference and publish a foreign-ref run as the evidence.
 *
 * Dispatch boundary (`--since-run <id>`): when the Release dispatches a fresh
 * production deploy it records the highest run id it saw for the commit —
 * ANY ref (the pre-dispatch boundary) — and passes it here. Every ref matters:
 * deploy-prod.yml runs for several tags can share one merge commit (a
 * rollback alias re-deploys a commit another tag already deployed), and only
 * a run this dispatch queued may be cited. Run ids increase monotonically, so
 * the run it just queued is NEWER than every run that existed at dispatch
 * time. The collector then considers ONLY runs whose id is greater than the
 * boundary AND — `ref` being set on this path too — whose own `headBranch`
 * equals it: the boundary alone cannot exclude a FOREIGN tag's run that
 * started between the boundary capture and this dispatch (another release of
 * the same commit), and citing such a run's artifact as this release's
 * evidence would be false. It keeps polling while no matching run is visible —
 * excluding the single newest run is not enough: a superseding dispatch whose
 * older run succeeded would leave that older success selectable and its
 * artifact would be recorded as this release's evidence. With no boundary (the
 * reuse path, a first release with no run for the commit) selection is
 * unchanged, disclosed fallback included. On expiry with nothing matching past
 * the boundary the section says so truthfully and cites no run.
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
/** Deploy workflow the collector reads when `--workflow` is not given (staging). */
export const DEFAULT_DEPLOY_WORKFLOW = "deploy.yml";

/** One run of the collected deploy workflow as reported by `gh run list --json` (null conclusion until completed). */
export type GhRun = {
  databaseId: number;
  status: string;
  conclusion: string | null;
  displayTitle: string;
  /**
   * The ref the run was dispatched/pushed on (`gh run list --json headBranch`).
   * This is what separates the release's own tag-bound run from a manual
   * rollback dispatched on the same commit (see `--ref`).
   */
  headBranch: string;
};

/**
 * The GH-touching layer, injectable so unit tests pin the wait/match/timeout
 * decision logic without network or the `gh` binary.
 */
export type GhRunner = {
  /** `gh run list --workflow <workflow> --commit <sha> --json ...`; throws on gh failure. */
  listRuns(sha: string, workflow: string): GhRun[];
  /** `gh run download <id> -n deploy-evidence -D <dir>`; throws on failure. */
  downloadArtifact(runId: number, destDir: string): void;
};

export type CollectOptions = {
  sha: string;
  /** Deploy workflow file whose runs are collected (e.g. `deploy.yml`, `deploy-prod.yml`). */
  workflow: string;
  /**
   * Expected run ref (the release tag). Preferred when selecting among the
   * runs for `sha`: a manual rollback dispatched on the same commit carries a
   * different `headBranch`. A preference — except alongside `sinceRun`, where
   * it becomes a requirement (only this ref's post-boundary run may be cited).
   */
  ref?: string;
  /**
   * Dispatch boundary: run ids are monotonically increasing, so only runs with
   * a greater id can belong to a deploy dispatched after this boundary was
   * captured. The boundary spans every ref of the commit — a run for another
   * tag on the same commit predates this dispatch too and must not be cited.
   * With `ref` set as well (the dispatch path sets both) a candidate must also
   * be on that ref: a foreign-ref run started above the boundary is not this
   * release's evidence and is never selected, even when already complete.
   * While none matches the wait keeps polling. Unset (the reuse path) leaves
   * selection unchanged.
   */
  sinceRun?: number;
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
  workflow: string;
  ref?: string;
  sinceRun?: number;
  waitMinutes: number;
  intervalSeconds: number;
  help: boolean;
} {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let sha: string | undefined;
  let workflow = DEFAULT_DEPLOY_WORKFLOW;
  let ref: string | undefined;
  let sinceRun: number | undefined;
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
    else if (a === "--workflow" || a.startsWith("--workflow=")) {
      const value = a === "--workflow" ? rest[++i] : a.slice("--workflow=".length);
      // A missing value must never swallow the next flag (`--workflow --help`),
      // and a flag token is never a workflow file name.
      if (!value || value.startsWith("-")) {
        throw new Error(
          `Invalid --workflow value: ${value || "<none>"} (expected a workflow file name)`,
        );
      }
      workflow = value;
    } else if (a === "--ref" || a.startsWith("--ref=")) {
      const value = a === "--ref" ? rest[++i] : a.slice("--ref=".length);
      // Same contract as --workflow: never swallow the next flag. Whitespace
      // and backticks are rejected here because this value is interpolated
      // into a `- ` bullet (see the output contract above).
      if (!value || value.startsWith("-") || /[\s`]/.test(value)) {
        throw new Error(
          `Invalid --ref value: ${value || "<none>"} (expected a ref name, e.g. a release tag)`,
        );
      }
      ref = value;
    } else if (a === "--since-run" || a.startsWith("--since-run=")) {
      const value = a === "--since-run" ? rest[++i] : a.slice("--since-run=".length);
      // Same contract as --workflow/--ref: never swallow the next flag. Run ids
      // are positive integers — a non-numeric value is a usage error, not a
      // silently ignored boundary (ignoring it would let a pre-boundary run be
      // cited as this release's evidence).
      const id = Number(value);
      if (!/^[0-9]+$/.test(value ?? "") || !Number.isSafeInteger(id) || id <= 0) {
        throw new Error(
          `Invalid --since-run value: ${value || "<none>"} (expected a positive run id)`,
        );
      }
      sinceRun = id;
    } else if (a === "--wait-minutes" || a.startsWith("--wait-minutes=")) {
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
  return { sha, workflow, ref, sinceRun, waitMinutes, intervalSeconds, help };
}

/** Run link: `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/<id>`, bare id without the env pair. */
export function runLink(runId: number, env: Record<string, string | undefined>): string {
  const server = env["GITHUB_SERVER_URL"];
  const repo = env["GITHUB_REPOSITORY"];
  if (server && repo) return `${server}/${repo}/actions/runs/${runId}`;
  return String(runId);
}

/**
 * `gh run list` is newest-first. Among the runs for the SHA, prefer the first
 * (newest) run whose own dispatch ref (`headBranch`) equals `ref`: a manual
 * rollback dispatched on the same commit carries a different ref. A match is
 * proof the run deployed exactly `ref` — deploy-prod.yml takes no `ref` input
 * and refuses a non-tag ref, so the ref it runs on is the ref it deploys. When
 * no run matches — or no `ref` was given — fall back to the newest run for the
 * SHA; the preference must never degrade evidence into "no run". `refFallback`
 * records that the fallback happened, so the section can say so.
 *
 * `sinceRun` (the pre-dispatch boundary) filters BOTH selections: a run that
 * already existed when this release dispatched its deploy is not this
 * release's evidence, however successful — a superseding dispatch on a tag
 * whose older run succeeded must not backfill that older success, and a
 * foreign tag's completed run for the same commit (the rollback alias) must
 * not be cited either. Returning
 * `undefined` while only pre-boundary runs are visible is what makes the wait
 * keep polling for the just-dispatched run.
 *
 * With a boundary set a candidate must also match `ref` (the dispatch path
 * always sets both): the newest-for-SHA fallback is a boundless-path
 * behaviour, because the run ids alone cannot exclude a FOREIGN-REF run that
 * started between the boundary capture and the dispatch — a newer run of
 * another tag for the same commit (a rollback alias) is above the boundary
 * too, and citing its artifact as this release's evidence would be a lie. So
 * the fallback is used only when there is no boundary; above one, the
 * collector waits for the requested tag's own run.
 */
function pickRun(
  runs: GhRun[],
  ref?: string,
  sinceRun?: number,
): { run: GhRun; refFallback: boolean } | undefined {
  const selectable =
    sinceRun === undefined ? runs : runs.filter((r) => r.databaseId > sinceRun);
  const newest = selectable[0];
  if (!newest) return undefined;
  if (ref) {
    const matching = selectable.find((r) => r.headBranch === ref);
    if (matching) return { run: matching, refFallback: false };
    // Above the boundary only the requested ref's run may be cited; never
    // fall back to a run whose identity is unproven.
    if (sinceRun !== undefined) return undefined;
    return { run: newest, refFallback: true };
  }
  return { run: newest, refFallback: false };
}

/** States the preference miss explicitly — the cited run did not match the ref the release deployed, so it may not be the release's own deploy. */
function refFallbackLine(ref: string, sha: string): string {
  return `- Run identity: no run on ref \`${ref}\` for commit \`${sha}\` — the newest run for the commit is reported instead, which is not that ref's deploy`;
}

/**
 * The wait each section attributes to itself: the bounded window the collector
 * actually spent, or — for a zero window (a prerelease Release never dispatches,
 * so there is nothing to wait for) — an honest immediate check instead of a
 * rounded-up `~1 min` that never happened.
 */
function waitClause(waitMs: number): string {
  if (waitMs <= 0) return "immediate check";
  return `~${Math.max(1, Math.round(waitMs / 60000))} min bounded wait`;
}

function section(lines: string[]): string {
  return ["### Deploy evidence", ...lines].join("\n");
}

function successSection(
  versionId: string,
  digest: string,
  run: GhRun,
  env: Record<string, string | undefined>,
  extra: string[] = [],
): string {
  return section([
    `- Worker version: \`${versionId}\``,
    `- Image digest: \`${digest}\``,
    `- Actions run: ${runLink(run.databaseId, env)}`,
    ...extra,
  ]);
}

function pendingSection(
  run: GhRun,
  waitMs: number,
  env: Record<string, string | undefined>,
  extra: string[] = [],
): string {
  return section([
    `- Status: pending — deploy run still in flight after the ${waitClause(waitMs)}`,
    `- Actions run: ${runLink(run.databaseId, env)}`,
    ...extra,
  ]);
}

function failedSection(
  run: GhRun,
  env: Record<string, string | undefined>,
  extra: string[] = [],
): string {
  return section([
    `- Status: deploy failed — run concluded "${run.conclusion ?? "unknown"}"; see the run log`,
    `- Actions run: ${runLink(run.databaseId, env)}`,
    ...extra,
  ]);
}

/**
 * No-run cause is workflow-agnostic: `deploy-prod.yml` has no `paths-ignore`,
 * so a filter skip must never be claimed for it (the Release workflow
 * dispatches that run explicitly; absence means no run was created).
 *
 * When runs for the commit exist but none was selectable (`sinceRunId`), "no
 * run was created for this commit" would be false: those runs exist (the
 * superseded deploys, or runs of another ref above the boundary), they are
 * never cited, and what is missing is the run this release dispatched. State
 * the boundary instead — and, with the ref the dispatch always passes, that
 * the awaited run had to be ON it, so a foreign-ref run above the boundary is
 * never presented as this release's evidence.
 */
function noRunSection(
  sha: string,
  workflow: string,
  waitMs: number,
  sinceRunId?: number,
  ref?: string,
): string {
  const status =
    sinceRunId === undefined
      ? `no deploy run for commit \`${sha}\` after the ${waitClause(waitMs)} (no ${workflow} run was created for this commit)`
      : ref === undefined
        ? `no new deploy run for commit \`${sha}\` after the ${waitClause(waitMs)} (no run newer than the dispatch boundary ${sinceRunId} appeared — the superseding ${workflow} run was not yet visible; no pre-boundary run was cited)`
        : `no new deploy run for commit \`${sha}\` on ref \`${ref}\` after the ${waitClause(waitMs)} (no run on that ref newer than the dispatch boundary ${sinceRunId} appeared — the superseding ${workflow} run was not yet visible; no pre-boundary or foreign-ref run was cited)`;
  return section([`- Status: ${status}`]);
}

function degradedSection(
  err: unknown,
  run: GhRun | undefined,
  env: Record<string, string | undefined>,
  extra: string[] = [],
): string {
  const lines = [
    `- Status: unavailable — ${oneLine(err instanceof Error ? err.message : String(err))}`,
  ];
  if (run) lines.push(`- Actions run: ${runLink(run.databaseId, env)}`);
  lines.push(...extra);
  return section(lines);
}

/**
 * Terminal-state handling for a completed run: success downloads the
 * `deploy-evidence` artifact and reads `version_id.txt` + `image_digest.txt`;
 * any artifact-side failure degrades (never fails the release).
 */
function concludeRun(run: GhRun, opts: CollectOptions, refFallback: boolean): CollectResult {
  const env = opts.env ?? process.env;
  const extra = opts.ref && refFallback ? [refFallbackLine(opts.ref, opts.sha)] : [];
  if (run.conclusion !== "success") {
    return { kind: "deploy-failed", section: failedSection(run, env, extra) };
  }
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
    return { kind: "success", section: successSection(versionId, digest, run, env, extra) };
  } catch (err) {
    return { kind: "degraded", section: degradedSection(err, run, env, extra) };
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
  let seenRefFallback = false;
  // Runs for the commit existed but none was selectable — they predate the
  // dispatch boundary, or they are another ref's runs above it: either way the
  // commit does have runs, none may be cited, and the section must say which
  // (never "no run was created").
  let sawExcludedRuns = false;
  for (;;) {
    let picked: { run: GhRun; refFallback: boolean } | undefined;
    try {
      const runs = opts.runner.listRuns(opts.sha, opts.workflow);
      picked = pickRun(runs, opts.ref, opts.sinceRun);
      if (picked === undefined && runs.length > 0) sawExcludedRuns = true;
    } catch (err) {
      // gh missing / auth / network — deterministic enough to surface now
      // rather than burn the whole window retrying (evidence is not a gate).
      const extra = opts.ref && seenRefFallback ? [refFallbackLine(opts.ref, opts.sha)] : [];
      return { kind: "degraded", section: degradedSection(err, seen, env, extra) };
    }
    const run = picked?.run;
    if (run) {
      seen = run;
      seenRefFallback = picked?.refFallback ?? false;
    }
    if (run?.status === "completed") return concludeRun(run, opts, picked?.refFallback ?? false);
    if (now() >= deadline) {
      if (!seen) {
        return {
          kind: "no-run",
          section: noRunSection(
            opts.sha,
            opts.workflow,
            opts.waitMs,
            sawExcludedRuns ? opts.sinceRun : undefined,
            opts.ref,
          ),
        };
      }
      const extra = opts.ref && seenRefFallback ? [refFallbackLine(opts.ref, opts.sha)] : [];
      return { kind: "pending", section: pendingSection(seen, opts.waitMs, env, extra) };
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
    listRuns(sha: string, workflow: string): GhRun[] {
      const proc = gh([
        "run",
        "list",
        "--workflow",
        workflow,
        "--commit",
        sha,
        // Explicit page size, never gh's 20-row default: this is the same
        // commit-keyed lookup the Release step performs, and it must see a
        // same-tag run that can sit behind many newer runs of OTHER tags for
        // the commit (a commit rolled back to repeatedly accumulates them). A
        // hidden same-tag run would leave the ref preference unmatched, so the
        // section would cite a foreign-ref run through the disclosed fallback
        // instead of this release's own deploy. `gh` returns runs newest-first,
        // so the page is also what `--since-run` reads as the newest run id.
        "--limit",
        "100",
        "--json",
        "status,conclusion,databaseId,displayTitle,headBranch",
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
  bun run scripts/collect-deploy-evidence.ts <merge-sha> [--workflow deploy.yml] [--ref <tag>] [--since-run <id>] [--wait-minutes 15] [--interval-seconds 30]
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
    printUsage();
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
      workflow: parsed.workflow,
      ref: parsed.ref,
      sinceRun: parsed.sinceRun,
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
