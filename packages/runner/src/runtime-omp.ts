import { existsSync } from "node:fs";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentRegistry,
  createAgentSession,
  loadSkillsFromDir,
  SessionManager,
  Settings,
  type AgentSession,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type Skill,
  type ToolSession,
} from "@oh-my-pi/pi-coding-agent";
import { runStructuredSubagent, type StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
  MERGE_CLASSES,
  PR_REVIEW_NUDGE_CADENCE,
  PR_REVIEW_TIER_BUDGETS,
  PR_SCORE_BANDS,
  PR_VERDICTS,
  prReviewSeatPrompt,
  synthesizeReview,
  validateMstarReviewV1,
  type MstarReviewFinding,
  type MstarReviewV1,
} from "@mstar-harness/engine";
import { PR_DIFF_PATH, REVIEW_SEATS, RUNNER_MAX_BUDGET_MS, type AgentRuntime, type AgentRuntimeRunInput, type ReviewLevel, type ReviewRunResult } from "../../shared/src/runtime";
import {
  PUBLICATION_TAIL_MS,
  remainingOuterMs,
  remainingSoftMinutes,
  runRecheckSeat,
  type RecheckSeatResult,
} from "./recheck";
import {
  REPORT_TAIL_MARGIN_MS,
  runReportSeat,
  revalidatedNotes,
  type ReportSeatEmptyReason,
} from "./report";
import type { PrContext, ReportDoc } from "../../shared/src/report-wire";
import type { ReviewCoverage } from "../../shared/src/coverage-wire";
import { RECHECK_MIN_REMAINING_MS, type RecheckDoc } from "../../shared/src/recheck-wire";
import { ReviewNoOutputFailure, RunnerBudgetExhausted } from "../../shared/src/budget-exhausted-wire";
import {
  bucketsFromSession,
  bucketsFromSubagents,
  deepTokenUsage,
  mergeBuckets,
  type SubagentUsageSource,
} from "./token-usage";
import type { SessionEntry, UsageStatistics } from "@oh-my-pi/pi-coding-agent";
import type { TokenUsageBucket } from "../../shared/src/token-usage-wire";

const HARNESS_ROOT_ENV = "HARNESS_PLUGIN_ROOT";

/**
 * Resolve the local mstar-harness plugin root, in priority order:
 *   1. $HARNESS_PLUGIN_ROOT — explicit configuration (primary surface);
 *   2. the sibling directory `mstar-harness` next to the repository root
 *      (three levels up from this file: src → runner → packages → root).
 * There is no machine-absolute fallback: an unresolvable root fails closed
 * and names the env var to set. M0 never installs from GitHub. Resolved
 * lazily per call so tests can inject a fixture root regardless of module
 * evaluation order.
 */
