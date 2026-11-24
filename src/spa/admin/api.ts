import { useEffect, useState } from "react";
import { RECONCILE_FIELDS, type ReconcileConfig, type ReconcileLimits, type ReconcileValues } from "../../contracts/reconcile-settings";
import { SWEEP_FIELDS, type SweepConfig, type SweepField, type SweepLimits, type SweepValues } from "../../contracts/sweep-settings";
import { fetchJson } from "../api";

const BASE = "/_internal_admin/api";

export type FlagRow = { key: string; enabled: boolean };

/** One `GET /api/workspaces` row. */
export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerLogin: string | null;
  memberCount: number;
  pendingInviteCount: number;
  planId: string;
  planName: string;
  includedMembers: number | null;
  createdAt: string;
};

/** One `GET /api/users` row; `isOperator` comes from the env allowlist, not a table. */
export type UserRow = {
  login: string;
  createdAt: string;
  workspaceCount: number;
  activeGrantCount: number;
  isOperator: boolean;
};

/** One open support window — the `support_grants` row's own column names. */
export type GrantRow = {
  id: string;
  workspace_id: string;
  operator_login: string;
  reason: string;
  granted_by: string;
  created_at: string;
  expires_at: string;
};

export type Loaded<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

type Json = Record<string, unknown>;

function map(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null) throw new Error(`admin API: ${what} is not an object`);
  return value as Json;
}

function list(value: unknown, what: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`admin API: ${what} is not a list`);
  return value.map((row) => map(row, `${what} row`));
}

function text(row: Json, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`admin API: ${key} is not a string`);
  return value;
}

function maybeText(row: Json, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`admin API: ${key} is not a string`);
  return value;
}

function num(row: Json, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`admin API: ${key} is not a number`);
  return value;
}

function maybeNum(row: Json, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`admin API: ${key} is not a number`);
  return value;
}

function bool(row: Json, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`admin API: ${key} is not a boolean`);
  return value;
}

export async function readFlags(): Promise<FlagRow[]> {
  const body = map(await fetchJson(`${BASE}/flags`), "flags response");
  return list(body.flags, "flags").map((row) => ({ key: text(row, "key"), enabled: bool(row, "enabled") }));
}

/** The §7.10 Check budgets as the operator API reports them. */
export type CheckBudgetConfig = {
  terminalizeMs: number;
  updateMs: number;
  terminalizeMin: number;
  terminalizeMax: number;
  updateMin: number;
  updateMax: number;
  degraded: boolean;
};

/** The migration-0048 comment-claim outbox budgets as the operator API reports them. */
export type CommentClaimConfig = {
  retryMs: number;
  maxAttempts: number;
  outboxCap: number;
  retryMin: number;
  retryMax: number;
  attemptsMin: number;
  attemptsMax: number;
  outboxMin: number;
  outboxMax: number;
  degraded: boolean;
};

/** The recheck seat's ask budget as the operator API reports it. */
export type RecheckAssignmentConfig = {
  maxBytes: number;
  min: number;
  max: number;
  degraded: boolean;
};

/**
 * The one end-to-end attempt cap. `saved` is true only when a stored row
 * produced `capMs`; an absent row answers the platform default with
 * `saved: false`, and the card must not present that as a saved value.
 */
export type AttemptCapConfig = {
  capMs: number;
  saved: boolean;
  min: number;
  max: number;
  degraded: boolean;
};

/**
 * The lost-reply observation window as the operator API reports it: how long a
 * launched row may stay outcome-less before the recovery pass settles it.
 */
export type LostReplySettleConfig = {
  settleMs: number;
  min: number;
  max: number;
  degraded: boolean;
};

/**
 * The review route's operating switch as the operator API reports it: the
 * gate's own answer (`mode`) plus what the stored row holds behind it. A
 * hand-edited row the read path refuses answers `off` with `degraded: true`,
 * `reason: "untrusted"` and the raw value in `rejected`.
 */
export type RouteWorkflowConfig = {
  mode: "on" | "off";
  saved: boolean;
  degraded: boolean;
  reason: string | null;
  rejected: string | null;
};

export type ReviewsRunningAnswer =
  | "running"
  | "paused-platform"
  | "blocked-deployment-gate"
  | "unreadable-state";

/**
 * One operations answer for "are reviews running": the derived answer plus the
 * two facts behind it that the page does not already carry (the routing gate is
 * the top-level `routeWorkflow`). `pausedApps` is `null` when the App count
 * could not be read — never `0`; `appsHref` is the workspace-scoped Apps list,
 * `null` when no workspace ref could be resolved.
 */
export type ReviewsRunningConfig = {
  answer: ReviewsRunningAnswer;
  platform: { enabled: boolean; unreadable: boolean };
  pausedApps: number | null;
  appsHref: string | null;
};

/**
 * The maintenance window (D20): whether the platform is closed, the Operator's
 * reason and when it closed. `reason` / `since` are `null` whenever the window
 * is open — the store deletes both on disable, so a closed platform never
 * carries a stale window.
 */