export function resolveHarnessRoot(): string {
  const fromEnv = Bun.env[HARNESS_ROOT_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const sibling = resolve(import.meta.dir, "../../../../mstar-harness");
  if (existsSync(sibling)) return sibling;
  throw new Error(
    `mstar-harness plugin root not found: set ${HARNESS_ROOT_ENV} to the plugin checkout (no sibling checkout at ${sibling})`,
  );
}

/** Read-only tool whitelist (Global Constraints — parent + seat). */
export const REVIEW_TOOL_NAMES = ["read", "grep", "glob"] as const;

function primaryModelSelector(input: AgentRuntimeRunInput): string {
  const first = input.modelSelectors[0];
  if (first === undefined) {
    throw new Error("runner input carries no model selector — the App's model chain must name one");
  }
  return first;
}

/**
 * Parse the OMP_REVIEW_MODEL value into model selectors: comma-separated,
 * trimmed, empty entries dropped. `undefined`/empty → `[]` (the default
 * model pattern is used, no fallback chain configured).
 */
export function parseModelSelectors(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

function traceStage(stage: string): void {
  console.error(JSON.stringify({ event: "review_stage", stage }));
}

const STAGE_SLUG_MAX_CHARS = 20;

function stageSlug(text: string | undefined, maxChars = STAGE_SLUG_MAX_CHARS): string {
  if (text === undefined) return "";
  return text.replace(/\s+/g, "-").replace(/[^\w.:=-]/g, "").slice(0, maxChars);
}

/**
 * Compact per-seat trace id. Seat labels can reach 48 characters and the
 * worker's stage field is 60, so a full `<domain>-<seat>` id would push the cap
 * reason or turn count out of the field and lose the one fact the stage exists
 * for. The ordinal keeps ids distinct within a run; the truncated id keeps them
 * recognisable.
 */
export function seatTraceId(index: number, id: string): string {
  return `${index + 1}-${id.slice(0, 22)}`;
}

/**
 * Per-seat trace tokens. `traceStage` marks ENTRY, and the worker prints the
 * LAST line — so a seat's terminal token is emitted when it settles, not when
 * it starts, and it must say which of the three outcomes happened: a payload
 * (with its turn count), a cap gap (window + window's turn count when known),
 * or a failure.
 */
export function seatStartStage(seat: string): string {
  return `seat_start:${seat}`;
}

export function seatDoneStage(seat: string, turns: number | undefined): string {
  return turns === undefined ? `seat_done:${seat}` : `seat_done:${seat}:turns=${turns}`;
}

export function seatGapStage(seat: string, reason: string | undefined, turns?: number): string {
  const suffix = turns === undefined ? "" : `:turns=${turns}`;
  const capMs = reason?.match(/task\.maxRuntimeMs=(\d+)/)?.[1];
  if (capMs !== undefined) return `seat_gap:${seat}:cap:${capMs}ms${suffix}`;
  const slug = stageSlug(reason, 12);
  return slug === "" ? `seat_gap:${seat}${suffix}` : `seat_gap:${seat}:${slug}${suffix}`;
}

export function seatFailedStage(seat: string, cause: string | undefined): string {
  const slug = stageSlug(cause, 12);
  return slug === "" ? `seat_failed:${seat}` : `seat_failed:${seat}:${slug}`;
}

/** The recheck seat's terminal token: its turn count, or why it ended empty. */
export function recheckStage(result: RecheckSeatResult): string {
  if (result.doc !== null) return `recheck_done:turns=${result.usage?.requests ?? 0}`;
  return `recheck_gap:${result.status.outcome}${result.status.reason === undefined ? "" : `-${result.status.reason}`}`;
}

/**
 * The report seat's terminal token. Three distinct outcomes, never collapsed:
 * a document (with its turn count) or a seat that RAN and produced nothing.
 * A run that never attempted the seat emits `report_skip:<reason>` instead and
 * no `report_start` — see `reportEligibility`.
 */
export function reportStage(report: unknown, turns: number | undefined): string {
  return report === null ? "report_absent" : turns === undefined ? "report_done" : `report_done:turns=${turns}`;
}

export function reportSkipStage(reason: string): string {
  return `report_skip:${reason}`;
}

/** The report seat started and the run was torn down under it (not a failure). */
export const REPORT_ABORTED_STAGE = "report_aborted";

export function reportFailedStage(cause: string | undefined): string {
  const slug = stageSlug(cause, 12);
  return slug === "" ? "report_failed" : `report_failed:${slug}`;
}

function tracedRecheck(work: Promise<RecheckSeatResult>): Promise<RecheckSeatResult> {
  traceStage("recheck_start");
  return work.then(
    (result) => {
      traceStage(recheckStage(result));
      return result;
    },
    (error: unknown) => {
      traceStage(seatFailedStage("recheck", causeText(error)));
      throw error;
    },
  );
}

async function tracedReportSeatFor(
  input: AgentRuntimeRunInput,
  getSession: () => Promise<ToolSession>,
  envelope: MstarReviewV1,
  recheckDoc: RecheckDoc | null,
  signal: AbortSignal,
  usage: SubagentUsageSource[] = [],
): Promise<ReportDoc | null> {
  const eligibility = reportEligibility(input, envelope, signal);
  if (!eligibility.ok) {
    console.error(JSON.stringify({ event: "report_skipped", reason: eligibility.reason }));
    traceStage(reportSkipStage(eligibility.reason));
    return null;
  }
  traceStage("report_start");
  let empty: ReportSeatEmptyReason | undefined;
  let report: ReportDoc | null = null;
  try {
    const session = await getSession();
    report = await runReportSeatFor(input, session, envelope, recheckDoc, signal, usage, (reason) => {
      empty = reason;
    });
  } catch (error) {
    traceStage(reportFailedStage(causeText(error)));
    return null;
  }
  traceStage(
    report !== null
      ? reportStage(report, usage[0]?.requests)
      : empty === "no-document"
        ? reportStage(null, undefined)
        : REPORT_ABORTED_STAGE,
  );
  return report;
}

export async function loadHarnessSkills(pluginRoot: string): Promise<Skill[]> {
  const { skills, warnings } = await loadSkillsFromDir({
    dir: join(pluginRoot, "skills"),
    source: "mstar-harness",
  });
  if (!skills.some((skill) => skill.name === "mstar-audit")) {
    const detail = warnings.map((w) => w.message).join("; ");
    throw new Error(
      `mstar-harness plugin at ${pluginRoot} does not expose the mstar-audit skill` +
        (detail ? ` (warnings: ${detail})` : ""),
    );
  }
  return skills;
}

function baseIsolationSettings(fallbackChain: string[] | undefined): {
  "fetch.enabled": false;
  "retry.modelFallback": true;
  "retry.fallbackChains": { default: string[] };
} {
  return {
    "fetch.enabled": false,
    "retry.modelFallback": true,
    "retry.fallbackChains": { default: fallbackChain ?? [] },
  };
}

/**
 * note: quick/default parent session options — migrated from the M1
 * src/review/session.ts with `appendSystemPrompt` REMOVED (the seat prompts
 * are engine-generated; this parent never prompts a model). Everything else
 * is the M1 isolation set: in-memory session, read-only tool whitelist, no
 * outbound fetch, local plugin root, explicit skills, and the caller's model
 * retry fallback chain (the full selector list rides as
 * retry.fallbackChains.default — the SDK slices the chain after the active
 * model, session/turn-recovery.ts:1455). The deep parent (deepSessionOptions)
 * spreads this and adds the deep-only deltas on top.
 */
export function buildSessionOptions(opts: {
  cwd: string;
  pluginRoot: string;
  skills: Skill[];
  modelPattern: string;
  fallbackChain?: string[];
  agentDir: string;
  authStorage: AuthStorage;
}): CreateAgentSessionOptions {
  return {
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(opts.cwd),
    settings: Settings.isolated(baseIsolationSettings(opts.fallbackChain)),
    restrictToolNames: true,
    toolNames: [...REVIEW_TOOL_NAMES],
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [opts.pluginRoot],
    skills: opts.skills,
    modelPattern: opts.modelPattern,
    enableMCP: false,
    enableLsp: false,
    requireYieldTool: false,
    autoApprove: true,
    agentDir: opts.agentDir,
    authStorage: opts.authStorage,
  };
}

function asToolSession(session: AgentSession, cwd: string): ToolSession {
  return new Proxy(session, {
    get(target, prop) {
      if (prop === "cwd") return cwd;
      if (prop === "hasUI") return false;
      if (prop === "getSessionFile") return () => null;
      if (prop === "getSessionSpawns") return () => null;
      if (prop === "effectiveExtensionRoots") {
        const roots: unknown = Reflect.get(target, prop, target);
        return typeof roots === "function" ? (roots as () => unknown).bind(target) : () => roots;
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ToolSession;
}

const REVIEW_FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mergeClass", "title", "body"],
  properties: {
    mergeClass: { enum: [...MERGE_CLASSES] },
    title: { type: "string" },
    body: { type: "string" },
    category: { type: "string" },
    file_path: { type: ["string", "null"] },
    line_start: { type: ["integer", "null"] },
    line_end: { type: ["integer", "null"] },
    fingerprint_hint: { type: "string" },
  },
} as const;

const INCOMPLETE_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "unscanned"],
  properties: {
    reason: { type: "string" },
    unscanned: { type: "array", items: { type: "string" } },
  },
} as const;

const SEAT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
  },
} as const;

const PARENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "verdict", "findings"],
  properties: {
    schema: { enum: ["mstar.review/v1"] },
    verdict: { enum: [...PR_VERDICTS] },
    summary_md: { type: "string" },
    findings: { type: "array", items: REVIEW_FINDING_SCHEMA },
    tally: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "scorePct", "tally", "chatHeader"],
      properties: {
        verdict: { enum: [...PR_VERDICTS] },
        scorePct: { type: "integer" },
        band: { enum: [...PR_SCORE_BANDS] },
        tally: {
          type: "object",
          additionalProperties: false,
          required: ["mustFix", "shouldFix", "nit"],
          properties: {
            mustFix: { type: "integer" },
            shouldFix: { type: "integer" },
            nit: { type: "integer" },
          },
        },
        chatHeader: { type: "string" },
        incomplete: INCOMPLETE_FACT_SCHEMA,
      },
    },
    target: {
      type: "object",
      additionalProperties: false,
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "integer" },
        head_sha: { type: "string" },
      },
    },
    incomplete: INCOMPLETE_FACT_SCHEMA,
  },
} as const;

type SeatOutput = {
  findings: MstarReviewFinding[];
};

/** One deterministic seat: prompt labels + the changed-file scope it reviews. */
export type SeatPlan = {
  domain: string;
  seat: string;
  scope: readonly string[];
};

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

const PR_FACT_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;

const HEAD_FACT_RE = /^head ([0-9a-f]{7,64})$/;

type ChangedFile = { path: string; lines: number };

function parseChangedFiles(reconFacts: readonly string[]): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const fact of reconFacts) {
    const match = NUMSTAT_RE.exec(fact);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const deleted = match[2] === "-" ? 0 : Number(match[2]);
    files.push({ path: match[3]!, lines: added + deleted });
  }
  return files;
}

/** Fold `owner/repo#pr` and `head <sha>` recon facts into the envelope target. */
export function parseTarget(reconFacts: readonly string[]): MstarReviewV1["target"] {
  let target: MstarReviewV1["target"] | undefined;
  for (const fact of reconFacts) {
    const prMatch = PR_FACT_RE.exec(fact);
    if (prMatch) {
      target = { ...target, owner: prMatch[1], repo: prMatch[2], pr: Number(prMatch[3]) };
      continue;
    }
    const headMatch = HEAD_FACT_RE.exec(fact);
    if (headMatch) {
      target = { ...target, head_sha: headMatch[1] };
    }
  }
  return target;
}

function topDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

function seatLabel(dirs: readonly string[]): string {
  const label = [...dirs].sort().join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return label.length === 0 ? "combined" : label.slice(0, 48);
}

/**
 * Deterministic seat partition (spec § 席位范围规则 — no LLM dispatch) into
 * exactly `seats` plans (quick is always 1):
 *   1 seat → one seat covering everything (domain `full-diff`, seat
 *   `combined`) at any level;
 *   2 seats → cluster changed files by top-level directory, then merge the
 *   clusters into two groups balanced on changed lines (longest-processing-
 *   time greedy); degenerate inputs (fewer than 2 files, or a single cluster)
 *   fall back to sorted-path halves with domains `changeset-1`/`changeset-2`.
 *   An empty universe (no numstat facts) gives both seats full coverage —
 *   overlap is allowed and the merge step dedupes.
 * Any request the level cannot fulfil — above its own count, or fewer than
 * one seat — throws rather than silently widening or starving the tier.
 */