export type MaintenanceConfig = {
  enabled: boolean;
  reason: string | null;
  since: string | null;
  unreadable: boolean;
};

/** Admission drops in the trailing 24h, one count per refusal reason. */
export type AdmissionDropCounts = {
  "pr-held": number;
  "system-cap": number;
  "workspace-cap": number;
  error: number;
};

/**
 * The live review-queue gauge. `null` at the config level means the gauge is
 * not readable — never that the queue is empty.
 */
export type QueueBacklog = {
  backlogCount: number;
  oldestMessageTimestamp: string | null;
};

/** The runtime parameters (iteration spec §1.1, spec §7.10). */
export type RuntimeConfig = {
  concurrency: number;
  min: number;
  max: number;
  degraded: boolean;
  checkBudgets: CheckBudgetConfig | null;
  commentClaim: CommentClaimConfig | null;
  sweep: SweepConfig | null;
  reconcile: ReconcileConfig | null;
  recheckAssignment: RecheckAssignmentConfig | null;
  attemptCap: AttemptCapConfig | null;
  lostReplySettle: LostReplySettleConfig | null;
  routeWorkflow: RouteWorkflowConfig | null;
  reviewsRunning: ReviewsRunningConfig | null;
  maintenance: MaintenanceConfig | null;
  admissionDrops24h: AdmissionDropCounts | null;
  queue: QueueBacklog | null;
  githubRateLimited24h: number;
  officialWorkspaceId: string | null;
};

function parseReconcile(row: Json): ReconcileConfig | null {
  if (row.reconcile === undefined) return null;
  const group = map(row.reconcile, "runtime reconcile");
  const rawValues = map(group.values, "runtime reconcile values");
  const rawLimits = map(group.limits, "runtime reconcile limits");
  const values = {} as ReconcileValues;
  const limits = {} as ReconcileLimits;
  for (const field of RECONCILE_FIELDS) {
    const range = map(rawLimits[field], `runtime reconcile limits.${field}`);
    values[field] = num(rawValues, field);
    limits[field] = { min: num(range, "min"), max: num(range, "max") };
  }
  return { values, limits, degraded: bool(group, "degraded") };
}

function parseSweep(row: Json): SweepConfig | null {
  if (row.sweep === undefined) return null;
  const group = map(row.sweep, "runtime sweep");
  const rawValues = map(group.values, "runtime sweep values");
  const rawLimits = map(group.limits, "runtime sweep limits");
  const values = {} as SweepValues;
  const limits = {} as SweepLimits;
  for (const field of SWEEP_FIELDS) {
    const range = map(rawLimits[field], `runtime sweep limits.${field}`);
    values[field] = num(rawValues, field);
    limits[field] = { min: num(range, "min"), max: num(range, "max") };
  }
  const invalid = group.invalid;
  if (!Array.isArray(invalid) || !invalid.every((field) => (SWEEP_FIELDS as readonly unknown[]).includes(field))) {
    throw new Error("admin API: runtime sweep invalid is not a list of sweep fields");
  }
  return { values, limits, degraded: bool(group, "degraded"), invalid: invalid as SweepField[] };
}

function parseCheckBudgets(row: Json): CheckBudgetConfig | null {
  const raw = row.checkBudgets;
  if (raw === undefined) return null;
  const budgets = map(raw, "runtime checkBudgets");
  return {
    terminalizeMs: num(budgets, "terminalizeMs"),
    updateMs: num(budgets, "updateMs"),
    terminalizeMin: num(budgets, "terminalizeMin"),
    terminalizeMax: num(budgets, "terminalizeMax"),
    updateMin: num(budgets, "updateMin"),
    updateMax: num(budgets, "updateMax"),
    degraded: bool(budgets, "degraded"),
  };
}

function parseCommentClaim(row: Json): CommentClaimConfig | null {
  const raw = row.commentClaim;
  if (raw === undefined) return null;
  const claim = map(raw, "runtime commentClaim");
  return {
    retryMs: num(claim, "retryMs"),
    maxAttempts: num(claim, "maxAttempts"),
    outboxCap: num(claim, "outboxCap"),
    retryMin: num(claim, "retryMin"),
    retryMax: num(claim, "retryMax"),
    attemptsMin: num(claim, "attemptsMin"),
    attemptsMax: num(claim, "attemptsMax"),
    outboxMin: num(claim, "outboxMin"),
    outboxMax: num(claim, "outboxMax"),
    degraded: bool(claim, "degraded"),
  };
}

function parseRecheckAssignment(row: Json): RecheckAssignmentConfig | null {
  const raw = row.recheckAssignment;
  if (raw === undefined) return null;
  const budget = map(raw, "runtime recheckAssignment");
  return {
    maxBytes: num(budget, "maxBytes"),
    min: num(budget, "min"),
    max: num(budget, "max"),
    degraded: bool(budget, "degraded"),
  };
}