export function partitionSeats(reconFacts: readonly string[], level: ReviewLevel, seats: number): SeatPlan[] {
  const files = parseChangedFiles(reconFacts);
  const plans =
    level === "quick" || seats === 1
      ? [{ domain: "full-diff", seat: "combined", scope: files.map((file) => file.path).sort() }]
      : partitionTwoSeats(files);
  if (plans.length !== seats) {
    throw new Error(`seat partition produced ${plans.length} seats for level ${level} (expected ${seats})`);
  }
  return plans;
}

function partitionTwoSeats(files: readonly ChangedFile[]): SeatPlan[] {
  const degenerateHalves = (): SeatPlan[] => {
    const paths = files.map((file) => file.path).sort();
    const half = Math.ceil(paths.length / 2);
    const first = paths.slice(0, half);
    const second = paths.slice(half);
    return [
      { domain: "changeset-1", seat: "part-1", scope: first },
      { domain: "changeset-2", seat: "part-2", scope: second.length > 0 ? second : first },
    ];
  };

  const clusters = new Map<string, { paths: string[]; lines: number }>();
  for (const file of files) {
    const dir = topDir(file.path);
    const cluster = clusters.get(dir) ?? { paths: [], lines: 0 };
    cluster.paths.push(file.path);
    cluster.lines += file.lines;
    clusters.set(dir, cluster);
  }
  if (clusters.size === 1) {
    return degenerateHalves();
  }

  const sorted = [...clusters.entries()].sort(
    ([dirA, a], [dirB, b]) => b.lines - a.lines || dirA.localeCompare(dirB),
  );
  const groups = [
    { dirs: [] as string[], paths: [] as string[], lines: 0 },
    { dirs: [] as string[], paths: [] as string[], lines: 0 },
  ];
  for (const [dir, cluster] of sorted) {
    const target = groups[1]!.lines < groups[0]!.lines ? groups[1]! : groups[0]!;
    target.dirs.push(dir);
    target.paths.push(...cluster.paths);
    target.lines += cluster.lines;
  }
  return [
    { domain: "changeset-1", seat: seatLabel(groups[0]!.dirs), scope: groups[0]!.paths.sort() },
    { domain: "changeset-2", seat: seatLabel(groups[1]!.dirs), scope: groups[1]!.paths.sort() },
  ];
}

function seatReconFacts(reconFacts: readonly string[], plan: SeatPlan): string[] {
  if (plan.scope.length === 0) return [...reconFacts];
  return [...reconFacts, `File scope for this seat (review ONLY these files):`, ...plan.scope];
}

function budgetMinutes(remainingMinutes: number): number {
  return remainingMinutes >= 0 ? Math.round(remainingMinutes) : -Math.max(1, Math.round(-remainingMinutes));
}

function dispatchBudgetMinutes(level: ReviewLevel): number {
  return budgetMinutes(remainingSoftMinutes(Date.now(), level));
}

const SEAT_WATCH_TICK_MS = 250;

/**
 * Why the message keeps the `task.maxRuntimeMs` token: `seatOutput` reads a
 * cap stop from that exact vocabulary — the executor's own wall-clock timer
 * is DISABLED for review seats (the seat's clock starts at its FIRST model
 * turn, which the SDK timer, ticking from spawn, cannot see), so the runner's
 * own watchdog stamps the same sentence the cap regex proves.
 */
export function seatCapAbortError(windowMs: number): Error {
  return new Error(`Subagent runtime limit exceeded (task.maxRuntimeMs=${windowMs})`);
}

/**
 * Why every seat owns the FULL tier ceiling, never a divided share: dividing
 * one ceiling across the wave makes two slow seats die at half a window each —
 * exactly the failure this pipeline exists to remove. A seat's window is
 * therefore independent of its siblings, so a seat finishing early changes
 * nothing about a sibling's deadline (there is no share to release), and the
 * only bound above the ceiling is the attempt's absolute deadline less the
 * publication tail.
 *
 * The seat's own clock starts at its FIRST REAL model turn (`firstTurnMs`),
 * never at dispatch: session setup and the skill load are paid by the run, not
 * out of the seat's thinking time. The ceiling is the RUNNER's tier maximum
 * (`RUNNER_MAX_BUDGET_MS`), not the engine's wall-clock table, which is shorter
 * for `quick` (300 s against 480 s). The deep parent keeps the legacy ×2
 * headroom because its soft cap is a convergence target its own supervision
 * nudges enforce — the hard window must let the steer past the soft cap land
 * instead of cutting the turn mid-yield.
 */
export function seatDeadlineMs(nowMs: number, firstTurnMs: number, level: ReviewLevel): number {
  const ceilingMs = RUNNER_MAX_BUDGET_MS[level] * (level === "deep" ? 2 : 1);
  return Math.min(firstTurnMs + ceilingMs, nowMs + remainingOuterMs(nowMs, level) - PUBLICATION_TAIL_MS);
}

/**
 * Before its first real model turn a seat has no thinking clock yet, so its
 * only bound is the attempt's absolute deadline less the publication tail. A
 * seat that never emits a turn (a wedged child, a monitor that never reports)
 * must still be stoppable — disabling the SDK timer may never leave the signal
 * unbounded.
 */
export function preTurnDeadlineMs(nowMs: number, level: ReviewLevel): number {
  return nowMs + remainingOuterMs(nowMs, level) - PUBLICATION_TAIL_MS;
}

/**
 * One seat's cap owner: a ticking watchdog plus the controller whose signal
 * the seat consumes. `markFirstTurn` anchors the clock at the seat's first REAL
 * model turn; `stop` clears the tick once the seat settles.
 */
export type SeatWatch = {
  controller: AbortController;
  markFirstTurn: () => void;
  stop: () => void;
};

/**
 * How the first real model turn is recognised: `progress.status === "running"`
 * is the monitor's INITIAL state (set before any model call, e.g. on a task
 * label or a bare session event), so it can never start the clock. The SDK
 * counts assistant message_end events in `progress.requests`; the first turn is
 * the first snapshot with `requests >= 1`, which no label or session event
 * produces.
 */
export function startsFirstTurn(progress: { status: string; requests?: number }): boolean {
  return progress.status === "running" && (progress.requests ?? 0) >= 1;
}

export function startSeatWatch(level: ReviewLevel, startedMs = Date.now()): SeatWatch {
  const controller = new AbortController();
  let firstTurnMs: number | undefined;
  const timer = setInterval(() => {
    if (controller.signal.aborted) return;
    const now = Date.now();
    const deadline =
      firstTurnMs === undefined ? preTurnDeadlineMs(now, level) : seatDeadlineMs(now, firstTurnMs, level);
    if (now >= deadline) {
      const windowMs = deadline - (firstTurnMs ?? startedMs);
      controller.abort(seatCapAbortError(Math.max(1, Math.round(windowMs))));
    }
  }, SEAT_WATCH_TICK_MS);
  return {
    controller,
    markFirstTurn: () => {
      if (firstTurnMs === undefined) firstTurnMs = Date.now();
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * note: One progress nudge for a seat that is still running. The engine owns the
 * cadence and the tier figures; the harness `/amazing-pr-review` § Seat
 * supervision owns the model-facing procedure — this type carries only what the
 * delivery itself needs.
 */
export type SeatNudge = {
  text: string;
  deliverAs: "aside" | "steer";
};

/** note: One supervised seat: its address, whether it is still running, and how a nudge reaches it. */
export type SupervisedSeat = {
  id: string;
  isRunning: () => boolean;
  deliver: (nudge: SeatNudge) => Promise<void>;
};

function seatNudge(nowMs: number, level: ReviewLevel): SeatNudge & { intervalMs: number } {
  const remaining = remainingSoftMinutes(nowMs, level);
  const overrun = remaining < 0;
  const minutes = budgetMinutes(remaining);
  return {
    intervalMs: (overrun ? PR_REVIEW_NUDGE_CADENCE.overrunSeconds : PR_REVIEW_NUDGE_CADENCE.normalSeconds) * 1000,
    deliverAs: overrun ? "steer" : "aside",
    text: [
      `Review clock: ${overrun ? `${-minutes} min over` : `${minutes} min left of`} the`,
      `${PR_REVIEW_TIER_BUDGETS[level].wallClockMinutes} min ${level} soft cap.`,
      "Converge now: stop expanding scope, summarize what you already have and",
      "return it, and declare the scope you did not get to. Do not start new",
      "work — a partial result with its unscanned scope declared is expected.",
    ].join(" "),
  };
}

function waitTick(intervalMs: number, done: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), intervalMs);
    void done.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

type NudgeableSession = {
  readonly isStreaming: boolean;
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" | "aside" }): Promise<boolean>;
  steer(text: string): Promise<void>;
};

async function nudgeSession(session: NudgeableSession | null | undefined, nudge: SeatNudge): Promise<void> {
  if (!session?.isStreaming) return;
  if (nudge.deliverAs === "aside") {
    await session.prompt(nudge.text, { streamingBehavior: "aside" });
    return;
  }
  await session.steer(nudge.text);
}

/**
 * note: Keep every seat that is still running moving on the engine cadence until the
 * work it supervises settles. Supervision is fire-and-observe: its effects are
 * messages, and a failed delivery is logged, never thrown (non-fatal is the
 * contract). A seat leaves the tick set the moment ITS OWN promise settles
 * (`isRunning`), and the loop itself ends with `done` — the fan-out or the deep
 * parent turn, whichever it supervises — so no later tick can restart a seat
 * that already returned.
 */
export async function superviseSeats(opts: {
  seats: readonly SupervisedSeat[];
  level: ReviewLevel;
  done: Promise<void>;
}): Promise<void> {
  for (;;) {
    if (await waitTick(seatNudge(Date.now(), opts.level).intervalMs, opts.done)) return;
    const nudge = seatNudge(Date.now(), opts.level);
    for (const seat of opts.seats) {
      if (!seat.isRunning()) continue;
      try {
        await seat.deliver({ text: nudge.text, deliverAs: nudge.deliverAs });
      } catch (error) {
        console.error("review seat nudge failed", seat.id, error);
      }
    }
  }
}

/**
 * The pinned unified-diff snapshot the consumer captured beside the clone, or
 * `undefined` when no file is present (a capture failure round or a hand-run
 * checkout). The diff is never inlined: the consumer's 2 MiB prefetch cap is
 * far above a seat's read budget, and the file path — not its text — is the
 * read-first ingredient. `MSTAR_REVIEW_DIFF_PATH` redirects the lookup for
 * host-side tests only; the image always writes the fixed path.
 */
export function seatDiffFile(): string | undefined {
  const candidate = Bun.env.MSTAR_REVIEW_DIFF_PATH ?? PR_DIFF_PATH;
  return existsSync(candidate) ? candidate : undefined;
}

function seatAssignment(input: AgentRuntimeRunInput, pluginRoot: string, plan: SeatPlan): string {
  const diffFile = seatDiffFile();
  return prReviewSeatPrompt({
    stage: 2,
    domain: plan.domain,
    seat: plan.seat,
    skillRoot: `${pluginRoot}/skills/mstar-audit`,
    worktreePath: input.worktreePath,
    reconFacts: seatReconFacts(input.reconFacts, plan),
    tier: input.level,
    ...(diffFile === undefined ? {} : { diffFile }),
    budgetRemainingMinutes: dispatchBudgetMinutes(input.level),
  });
}

type SeatGap = { plan: SeatPlan; reason?: string };

function watchdogCapReason(watch: SeatWatch): string | undefined {
  const signal = watch.controller.signal;
  return signal.aborted ? causeText(signal.reason) : undefined;
}

type SeatOutcome = {
  output: SeatOutput | null;
  gap: SeatGap | null;
  failure: Error | null;
};

/**
 * note: The published review's `summary_md` budget in characters. The consumer
 * truncates the summary to this many characters KEEPING THE HEAD
 * (`src/pipeline/comment.ts`: SUMMARY_MD_LIMIT / `truncateSummary`), so anything
 * the coverage notes push past it is lost from the END. Restated here with the
 * publisher named because the in-image runner graph may not import that workerd
 * face — the notes below have to fit inside the same budget.
 */
export const SUMMARY_MD_BUDGET = 8_000;

/**
 * note: Characters one capped seat's coverage line may spend, scope list included.
 * Bounding lines by CHARACTERS (not by a file count) keeps a long path from
 * crowding the line — or a second capped seat — out of the published body; a
 * disclosure longer than this (an outsized stop reason) is cut with a marker.
 */
export const SEAT_GAP_MAX_CHARS = 400;

function fittedSummary(summary: string, budget: number): string {
  if (summary.length <= budget) return summary;
  const marker = "\n… (summary truncated)";
  const room = budget - marker.length;
  return room > 0 ? `${summary.slice(0, room)}${marker}` : `${summary.slice(0, Math.max(0, budget - 1))}…`;
}

function causeText(reason: unknown): string {
  const text = String(reason instanceof Error ? reason.message : reason)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= SEAT_GAP_MAX_CHARS ? text : `${text.slice(0, SEAT_GAP_MAX_CHARS - 1)}…`;
}

const RUNTIME_LIMIT_ABORT_RE = /Subagent runtime limit exceeded \(task\.maxRuntimeMs=[^)]+\)/;

/**
 * The runner-log line naming a capped seat and WHY it stopped. Exported so the
 * test suite can pin the exact failure text without intercepting a module-bound
 * console: the reason is the only evidence a zero-output round has.
 */
export function seatStopLine(seat: string, reason: string | undefined): string {
  return `review seat ${seat} stopped by cap${reason === undefined ? "" : `: ${reason}`}`;
}

function seatOutput(result: StructuredSubagentResult, index: number, plan: SeatPlan): SeatOutcome {
  const single = result.result;
  const structured = single.structuredOutput;
  const collected =
    structured?.status === "valid" && structured.data !== undefined ? (structured.data as SeatOutput) : null;
  const rejectedPayload =
    single.error !== undefined ||
    (structured !== undefined && (structured.status !== "valid" || structured.data === undefined));
  const stoppedByCap = single.abortReason?.match(RUNTIME_LIMIT_ABORT_RE)?.[0];
  if (stoppedByCap !== undefined) {
    return { output: rejectedPayload ? null : collected, gap: { plan, reason: stoppedByCap }, failure: null };
  }
  if (single.error) {
    return {
      output: null,
      gap: null,
      failure: new Error(`review seat ${index} (${single.agent}) failed: ${single.error}`),
    };
  }
  if (collected === null) {
    const detail = structured?.error ?? single.stderr.slice(-200);
    return {
      output: null,
      gap: null,
      failure: new Error(
        `review seat ${index} (${single.agent}) produced no valid structured output` +
          `(status ${structured?.status ?? "absent"})${detail ? `: ${detail}` : ""}`,
      ),
    };
  }
  return { output: collected, gap: null, failure: null };
}

function findingFingerprint(finding: MstarReviewFinding): string {
  return finding.fingerprint_hint ?? `${finding.file_path}:${finding.line_start}:${finding.title}`;
}

/**
 * note: Merge seat outputs: exact-dedupe findings by fingerprint (first seat wins).
 */
export function mergeSeatOutputs(outputs: readonly SeatOutput[]): MstarReviewFinding[] {
  const findings = new Map<string, MstarReviewFinding>();
  for (const output of outputs) {
    for (const finding of output.findings ?? []) {
      const fingerprint = findingFingerprint(finding);
      if (!findings.has(fingerprint)) {
        findings.set(fingerprint, finding);
      }
    }
  }
  return [...findings.values()];
}

const SEAT_AGENT_FILE = "mstar-review-seat.md";

async function installSeatAgent(cwd: string): Promise<void> {
  const definition = await readFile(join(import.meta.dir, "seat-agent.md"), "utf8");
  const agentsDir = join(cwd, ".omp", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, SEAT_AGENT_FILE), definition);
}