function parseAttemptCap(row: Json): AttemptCapConfig | null {
  const raw = row.attemptCap;
  if (raw === undefined) return null;
  const cap = map(raw, "runtime attemptCap");
  return {
    capMs: num(cap, "capMs"),
    saved: bool(cap, "saved"),
    min: num(cap, "min"),
    max: num(cap, "max"),
    degraded: bool(cap, "degraded"),
  };
}

function parseLostReplySettle(row: Json): LostReplySettleConfig | null {
  const raw = row.lostReplySettle;
  if (raw === undefined) return null;
  const window = map(raw, "runtime lostReplySettle");
  return {
    settleMs: num(window, "settleMs"),
    min: num(window, "min"),
    max: num(window, "max"),
    degraded: bool(window, "degraded"),
  };
}

function routeWorkflowGate(raw: unknown): RouteWorkflowConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const gate = raw as Json;
  if (
    (gate.mode !== "on" && gate.mode !== "off") ||
    typeof gate.saved !== "boolean" ||
    typeof gate.degraded !== "boolean"
  ) {
    return null;
  }
  return {
    mode: gate.mode,
    saved: gate.saved,
    degraded: gate.degraded,
    reason: typeof gate.reason === "string" ? gate.reason : null,
    rejected: typeof gate.rejected === "string" ? gate.rejected : null,
  };
}

function parseRouteWorkflow(row: Json): RouteWorkflowConfig | null {
  const raw = row.routeWorkflow;
  if (raw === undefined) return null;
  const gate = routeWorkflowGate(raw);
  if (gate === null) throw new Error("admin API: routeWorkflow is not a gate answer");
  return gate;
}

function parseMaintenance(row: Json): MaintenanceConfig | null {
  const raw = row.maintenance;
  if (raw === undefined) return null;
  const window = map(raw, "runtime maintenance");
  return {
    enabled: bool(window, "enabled"),
    reason: maybeText(window, "reason"),
    since: maybeText(window, "since"),
    unreadable: window.unreadable === true,
  };
}

function parseAdmissionDrops(row: Json): AdmissionDropCounts | null {
  const raw = row.admissionDrops24h;
  if (raw === undefined) return null;
  const drops = map(raw, "runtime admissionDrops24h");
  return {
    "pr-held": num(drops, "pr-held"),
    "system-cap": num(drops, "system-cap"),
    "workspace-cap": num(drops, "workspace-cap"),
    error: num(drops, "error"),
  };
}

function parseQueue(row: Json): QueueBacklog | null {
  const raw = row.queue;
  if (typeof raw !== "object" || raw === null) return null;
  const queue = raw as Json;
  if (typeof queue.backlogCount !== "number") return null;
  return {
    backlogCount: queue.backlogCount,
    oldestMessageTimestamp:
      typeof queue.oldestMessageTimestamp === "string" ? queue.oldestMessageTimestamp : null,
  };
}

function parseReviewsRunning(row: Json): ReviewsRunningConfig | null {
  const raw = row.reviewsRunning;
  if (typeof raw !== "object" || raw === null) return null;
  const block = raw as Json;
  const platform = block.platform;
  if (typeof platform !== "object" || platform === null) return null;
  const facts = platform as Json;
  if (
    (block.answer !== "running" &&
      block.answer !== "paused-platform" &&
      block.answer !== "blocked-deployment-gate" &&
      block.answer !== "unreadable-state") ||
    typeof facts.enabled !== "boolean" ||
    typeof facts.unreadable !== "boolean"
  ) {
    return null;
  }
  if (block.pausedApps !== null && typeof block.pausedApps !== "number") return null;
  return {
    answer: block.answer,
    platform: { enabled: facts.enabled, unreadable: facts.unreadable },
    pausedApps: block.pausedApps as number | null,
    appsHref: typeof block.appsHref === "string" ? block.appsHref : null,
  };
}

function parseGithubRateLimited(row: Json): number {
  const value = row.githubRateLimited24h;
  return typeof value === "number" ? value : 0;
}

export async function readRuntime(): Promise<RuntimeConfig> {
  const body = map(await fetchJson(`${BASE}/runtime`), "runtime response");
  return {
    concurrency: num(body, "concurrency"),
    min: num(body, "min"),
    max: num(body, "max"),
    degraded: bool(body, "degraded"),
    checkBudgets: parseCheckBudgets(body),
    commentClaim: parseCommentClaim(body),
    sweep: parseSweep(body),
    reconcile: parseReconcile(body),
    recheckAssignment: parseRecheckAssignment(body),
    attemptCap: parseAttemptCap(body),
    lostReplySettle: parseLostReplySettle(body),
    routeWorkflow: parseRouteWorkflow(body),
    reviewsRunning: parseReviewsRunning(body),
    maintenance: parseMaintenance(body),
    admissionDrops24h: parseAdmissionDrops(body),
    queue: parseQueue(body),
    githubRateLimited24h: parseGithubRateLimited(body),
    officialWorkspaceId:
      body.officialWorkspaceId === undefined ? null : maybeText(body, "officialWorkspaceId"),
  };
}