/**
 * why: Deep Stage 2 seat roles (harness pr-review § Review pipeline): the
 * three-stage flow dispatches exactly these harness roles as domain seats
 * (each carrying the in-domain security lens). Installing ONLY these keeps
 * the task-tool agent schema minimal, and the cleanup set static. Exported
 * for the dashboard-side MODEL_ROLE_IDS parity lock — the test
 * import does not widen the dashboard's own import boundary).
 */
export const DEEP_SEAT_ROLES = ["code-reviewer", "fullstack-dev", "frontend-dev"] as const;

const DEEP_SEAT_ROLE_FILES: readonly string[] = DEEP_SEAT_ROLES.map((role) => `${role}.md`);

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  return normalized.slice(end + 4).trim();
}

function toOmpSeatDefinition(role: string, source: string): string {
  const body = stripFrontmatter(source);
  return [
    "---",
    `name: ${role}`,
    `description: Read-only deep-review seat for the ${role} harness role — collects and vets review findings for its assigned domain using only read, grep, and glob.`,
    `tools: [${[...REVIEW_TOOL_NAMES, "yield"].join(", ")}]`,
    "structured: true",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function installDeepSeatAgents(cwd: string, pluginRoot: string): Promise<void> {
  const agentsDir = join(cwd, ".omp", "agents");
  await mkdir(agentsDir, { recursive: true });
  for (const role of DEEP_SEAT_ROLES) {
    let source: string;
    try {
      source = await readFile(join(pluginRoot, "agents", `${role}.md`), "utf8");
    } catch {
      throw new Error(`mstar-harness plugin at ${pluginRoot} is missing the deep seat role agents/${role}.md`);
    }
    await writeFile(join(agentsDir, `${role}.md`), toOmpSeatDefinition(role, source));
  }
}

async function removeInstalledAgents(cwd: string, names: readonly string[]): Promise<void> {
  await Promise.all(names.map((name) => rm(join(cwd, ".omp", "agents", name), { force: true }).catch(() => {})));
  await rmdir(join(cwd, ".omp", "agents")).catch(() => {});
  await rmdir(join(cwd, ".omp")).catch(() => {});
}

async function withoutGitHubTokenEnv<T>(review: () => Promise<T>): Promise<T> {
  const savedGhToken = process.env.GH_TOKEN;
  const savedGithubToken = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    return await review();
  } finally {
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
    if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithubToken;
  }
}
function deepSessionOptions(opts: {
  cwd: string;
  pluginRoot: string;
  skills: Skill[];
  modelPattern: string;
  fallbackChain?: string[];
  agentModelOverrides?: Record<string, string>;
  agentDir: string;
  authStorage: AuthStorage;
}): CreateAgentSessionOptions {
  const overrides = opts.agentModelOverrides;
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  return {
    ...buildSessionOptions(opts),
    ...(hasOverrides
      ? {
          settings: Settings.isolated({
            ...baseIsolationSettings(opts.fallbackChain),
            "task.agentModelOverrides": { ...overrides },
          }),
        }
      : {}),
    toolNames: [...REVIEW_TOOL_NAMES, "task"],
    outputSchema: PARENT_OUTPUT_SCHEMA,
    outputSchemaMode: "strict",
    requireYieldTool: true,
  };
}

async function deepAssignment(input: AgentRuntimeRunInput, pluginRoot: string): Promise<string> {
  const command = await readFile(join(pluginRoot, "commands", "amazing-pr-review.md"), "utf8");
  const capMinutes = PR_REVIEW_TIER_BUDGETS[input.level].wallClockMinutes;
  const remainingMinutes = dispatchBudgetMinutes(input.level);
  return [
    "Review budget — the shared soft clock this session must finish inside:",
    `- Tier: \`${input.level}\` — review strength for this session.`,
    `- Soft wall-clock cap: ${capMinutes} min for the WHOLE review — one shared`,
    "  clock started when the runner began this review, not a fresh per-seat",
    `  allowance (${remainingMinutes} min left when this session was dispatched;`,
    "  a negative figure means the review is already over its cap).",
    "- The cap is SOFT: reaching it aborts nothing, so the turn keeps going —",
    "  but as you approach it, stop expanding, summarize what you already have",
    "  and return it. The hard deadline DOES stop this turn: a turn the outer",
    "  budget kills ends as a budget failure, not a review. Yielding is",
    "  MANDATORY before that line: ending without a valid `yield` fails the",
    "  whole review. Return a partial review that declares its unscanned scope",
    "  — never empty.",
    "- You are the parent the caller can reach: the `task` seats you dispatch",
    "  yourself are invisible to it, so supervising them is YOURS — while each",
    "  one runs, relay it this same clock (the minutes left, or the overrun)",
    "  on the same cadence, short and interrupting once the cap is passed, and",
    "  ask it to converge the same way (harness § Seat supervision). Never",
    "  re-ask a seat whose result you already have, and never widen its scope.",
    "",
    "You are the parent session of a deep (three-stage) code review.",
    "",
    "Recon facts:",
    ...input.reconFacts.map((fact) => `- ${fact}`),
    "",
    `The review worktree is ${input.worktreePath} (read-only clone; your cwd).`,
    "The review seat definitions (code-reviewer / fullstack-dev /",
    "frontend-dev) are installed at .omp/agents/ — dispatch the Stage 1",
    "collect and Stage 2 domain (± security) seats with the `task` tool;",
    "Stage 3 synthesis is yours alone.",
    "",
    "Execute the following review command for tier `deep`, with one override:",
    "do NOT post anything to GitHub (no reviews, no comments) — the caller",
    "owns publication and only consumes your verdict envelope.",
    "",
    "--- begin /amazing-pr-review (loaded from the mstar-harness plugin root) ---",
    command,
    "--- end /amazing-pr-review ---",
    "",
    "Final answer: call the `yield` tool once with data = the complete",
    "mstar.review/v1 envelope JSON.",
  ].join("\n");
}

function seatModelChain(input: AgentRuntimeRunInput): string[] {
  const seatOverride = input.modelOverrides?.["mstar-review-seat"];
  if (seatOverride !== undefined && seatOverride.trim() !== "") return [seatOverride];
  return [...input.modelSelectors];
}

const DEEP_STOP_UNSCANNED = "deep-parent: the whole diff";

const DEEP_NO_YIELD_CAUSE = "deep parent turn produced no structured yield (mstar.review/v1 envelope)";

/**
 * The model a seat actually served, read from its own session. Capture it at
 * the seat's own settlement: a keep-alive child keeps its registry ref but an
 * idle park nulls the ref's `session`, so a read at the end of the fan-out
 * loses the served model.
 */
export function servedModel(
  session:
    | {
        model?: { provider: string; id: string };
        servingModel?: { modelIdentity?: string; selector?: string };
      }
    | undefined
    | null,
): string | undefined {
  const identity = session?.servingModel?.modelIdentity ?? session?.servingModel?.selector;
  if (identity !== undefined && identity.includes("/")) return identity;
  const model = session?.model;
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

function sessionEntries(
  session: { sessionManager?: { getEntries?: () => SessionEntry[] } } | undefined,
): SessionEntry[] {
  const manager = session?.sessionManager;
  if (typeof manager?.getEntries !== "function") return [];
  try {
    return manager.getEntries();
  } catch {
    return [];
  }
}

function sessionUsageStats(
  session: { sessionManager?: { getUsageStatistics?: () => UsageStatistics } } | undefined,
): UsageStatistics | undefined {
  const manager = session?.sessionManager;
  if (typeof manager?.getUsageStatistics !== "function") return undefined;
  try {
    return manager.getUsageStatistics();
  } catch {
    return undefined;
  }
}

function runTokenUsage(
  entries: readonly SessionEntry[],
  singles: readonly (SubagentUsageSource | undefined)[],
): TokenUsageBucket[] {
  return mergeBuckets(bucketsFromSession(entries), bucketsFromSubagents(singles));
}

async function runDeepReview(input: AgentRuntimeRunInput): Promise<ReviewRunResult> {
  const pluginRoot = resolveHarnessRoot();
  const skills = await loadHarnessSkills(pluginRoot);
  const cwd = input.worktreePath;
  const wantsRecheck = input.recheck !== undefined;
  const wantsSeatAgent = wantsRecheck || input.prContext !== undefined;
  const installedFiles: readonly string[] = wantsSeatAgent
    ? [SEAT_AGENT_FILE, ...DEEP_SEAT_ROLE_FILES]
    : DEEP_SEAT_ROLE_FILES;
  let session: AgentSession | undefined;
  let recheckSession: AgentSession | undefined;
  let reportSession: AgentSession | undefined;
  const teardown = new AbortController();
  try {
    await installDeepSeatAgents(cwd, pluginRoot);
    if (wantsSeatAgent) await installSeatAgent(cwd);
    return await withoutGitHubTokenEnv(async () => {
      const created = await createAgentSession(
        deepSessionOptions({
          cwd,
          pluginRoot,
          skills,
          modelPattern: primaryModelSelector(input),
          fallbackChain: [...input.modelSelectors],
          agentModelOverrides: input.modelOverrides,
          agentDir: input.agentDir,
          authStorage: input.authStorage,
        }),
      );
      const parentSession = created.session;
      session = parentSession;

      const createSeatSession = async (): Promise<AgentSession> =>
        (
          await createAgentSession(
            buildSessionOptions({
              cwd,
              pluginRoot,
              skills,
              modelPattern: primaryModelSelector(input),
              fallbackChain: [...input.modelSelectors],
              agentDir: input.agentDir,
              authStorage: input.authStorage,
            }),
          )
        ).session;
      const recheckController = new AbortController();
      let recheckWork: Promise<RecheckSeatResult> | null = null;
      if (input.recheck !== undefined) {
        const liveRecheckSession = await createSeatSession();
        recheckSession = liveRecheckSession;
        recheckWork = tracedRecheck(
          runRecheckSeat({
            session: asToolSession(liveRecheckSession, cwd),
            input: input.recheck,
            model: seatModelChain(input),
            signal: recheckController.signal,
            ...(input.recheckAssignmentMaxBytes === undefined
              ? {}
              : { assignmentMaxBytes: input.recheckAssignmentMaxBytes }),
          }),
        );
      }

      const runParentTurn = async (): Promise<MstarReviewV1> => {
        let yielded: unknown;
        let yieldError: string | undefined;
        let gathered: { summary?: string; stopped?: string } | undefined;
        let resuming = false;
        const { promise: outcome, resolve: outcomeKnown } = Promise.withResolvers<void>();
        const unsubscribe = parentSession.subscribe((event) => {
          if (event.type === "agent_pause") {
            if (event.yielded || event.awaiting) resuming = true;
            return;
          }
          if (event.type === "agent_end") {
            const reversed = [...event.messages].reverse();
            const terminal = reversed.find((entry) => entry.role === "assistant");
            let summary: string | undefined;
            for (const entry of reversed) {
              if (entry.role !== "assistant") continue;
              let text = "";
              for (const part of entry.content) {
                if (part.type === "text") text += part.text;
              }
              if (text.trim() === "") continue;
              summary = fittedSummary(text.trim(), SUMMARY_MD_BUDGET);
              break;
            }
            const stop = terminal?.role === "assistant" ? terminal.errorMessage?.trim() : undefined;
            gathered = {
              ...(summary === undefined ? {} : { summary }),
              ...(stop === undefined || stop === "" ? {} : { stopped: stop }),
            };
            outcomeKnown();
            return;
          }
          if (event.type !== "tool_execution_end" || event.toolName !== "yield") return;
          if (event.isError) return;
          const details = (event.result as { details?: unknown } | undefined)?.details;
          if (!details || typeof details !== "object") return;
          const record = details as { data?: unknown; error?: string; status?: string; type?: unknown };
          if (typeof record.error === "string") {
            yieldError = record.error;
            return;
          }
          if (record.status === "success" && !Array.isArray(record.type) && record.data !== undefined) {
            yielded = record.data;
          }
        });

        let stoppedByDeadline = false;
        const deadlineAbort = (): void => {
          stoppedByDeadline = true;
          void parentSession.abort({ reason: "runner deadline reached" }).catch((error: unknown) => {
            console.error("deep parent deadline abort failed", error);
          });
        };
        let turnError: unknown;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const assignment = await deepAssignment(input, pluginRoot);
          if (remainingOuterMs(Date.now(), input.level) <= 0) {
            throw new RunnerBudgetExhausted(0, 0);
          }
          const firstTurnMs = Date.now();
          deadlineTimer = setTimeout(
            deadlineAbort,
            Math.max(1, seatDeadlineMs(firstTurnMs, firstTurnMs, input.level) - firstTurnMs),
          );
          await parentSession.prompt(assignment);
        } catch (error) {
          turnError = error;
        } finally {
          if (resuming && gathered === undefined) {
            const settled = await waitTick(
              Math.max(1, remainingOuterMs(Date.now(), input.level) - PUBLICATION_TAIL_MS),
              outcome,
            );
            if (!settled) deadlineAbort();
          }
          clearTimeout(deadlineTimer);
          unsubscribe();
        }
        if (stoppedByDeadline) {
          throw new RunnerBudgetExhausted(1, 1);
        }
        if (yielded === undefined) {
          if (gathered === undefined) {
            if (turnError !== undefined) {
              throw turnError;
            }
            throw new Error(
              yieldError !== undefined ? `deep parent yielded an error: ${yieldError}` : DEEP_NO_YIELD_CAUSE,
            );
          }
          const cause = (
            yieldError !== undefined
              ? `deep parent yielded an error: ${yieldError}`
              : turnError !== undefined
                ? `deep parent turn failed: ${turnError instanceof Error ? turnError.message : String(turnError)}`
                : (gathered.stopped ?? DEEP_NO_YIELD_CAUSE)
          )
            .replace(/\s+/g, " ")
            .trim();
          const stoppedEnvelope = synthesizeReview({
            findings: [],
            target: parseTarget(input.reconFacts),
            incomplete: { reason: cause, unscanned: [DEEP_STOP_UNSCANNED] },
            ...(gathered.summary === undefined ? {} : { summary_md: gathered.summary }),
          });
          const stopGate = validateMstarReviewV1(stoppedEnvelope);
          if (!stopGate.ok) {
            const detail = stopGate.violations
              .map((violation) => `${violation.code}: ${violation.message}`)
              .join("; ");
            throw new Error(`synthesized deep stop failed mstar.review/v1 validation: ${detail}`);
          }
          return stoppedEnvelope;
        }
        if (turnError !== undefined) {
          console.error("deep parent turn raised after a successful yield", turnError);
        }

        const gate = validateMstarReviewV1(yielded);
        if (!gate.ok) {
          const detail = gate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ");
          throw new Error(`deep parent yield failed mstar.review/v1 validation: ${detail}`);
        }
        return yielded as MstarReviewV1;
      };

      let parentRunning = true;
      const deepSeatId = seatTraceId(0, parentSession.getAgentId() ?? "deep-parent");
      traceStage(seatStartStage(deepSeatId));
      const parentTurn = runParentTurn()
        .then(
          (ready) => {
            traceStage(
              ready.incomplete === undefined
                ? seatDoneStage(deepSeatId, undefined)
                : seatGapStage(deepSeatId, ready.incomplete.reason),
            );
            return ready;
          },
          (error: unknown) => {
            traceStage(seatFailedStage(deepSeatId, causeText(error)));
            throw error;
          },
        )
        .finally(() => {
          parentRunning = false;
        });
      const supervision = superviseSeats({
        level: input.level,
        done: parentTurn.then(
          () => undefined,
          () => undefined,
        ),
        seats: [
          {
            id: parentSession.getAgentId() ?? "deep-parent",
            isRunning: () => parentRunning,
            deliver: (nudge) => nudgeSession(parentSession, nudge),
          },
        ],
      });
      let envelope: MstarReviewV1;
      try {
        envelope = await parentTurn;
      } catch (error) {
        recheckController.abort();
        const settled = recheckWork ? await recheckWork : null;
        if (error instanceof RunnerBudgetExhausted) {
          error.recheck = settled?.doc ?? null;
          if (settled !== null) error.recheckStatus = settled.status;
          error.appliedModel = servedModel(parentSession);
        }
        throw error;
      } finally {
        await supervision;
      }
      if (remainingOuterMs(Date.now(), input.level) <= RECHECK_MIN_REMAINING_MS) recheckController.abort();
      const settled = recheckWork ? await recheckWork : null;
      const reportSingles: SubagentUsageSource[] = [];
      const report = await tracedReportSeatFor(
        input,
        async () => {
          reportSession = await createSeatSession();
          return asToolSession(reportSession, cwd);
        },
        envelope,
        settled?.doc ?? null,
        runTeardownSignal(teardown, input),
        reportSingles,
      );
      const appliedModel = servedModel(session);
      const tokenUsage = deepTokenUsage(
        sessionUsageStats(parentSession),
        sessionEntries(parentSession),
        [settled?.usage, ...reportSingles],
      );
      return {
        envelope,
        recheck: settled?.doc ?? null,
        ...(settled !== null ? { recheckStatus: settled.status } : {}),
        report,
        ...(appliedModel === undefined ? {} : { appliedModel }),
        tokenUsage,
      };
    });
  } finally {
    teardown.abort();
    for (const live of [session, recheckSession, reportSession]) {
      if (live) {
        try {
          await live.dispose();
        } catch (error) {
          console.error("omp review runtime session dispose failed", error);
        }
      }
    }
    await removeInstalledAgents(cwd, installedFiles);
  }
}

function runTeardownSignal(controller: AbortController, input: AgentRuntimeRunInput): AbortSignal {
  return input.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, input.signal]);
}

/**
 * Whether the report seat can run for this round. ONE authority: the dispatch
 * path logs the reason and the trace names it, so the two can never disagree.
 * `review-incomplete` is a nothing-usable round — there is no review to
 * narrate, so no seat is invented for it. The run's own state is checked first,
 * so a torn-down or out-of-time run never blames the input for the run's clock;
 * the caller's own signal is read directly beside the composed teardown signal
 * because `AbortSignal.any` propagation can land a tick late.
 */
export type ReportEligibility =
  | { ok: true; headSha: string; prContext: PrContext }
  | {
      ok: false;
      reason:
        | "no-pr-context"
        | "head-sha-missing"
        | "seat-definition-missing"
        | "budget-exhausted"
        | "aborted";
    };

export function reportEligibility(
  input: AgentRuntimeRunInput,
  envelope: MstarReviewV1,
  signal?: AbortSignal,
): ReportEligibility {
  if (signal?.aborted === true || input.signal?.aborted === true) return { ok: false, reason: "aborted" };
  if (remainingOuterMs(Date.now(), input.level) <= REPORT_TAIL_MARGIN_MS) {
    return { ok: false, reason: "budget-exhausted" };
  }
  if (input.prContext === undefined) return { ok: false, reason: "no-pr-context" };
  const headSha = envelope.target?.head_sha;
  if (headSha === undefined) return { ok: false, reason: "head-sha-missing" };
  if (!existsSync(join(input.worktreePath, ".omp", "agents", SEAT_AGENT_FILE))) {
    return { ok: false, reason: "seat-definition-missing" };
  }
  return { ok: true, headSha, prContext: input.prContext };
}