export type DurationPercentiles = { p50Ms: number; p90Ms: number; maxMs: number };

/** One candidate cap's observed cutoff: what it would exclude, and where. */
export type DurationReportCutoff = {
  capMs: number;
  over: number;
  share: number | null;
  crossed: { queueWait: number; execution: number; publication: number };
};

/**
 * The duration analysis report. Every percentile group is `null` when nothing
 * completed in the window: the surface must render "no sample", never a zero.
 */
export type DurationReport = {
  window: { days: number; startMs: number; endMs: number };
  sampleSize: number;
  total: DurationPercentiles | null;
  phases: {
    queueWait: DurationPercentiles | null;
    execution: DurationPercentiles | null;
    publication: DurationPercentiles | null;
  };
  excluded: {
    "check-open-at-settle": number;
    "no-settlement-record": number;
    "no-boundary": number;
    unsettled: number;
    "pre-prepare": number;
  };
  cutoff: DurationReportCutoff | null;
};

function percentilesOrNull(raw: unknown, what: string): DurationPercentiles | null {
  if (raw === null || raw === undefined) return null;
  const group = map(raw, what);
  return { p50Ms: num(group, "p50Ms"), p90Ms: num(group, "p90Ms"), maxMs: num(group, "maxMs") };
}

function parseCutoff(raw: unknown): DurationReportCutoff {
  const cutoff = map(raw, "duration cutoff");
  const crossed = map(cutoff.crossed, "duration cutoff crossed");
  return {
    capMs: num(cutoff, "capMs"),
    over: num(cutoff, "over"),
    share: maybeNum(cutoff, "share"),
    crossed: {
      queueWait: num(crossed, "queueWait"),
      execution: num(crossed, "execution"),
      publication: num(crossed, "publication"),
    },
  };
}

/**
 * Read the operator's duration report. `capMs` is the candidate the operator
 * typed; `null` asks for the distribution alone.
 */
export async function readDurationReport(capMs: number | null): Promise<DurationReport> {
  const query = capMs === null ? "" : `?capMs=${encodeURIComponent(String(capMs))}`;
  const body = map(await fetchJson(`${BASE}/runtime/duration-report${query}`), "duration report response");
  const window = map(body.window, "duration window");
  const phases = map(body.phases, "duration phases");
  const excluded = map(body.excluded, "duration exclusions");
  return {
    window: {
      days: num(window, "days"),
      startMs: num(window, "startMs"),
      endMs: num(window, "endMs"),
    },
    sampleSize: num(body, "sampleSize"),
    total: percentilesOrNull(body.total, "duration total"),
    phases: {
      queueWait: percentilesOrNull(phases.queueWait, "duration queueWait"),
      execution: percentilesOrNull(phases.execution, "duration execution"),
      publication: percentilesOrNull(phases.publication, "duration publication"),
    },
    excluded: {
      "check-open-at-settle": num(excluded, "check-open-at-settle"),
      "no-settlement-record": num(excluded, "no-settlement-record"),
      "no-boundary": num(excluded, "no-boundary"),
      unsettled: num(excluded, "unsettled"),
      "pre-prepare": num(excluded, "pre-prepare"),
    },
    cutoff: body.cutoff === null || body.cutoff === undefined ? null : parseCutoff(body.cutoff),
  };
}

/**
 * Set or clear the platform's official workspace, answering the id the server
 * stored (`null` for a clear). `null` is the only clear — the server refuses
 * an empty string as a body-shape error, so the console never sends one.
 */
export async function setOfficialWorkspace(workspaceId: string | null): Promise<string | null> {
  const answer = await write("PATCH", "/official-workspace", { workspaceId });
  if (typeof answer === "object" && answer !== null && "workspaceId" in answer) {
    const stored = answer.workspaceId;
    if (stored === null || typeof stored === "string") return stored;
  }
  return workspaceId;
}

export async function saveReconcileSettings(values: ReconcileValues): Promise<void> {
  await write("PATCH", "/runtime", { reconcile: values });
}

export async function saveSweepSettings(values: SweepValues): Promise<void> {
  await write("PATCH", "/runtime", { sweep: values });
}

function storedConcurrency(answer: unknown): number | null {
  if (typeof answer !== "object" || answer === null || !("concurrency" in answer)) return null;
  return typeof answer.concurrency === "number" ? answer.concurrency : null;
}

/**
 * Save the system cap, answering the value the server stored. A 2xx whose body
 * is unreadable still landed the write, so the accepted request value stands in
 * for the missing echo instead of reporting the save as a failure.
 */
export async function setSystemConcurrency(concurrency: number): Promise<number> {
  return storedConcurrency(await write("PATCH", "/runtime", { concurrency })) ?? concurrency;
}