async function runReportSeatFor(
  input: AgentRuntimeRunInput,
  session: ToolSession,
  envelope: MstarReviewV1,
  recheckDoc: RecheckDoc | null,
  signal: AbortSignal,
  usage: SubagentUsageSource[] = [],
  onEmpty?: (reason: ReportSeatEmptyReason) => void,
): Promise<ReportDoc | null> {
  const eligibility = reportEligibility(input, envelope, signal);
  if (!eligibility.ok) return null;
  return runReportSeat({
    session,
    envelopeJson: JSON.stringify(envelope),
    headSha: eligibility.headSha,
    revalidated: revalidatedNotes(input.recheck, recheckDoc),
    prContext: eligibility.prContext,
    model: seatModelChain(input),
    level: input.level,
    signal,
    usage,
    ...(onEmpty === undefined ? {} : { onEmpty }),
  });
}

/**
 * note: The delivered omp AgentRuntime. Resolves ONLY with an
 * engine-validated mstar.review/v1 envelope in `envelope` plus the
 * concurrent recheck document (or null) in `recheck`; anything
 * short of that throws.
 */
export const ompAgentRuntime: AgentRuntime = {
  async runReview(input: AgentRuntimeRunInput): Promise<ReviewRunResult> {
    if (input.level === "deep") {
      return runDeepReview(input);
    }
    if (!Object.hasOwn(REVIEW_SEATS, input.level)) {
      throw new Error(`unsupported review level: ${JSON.stringify(String(input.level))}`);
    }

    const pluginRoot = resolveHarnessRoot();
    const skills = await loadHarnessSkills(pluginRoot);
    const cwd = input.worktreePath;
    let session: AgentSession | undefined;
    const teardown = new AbortController();
    try {
      traceStage("enter_run_review");
      await installSeatAgent(cwd);
      traceStage("seat_installed");
      const seatModels = seatModelChain(input);
      traceStage("models_resolved");
      const created = await createAgentSession(
        buildSessionOptions({
          cwd,
          pluginRoot,
          skills,
          modelPattern: primaryModelSelector(input),
          fallbackChain: [...input.modelSelectors],
          agentDir: input.agentDir,
          authStorage: input.authStorage,
        }),
      );
      session = created.session;
      traceStage("session_ready");

      const plans = partitionSeats(input.reconFacts, input.level, input.seats ?? REVIEW_SEATS[input.level]);
      const toolSession = asToolSession(session, cwd);

      const recheckController = new AbortController();
      const recheckDoc = input.recheck;
      const recheckWork =
        recheckDoc !== undefined
          ? tracedRecheck(
              runRecheckSeat({
                session: toolSession,
                input: recheckDoc,
                model: seatModels,
                signal: recheckController.signal,
                ...(input.recheckAssignmentMaxBytes === undefined
                  ? {}
                  : { assignmentMaxBytes: input.recheckAssignmentMaxBytes }),
              }),
            )
          : null;
      const seats = plans.map((plan, index) => ({ plan, index, id: `${plan.domain}-${plan.seat}` }));
      const servedBySeat = new Map<string, string | undefined>();
      const seatSingles: SubagentUsageSource[] = [];
      const settledSeats = new Set<string>();
      const completedSeatIds = new Set<string>();
      const seatStops = new Map<string, { reason: "cap" | "failed"; detail?: string }>();
      const group = Promise.allSettled(
        seats.map(async ({ plan, index, id }) => {
          const watch = startSeatWatch(input.level);
          const traceId = seatTraceId(index, id);
          let terminalStage = seatFailedStage(traceId, "seat did not settle");
          traceStage(seatStartStage(traceId));
          try {
            const result = await runStructuredSubagent({
              session: toolSession,
              invocationKind: "task",
              identity: { id },
              assignment: seatAssignment(input, pluginRoot, plan),
              agent: "mstar-review-seat",
              model: seatModels,
              outputSchema: SEAT_OUTPUT_SCHEMA,
              schemaMode: "strict",
              enableLsp: false,
              enableIrc: false,
              maxRuntimeMs: 0,
              signal: watch.controller.signal,
              onProgress: (progress) => {
                if (startsFirstTurn(progress)) watch.markFirstTurn();
              },
            });
            seatSingles.push(result.result);
            let outcome = seatOutput(result, index, plan);
            const capReason = outcome.output === null ? watchdogCapReason(watch) : undefined;
            if (capReason !== undefined && outcome.gap === null) {
              outcome = { output: null, gap: { plan, reason: capReason }, failure: null };
            }
            if (outcome.gap === null && outcome.output !== null) completedSeatIds.add(id);
            else if (outcome.gap !== null) seatStops.set(id, { reason: "cap", detail: outcome.gap.reason });
            else {
              const detail =
                result.result.error ??
                result.result.structuredOutput?.error ??
                `no usable output (status ${result.result.structuredOutput?.status ?? "absent"})`;
              seatStops.set(id, { reason: "failed", detail });
            }
            terminalStage =
              outcome.gap !== null
                ? seatGapStage(traceId, outcome.gap.reason, result.result.requests)
                : outcome.failure !== null
                  ? seatFailedStage(traceId, result.result.error ?? outcome.failure.message)
                  : seatDoneStage(traceId, result.result.requests);
            return outcome;
          } catch (error) {
            const settled = (error as { result?: unknown } | null | undefined)?.result;
            if (settled !== null && typeof settled === "object") seatSingles.push(settled as SubagentUsageSource);
            const capReason = watchdogCapReason(watch);
            if (capReason !== undefined) {
              seatStops.set(id, { reason: "cap", detail: capReason });
              terminalStage = seatGapStage(traceId, capReason);
              return { output: null, gap: { plan, reason: capReason }, failure: null };
            }
            seatStops.set(id, { reason: "failed", detail: causeText(error) });
            terminalStage = seatFailedStage(traceId, causeText(error));
            throw error;
          } finally {
            servedBySeat.set(id, servedModel(AgentRegistry.global().get(id)?.session));
            settledSeats.add(id);
            watch.stop();
            traceStage(terminalStage);
          }
        }),
      );
      const supervision = superviseSeats({
        level: input.level,
        done: group.then(() => undefined),
        seats: seats.map(({ id }) => ({
          id,
          isRunning: () => !settledSeats.has(id),
          deliver: (nudge) => nudgeSession(AgentRegistry.global().get(id)?.session, nudge),
        })),
      });
      let outcomes: SeatOutcome[];
      const siblingLosses: { seat: string; detail: string }[] = [];
      let results: PromiseSettledResult<SeatOutcome>[];
      try {
        results = await group;
      } finally {
        await supervision;
      }
      outcomes = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      results.forEach((result, seatIndex) => {
        if (result.status === "rejected") {
          siblingLosses.push({ seat: seats[seatIndex]!.id, detail: causeText(result.reason) });
        } else if (result.value.failure !== null) {
          siblingLosses.push({ seat: seats[seatIndex]!.id, detail: causeText(result.value.failure) });
        }
      });
      const outputs = outcomes.flatMap((outcome) => (outcome.output === null ? [] : [outcome.output]));
      const gaps = outcomes.flatMap((outcome) => (outcome.gap === null ? [] : [outcome.gap]));
      if (outputs.length === 0) {
        recheckController.abort();
        const settled = recheckWork ? await recheckWork : null;
        const served = new Set<string>();
        for (const { id } of seats) {
          const applied = servedBySeat.get(id);
          if (applied !== undefined) served.add(applied);
        }
        if (gaps.length > 0) {
          const exhausted = new RunnerBudgetExhausted(seats.length, gaps.length);
          exhausted.recheck = settled?.doc ?? null;
          if (settled !== null) exhausted.recheckStatus = settled.status;
          for (const gap of gaps) {
            console.error(seatStopLine(`${gap.plan.domain}-${gap.plan.seat}`, gap.reason));
          }
          for (const { seat, detail } of siblingLosses) {
            console.error(
              `review seat ${seat} lost beside a cap stop${detail.length === 0 ? "" : `: ${detail}`}`,
            );
          }
          if (served.size === 1) exhausted.appliedModel = [...served][0]!;
          throw exhausted;
        }
        const firstStop = seats
          .map(({ id }) => ({ id, stop: seatStops.get(id) }))
          .find((entry) => entry.stop !== undefined);
        const cause =
          firstStop?.stop?.detail === undefined || firstStop.stop.detail === ""
            ? (firstStop?.stop?.reason ?? "no seat produced a usable payload")
            : firstStop.stop.detail;
        console.error(
          `review failed: no usable seat output${firstStop === undefined ? "" : ` (${firstStop.id}: ${cause})`}`,
        );
        const failure = new ReviewNoOutputFailure(
          `${firstStop?.id ?? "seat"}: ${cause}`,
        );
        failure.recheck = settled?.doc ?? null;
        if (settled !== null) failure.recheckStatus = settled.status;
        throw failure;
      }
      if (gaps.length > 0 || siblingLosses.length > 0) {
        for (const gap of gaps) {
          console.error(seatStopLine(`${gap.plan.domain}-${gap.plan.seat}`, gap.reason));
        }
        for (const { seat, detail } of siblingLosses) {
          console.error(`review seat ${seat} lost beside delivered seats${detail.length === 0 ? "" : `: ${detail}`}`);
        }
      }
      const unreviewedSeats = seats.filter(({ id }) => !completedSeatIds.has(id));
      const coverage: ReviewCoverage = {
        seatsTotal: seats.length,
        seatsCompleted: completedSeatIds.size,
        stoppedReason:
          unreviewedSeats.length === 0
            ? null
            : unreviewedSeats.some(({ id }) => seatStops.get(id)?.reason === "cap")
              ? "cap"
              : "failed",
        unreviewed: unreviewedSeats.map(({ id, plan }) => {
          const stop = seatStops.get(id) ?? { reason: "failed" as const };
          const slug = stop.detail === undefined ? "" : stageSlug(stop.detail, 24);
          return {
            seat: `${plan.domain}-${plan.seat}`,
            scope: [...plan.scope],
            reason: stop.reason === "cap" ? "cap" : slug === "" ? "failed" : `failed:${slug}`,
          };
        }),
      };

      if (remainingOuterMs(Date.now(), input.level) <= RECHECK_MIN_REMAINING_MS) recheckController.abort();
      const settled = recheckWork ? await recheckWork : null;
      const findings = mergeSeatOutputs(outputs);
      const envelope = synthesizeReview({
        findings,
        target: parseTarget(input.reconFacts),
      });
      const gate = validateMstarReviewV1(envelope);
      if (!gate.ok) {
        const detail = gate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ");
        throw new Error(`synthesized review failed mstar.review/v1 validation: ${detail}`);
      }
      const reportSingles: SubagentUsageSource[] = [];
      const report = await tracedReportSeatFor(
        input,
        async () => toolSession,
        envelope,
        settled?.doc ?? null,
        runTeardownSignal(teardown, input),
        reportSingles,
      );
      const served = new Set<string>();
      for (const { id } of seats) {
        const applied = servedBySeat.get(id);
        if (applied !== undefined) served.add(applied);
      }
      const appliedModel = served.size === 1 ? [...served][0]! : undefined;
      return {
        envelope,
        ...(coverage === undefined ? {} : { coverage }),
        recheck: settled?.doc ?? null,
        ...(settled !== null ? { recheckStatus: settled.status } : {}),
        report,
        ...(appliedModel === undefined ? {} : { appliedModel }),
        tokenUsage: runTokenUsage(
          sessionEntries(session),
          [settled?.usage, ...seatSingles, ...reportSingles],
        ),
      };
    } finally {
      teardown.abort();
      if (session) {
        try {
          await session.dispose();
        } catch (error) {
          console.error("omp review runtime session dispose failed", error);
        }
      }
      await removeInstalledAgents(cwd, [SEAT_AGENT_FILE]);
    }
  },
};