/**
 * Save both Check budgets, answering the pair the server stored. The range
 * fields ride the loaded config, not the echo (the echo is the stored pair
 * only); a 2xx with an unreadable body still landed, so the request value
 * stands in — the same rule as `setSystemConcurrency`.
 */
export async function setCheckBudgets(
  value: { terminalizeMs: number; updateMs: number },
  stored: CheckBudgetConfig,
): Promise<CheckBudgetConfig> {
  const answer = await write("PATCH", "/runtime", { checkBudgets: value });
  if (typeof answer === "object" && answer !== null && "checkBudgets" in answer) {
    const saved = answer.checkBudgets;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "terminalizeMs" in saved &&
      "updateMs" in saved
    ) {
      const { terminalizeMs, updateMs } = saved;
      if (typeof terminalizeMs === "number" && typeof updateMs === "number") {
        return { ...stored, terminalizeMs, updateMs, degraded: false };
      }
    }
  }
  return { ...stored, ...value, degraded: false };
}

/**
 * Save the three comment-claim outbox settings, answering the trio the server
 * stored. The range fields ride the loaded config (the echo is the stored
 * values only); a 2xx with an unreadable body still landed, so the request
 * value stands in — the same rule as `setSystemConcurrency`.
 */
export async function setCommentClaimSettings(
  value: { retryMs: number; maxAttempts: number; outboxCap: number },
  stored: CommentClaimConfig,
): Promise<CommentClaimConfig> {
  const answer = await write("PATCH", "/runtime", { commentClaim: value });
  if (typeof answer === "object" && answer !== null && "commentClaim" in answer) {
    const saved = answer.commentClaim;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "retryMs" in saved &&
      "maxAttempts" in saved &&
      "outboxCap" in saved
    ) {
      const { retryMs, maxAttempts, outboxCap } = saved;
      if (
        typeof retryMs === "number" &&
        typeof maxAttempts === "number" &&
        typeof outboxCap === "number"
      ) {
        return { ...stored, retryMs, maxAttempts, outboxCap, degraded: false };
      }
    }
  }
  return { ...stored, ...value, degraded: false };
}

/**
 * Save the recheck ask budget, answering the value the server stored. A 2xx
 * whose body is unreadable still landed the write, so the request value stands
 * in — the same rule as `setSystemConcurrency`.
 */
export async function setRecheckAssignmentMaxBytes(
  maxBytes: number,
  stored: RecheckAssignmentConfig,
): Promise<RecheckAssignmentConfig> {
  const answer = await write("PATCH", "/runtime", { recheckAssignment: { maxBytes } });
  if (typeof answer === "object" && answer !== null && "recheckAssignment" in answer) {
    const saved = answer.recheckAssignment;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "maxBytes" in saved &&
      typeof saved.maxBytes === "number"
    ) {
      return { ...stored, maxBytes: saved.maxBytes, degraded: false };
    }
  }
  return { ...stored, maxBytes, degraded: false };
}

/**
 * Save the end-to-end attempt cap, answering the value the server stored. The
 * echo is the stored number only, so `saved: true` rides the landed write; a
 * 2xx with an unreadable body still landed, so the request value stands in —
 * the same rule as `setSystemConcurrency`.
 */
export async function setAttemptCap(capMs: number, stored: AttemptCapConfig): Promise<AttemptCapConfig> {
  const answer = await write("PATCH", "/runtime", { attemptCap: { capMs } });
  if (typeof answer === "object" && answer !== null && "attemptCap" in answer) {
    const saved = answer.attemptCap;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "capMs" in saved &&
      typeof saved.capMs === "number"
    ) {
      return { ...stored, capMs: saved.capMs, saved: true, degraded: false };
    }
  }
  return { ...stored, capMs, saved: true, degraded: false };
}

/**
 * Save the lost-reply observation window, answering the value the server
 * stored. Same rule as `setAttemptCap`: the echo is the stored number, and a
 * 2xx with an unreadable body still landed, so the request value stands in.
 */
export async function setLostReplySettleMs(
  settleMs: number,
  stored: LostReplySettleConfig,
): Promise<LostReplySettleConfig> {
  const answer = await write("PATCH", "/runtime", { lostReplySettle: { settleMs } });
  if (typeof answer === "object" && answer !== null && "lostReplySettle" in answer) {
    const saved = answer.lostReplySettle;
    if (
      typeof saved === "object" &&
      saved !== null &&
      "settleMs" in saved &&
      typeof saved.settleMs === "number"
    ) {
      return { ...stored, settleMs: saved.settleMs, degraded: false };
    }
  }
  return { ...stored, settleMs, degraded: false };
}

/**
 * Open or close the maintenance window, answering the state the server stored.
 * The server owns `since`, so an unreadable echo answers the REQUEST's flag —
 * the write already landed — but keeps the loaded window's stamps: claiming a
 * start time the console never read would be a guess.
 */
export async function setMaintenance(
  value: { enabled: boolean; reason?: string },
  stored: MaintenanceConfig,
): Promise<MaintenanceConfig> {
  const answer = await write("PATCH", "/runtime", { maintenance: value });
  if (typeof answer === "object" && answer !== null && "maintenance" in answer) {
    const saved = answer.maintenance;
    if (typeof saved === "object" && saved !== null && "enabled" in saved) {
      const { enabled, reason, since, unreadable } = saved as Json;
      if (typeof enabled === "boolean") {
        return {
          enabled,
          reason: typeof reason === "string" ? reason : null,
          since: typeof since === "string" ? since : null,
          unreadable: unreadable === true,
        };
      }
    }
  }
  return { ...stored, enabled: value.enabled };
}

export async function readWorkspaces(): Promise<WorkspaceRow[]> {
  const body = map(await fetchJson(`${BASE}/workspaces`), "workspaces response");
  return list(body.workspaces, "workspaces").map((row) => ({
    id: text(row, "id"),
    name: text(row, "name"),
    slug: text(row, "slug"),
    ownerLogin: maybeText(row, "ownerLogin"),
    memberCount: num(row, "memberCount"),
    pendingInviteCount: num(row, "pendingInviteCount"),
    planId: text(row, "planId"),
    planName: text(row, "planName"),
    includedMembers: maybeNum(row, "includedMembers"),
    createdAt: text(row, "createdAt"),
  }));
}

/** A bot's scope: `owned` serves its workspace only, `shared` is offered platform-wide. */
export type BotScope = "owned" | "shared";

/** One `GET /api/bots` row: a live bot, its workspace and how far it reaches. */
export type BotRow = {
  botId: string;
  name: string;
  githubAppId: number;
  workspaceId: string | null;
  workspaceName: string | null;
  isOfficial: boolean;
  scope: BotScope;
  sharedAt: string | null;
  installationCount: number;
  liveTargetCount: number;
};

export async function readBots(): Promise<BotRow[]> {
  const body = map(await fetchJson(`${BASE}/bots`), "bots response");
  return list(body.bots, "bots").map((row) => {
    const scope = text(row, "scope");
    if (scope !== "owned" && scope !== "shared") {
      throw new Error("admin API: bot scope is not owned|shared");
    }
    return {
      botId: text(row, "botId"),
      name: text(row, "name"),
      githubAppId: num(row, "githubAppId"),
      workspaceId: maybeText(row, "workspaceId"),
      workspaceName: maybeText(row, "workspaceName"),
      isOfficial: bool(row, "isOfficial"),
      scope,
      sharedAt: maybeText(row, "sharedAt"),
      installationCount: num(row, "installationCount"),
      liveTargetCount: num(row, "liveTargetCount"),
    };
  });
}

/**
 * Move one bot between `owned` and `shared`. Only an unshare carries the
 * confirmation the server demands: a share is not destructive, so it never
 * sends one. The caller re-reads afterwards — `sharedAt` is the server's
 * stamp, not something the console may guess.
 */
export async function setBotScope(botId: string, scope: BotScope): Promise<void> {
  await write(
    "PATCH",
    `/bots/${encodeURIComponent(botId)}/scope`,
    scope === "owned" ? { scope, confirm: true } : { scope },
  );
}

/** One `GET /api/usage` row: a live workspace's reviews this UTC month. */
export type UsageRow = {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  sharedReviews: number;
  ownReviews: number;
};

/**
 * The month the route answered for plus every live workspace's two counts, in
 * the server's decided order. One request, no paging: the screen filters what
 * it was given.
 */
export async function readUsage(): Promise<{ month: string; rows: UsageRow[] }> {
  const body = map(await fetchJson(`${BASE}/usage`), "usage response");
  return {
    month: text(body, "month"),
    rows: list(body.workspaces, "usage").map((row) => ({
      workspaceId: text(row, "workspaceId"),
      workspaceName: text(row, "workspaceName"),
      workspaceSlug: text(row, "workspaceSlug"),
      sharedReviews: num(row, "sharedReviews"),
      ownReviews: num(row, "ownReviews"),
    })),
  };
}

export async function readUsers(): Promise<UserRow[]> {
  const body = map(await fetchJson(`${BASE}/users`), "users response");
  return list(body.users, "users").map((row) => ({
    login: text(row, "login"),
    createdAt: text(row, "createdAt"),
    workspaceCount: num(row, "workspaceCount"),
    activeGrantCount: num(row, "activeGrantCount"),
    isOperator: bool(row, "isOperator"),
  }));
}

export async function readGrants(): Promise<GrantRow[]> {
  const body = map(await fetchJson(`${BASE}/support-grants`), "support grants response");
  return list(body.grants, "grants").map((row) => ({
    id: text(row, "id"),
    workspace_id: text(row, "workspace_id"),
    operator_login: text(row, "operator_login"),
    reason: text(row, "reason"),
    granted_by: text(row, "granted_by"),
    created_at: text(row, "created_at"),
    expires_at: text(row, "expires_at"),
  }));
}

/**
 * A refused console write: the status and the server's own message. Pages
 * render a localised generic failure as the primary notice and interpolate
 * `message` as secondary detail (`admin.refusalDetail`), never verbatim alone.
 */
export class AdminWriteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminWriteError";
    this.status = status;
  }
}

function refusal(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      if (typeof parsed.error === "string") return parsed.error;
    }
  } catch {
  }
  return raw;
}

async function write(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
    redirect: "manual",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new AdminWriteError(res.status, refusal(await res.text()));
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function setFlag(key: string, enabled: boolean): Promise<void> {
  await write("PATCH", "/flags", { key, enabled });
}

export async function setPlan(workspaceId: string, planId: string): Promise<void> {
  await write("PATCH", `/workspaces/${encodeURIComponent(workspaceId)}/plan`, { planId });
}

export async function setWorkspaceSlug(workspaceId: string, slug: string): Promise<void> {
  await write("PATCH", `/workspaces/${encodeURIComponent(workspaceId)}/slug`, { slug });
}

export type GrantInput = {
  workspaceId: string;
  operatorLogin: string;
  reason: string;
  ttlHours: number;
};

export async function createGrant(input: GrantInput): Promise<void> {
  await write("POST", "/support-grants", input);
}

export async function revokeGrant(id: string): Promise<void> {
  await write("DELETE", `/support-grants/${encodeURIComponent(id)}`);
}

/** A plan of the catalogue, as the quota form labels one ceiling field per plan. */
export type QuotaPlan = { id: string; name: string };

/** One `GET /api/quota-versions` row — the profile plus its derived interval. */
export type QuotaVersionRow = {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: "current" | "scheduled" | "past";
  base: { quick: number; default: number; deep: number };
  source: { byok: number; shared: number };
  rpPerCredit: number;
  notes: string | null;
  monthlyRp: Record<string, number | null>;
};

export type QuotaVersionsData = {
  judgingVersion: number;
  nextVersion: number;
  plans: QuotaPlan[];
  versions: QuotaVersionRow[];
  uncoveredPlanIds: string[];
};

/** The candidate numbers a preview and a publish share. */
export type QuotaCandidate = {
  effectiveFrom: string;
  base: { quick: number; default: number; deep: number };
  source: { byok: number; shared: number };
  rpPerCredit: number;
  monthlyRp: Record<string, number | null>;
};

export type QuotaImpact = { count: number; total: number; startsOn: string };

function planIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string")) {
    throw new Error("admin API: uncoveredPlanIds must be a list of plan ids");
  }
  return value;
}

function quotaCeilings(value: unknown, what: string): Record<string, number | null> {
  const ceilings: Record<string, number | null> = {};
  for (const [planId, entry] of Object.entries(map(value, what))) {
    if (entry !== null && typeof entry !== "number") {
      throw new Error(`admin API: ${what}.${planId} is neither a number nor null`);
    }
    ceilings[planId] = entry;
  }
  return ceilings;
}

export async function readQuotaVersions(): Promise<QuotaVersionsData> {
  const body = map(await fetchJson(`${BASE}/quota-versions`), "quota versions response");
  return {
    judgingVersion: num(body, "judgingVersion"),
    nextVersion: num(body, "nextVersion"),
    plans: list(body.plans, "plans").map((row) => ({ id: text(row, "id"), name: text(row, "name") })),
    uncoveredPlanIds: planIds(body.uncoveredPlanIds),
    versions: list(body.versions, "versions").map((row) => {
      const state = text(row, "state");
      if (state !== "current" && state !== "scheduled" && state !== "past") {
        throw new Error(`admin API: quota version state is not current|scheduled|past`);
      }
      const base = map(row.base, "base");
      const source = map(row.source, "source");
      return {
        id: text(row, "id"),
        version: num(row, "version"),
        effectiveFrom: text(row, "effectiveFrom"),
        effectiveTo: maybeText(row, "effectiveTo"),
        state,
        base: { quick: num(base, "quick"), default: num(base, "default"), deep: num(base, "deep") },
        source: { byok: num(source, "byok"), shared: num(source, "shared") },
        rpPerCredit: num(row, "rpPerCredit"),
        notes: maybeText(row, "notes"),
        monthlyRp: quotaCeilings(row.monthlyRp, "monthlyRp"),
      };
    }),
  };
}

/** The candidate numbers' impact at today's usage. Writes nothing. */
export async function previewQuotaVersion(candidate: QuotaCandidate): Promise<QuotaImpact> {
  const body = map(
    await write("POST", "/quota-versions/preview", candidate),
    "quota impact response",
  );
  return { count: num(body, "count"), total: num(body, "total"), startsOn: text(body, "startsOn") };
}

/**
 * Publish one version, answering the ordinal the server minted. The preview is
 * part of the body: a publish without one is refused, and so is one whose
 * numbers moved since it was shown.
 */
export async function createQuotaVersion(
  candidate: QuotaCandidate,
  notes: string | null,
  impact: QuotaImpact,
): Promise<number> {
  const answer = await write("POST", "/quota-versions", { ...candidate, notes, impact });
  return num(map(answer, "quota version response"), "version");
}

/**
 * One registered data upgrade (spec operator-data-upgrade § Upgrade registry
 * and state machine). The console states what the registry declared plus the
 * state row: `pending` is the documented state of an upgrade never started.
 */
export type DataUpgradeStatus = "pending" | "running" | "verifying" | "completed" | "failed";

export type DataUpgradeState = {
  status: DataUpgradeStatus;
  processed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};

/** The counts an item reports: preflight before, verify after. */
export type DataUpgradeCounts = Record<string, number>;

/** One `GET /api/data-upgrades` row. */
export type DataUpgradeRow = {
  id: string;
  title: string;
  impact: string;
  requiresDowntime: boolean;
  state: DataUpgradeState;
  preflight: DataUpgradeCounts;
};

const UPGRADE_STATUSES: readonly DataUpgradeStatus[] = [
  "pending",
  "running",
  "verifying",
  "completed",
  "failed",
];

function upgradeStatus(value: unknown): DataUpgradeStatus {
  const known = UPGRADE_STATUSES.find((status) => status === value);
  if (known === undefined) {
    throw new Error(`admin API: data upgrade status is not ${UPGRADE_STATUSES.join("|")}`);
  }
  return known;
}

function upgradeCounts(value: unknown, what: string): DataUpgradeCounts {
  const counts: DataUpgradeCounts = {};
  for (const [name, entry] of Object.entries(map(value, what))) {
    if (typeof entry !== "number") throw new Error(`admin API: ${what}.${name} is not a number`);
    counts[name] = entry;
  }
  return counts;
}

function upgradeState(value: unknown): DataUpgradeState {
  const row = map(value, "data upgrade state");
  return {
    status: upgradeStatus(row.status),
    processed: num(row, "processed"),
    startedAt: maybeText(row, "startedAt"),
    finishedAt: maybeText(row, "finishedAt"),
    lastError: maybeText(row, "lastError"),
  };
}

export async function readDataUpgrades(): Promise<DataUpgradeRow[]> {
  const body = map(await fetchJson(`${BASE}/data-upgrades`), "data upgrades response");
  return list(body.upgrades, "upgrades").map((row) => ({
    id: text(row, "id"),
    title: text(row, "title"),
    impact: text(row, "impact"),
    requiresDowntime: bool(row, "requiresDowntime"),
    state: upgradeState(row.state),
    preflight: upgradeCounts(row.preflight, "preflight"),
  }));
}

/** What one batch did: the rows it moved and whether anything is left. */
export type UpgradeBatch = { processed: number; done: boolean };

export type UpgradeStepAnswer = { state: DataUpgradeState; batch: UpgradeBatch };
export type UpgradeVerifyAnswer = { state: DataUpgradeState; checks: DataUpgradeCounts };

/** Read-only: recomputes the item's counts and writes no state. */
export async function preflightDataUpgrade(id: string): Promise<DataUpgradeCounts> {
  const body = map(
    await write("POST", `/data-upgrades/${encodeURIComponent(id)}/preflight`),
    "preflight response",
  );
  return upgradeCounts(body.preflight, "preflight");
}

/** ONE batch. `done` means the walk is finished — the item stays `running`. */
export async function stepDataUpgrade(id: string): Promise<UpgradeStepAnswer> {
  const body = map(
    await write("POST", `/data-upgrades/${encodeURIComponent(id)}/step`),
    "step response",
  );
  const batch = map(body.batch, "step batch");
  return {
    state: upgradeState(body.state),
    batch: { processed: num(batch, "processed"), done: bool(batch, "done") },
  };
}

/** Ends the item `completed` on all-zero checks, `failed` on any other. */
export async function verifyDataUpgrade(id: string): Promise<UpgradeVerifyAnswer> {
  const body = map(
    await write("POST", `/data-upgrades/${encodeURIComponent(id)}/verify`),
    "verify response",
  );
  return { state: upgradeState(body.state), checks: upgradeCounts(body.checks, "checks") };
}

/** Back to `pending` from any state; migrated rows are never undone. */
export async function resetDataUpgrade(id: string): Promise<DataUpgradeState> {
  const body = map(
    await write("POST", `/data-upgrades/${encodeURIComponent(id)}/reset`),
    "reset response",
  );
  return upgradeState(body.state);
}

/**
 * One read per screen, plus its retry/refresh and an in-place update.
 *
 * `read` must be a module-level function: a new closure each render would
 * re-run the effect on every render.
 */
export function useLoaded<T>(read: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    read().then(
      (data) => {
        if (live) setState({ status: "ready", data });
      },
      () => {
        if (live) setState({ status: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [read, attempt]);

  return {
    state,
    reload: () => setAttempt((count) => count + 1),
    update: (change: (data: T) => T) =>
      setState((previous) =>
        previous.status === "ready" ? { status: "ready", data: change(previous.data) } : previous,
      ),
  };
}
