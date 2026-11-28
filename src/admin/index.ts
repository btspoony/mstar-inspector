import { RECONCILE_LIMITS } from "../contracts/reconcile-settings";
import { Hono } from "hono";
import { isPlatformOperator, workspaceBoot } from "../dashboard/index";
import {
  listBotScopes,
  readBotOwnerWorkspace,
  setAppScope,
  setReviewBotScope,
  type BotScope,
} from "../dashboard/apps-store";
import { listAllActiveSupportGrants } from "../dashboard/operator-store";
import {
  CHECK_TERMINALIZE_MAX,
  CHECK_TERMINALIZE_MIN,
  CHECK_UPDATE_MAX,
  CHECK_UPDATE_MIN,
  COMMENT_CLAIM_ATTEMPTS_MAX,
  COMMENT_CLAIM_ATTEMPTS_MIN,
  COMMENT_CLAIM_OUTBOX_MAX,
  COMMENT_CLAIM_OUTBOX_MIN,
  COMMENT_CLAIM_RETRY_MAX,
  COMMENT_CLAIM_RETRY_MIN,
  CONCURRENCY_MIN,
  LOST_REPLY_SETTLE_MAX_MS,
  LOST_REPLY_SETTLE_MIN_MS,
  RECHECK_ASSIGNMENT_MAX,
  RECHECK_ASSIGNMENT_MIN,
  REVIEW_ATTEMPT_CAP_MAX_MS,
  SEATS_SMALL_DIFF_LINES_MAX,
  SEATS_SMALL_DIFF_LINES_MIN,
  SEATS_SMALL_DIFF_SEATS_MAX,
  SEATS_SMALL_DIFF_SEATS_MIN,
  REVIEW_ATTEMPT_CAP_MIN_MS,
  RuntimeConfigError,
  SWEEP_LIMITS,
  SYSTEM_CONCURRENCY_MAX,
  UnknownWorkspaceError,
  getCheckBudgets,
  getCommentClaimSettings,
  getLostReplySettleMs,
  getMaintenanceMode,
  getRecheckAssignmentMaxBytes,
  getReviewAttemptCapSetting,
  getSweepSettings,
  getReviewSeatSettings,
  getReconcileSettings,
  setReconcileSettings,
  getSystemConcurrency,
  isConcurrencyValue,
  readDefaultReviewLevel,
  readOfficialWorkspaceId,
  setCheckBudgets,
  setCommentClaimSettings,
  setDefaultReviewLevel,
  setLostReplySettleMs,
  setMaintenanceMode,
  setOfficialWorkspace,
  setRecheckAssignmentMaxBytes,
  setReviewAttemptCap,
  setReviewSeatSettings,
  setSweepSettings,
  setSystemConcurrency,
  reviewRunState,
  type CheckBudgetValues,
  type CommentClaimValues,
  type ReviewsRunAnswer,
} from "../dashboard/runtime-config-store";
import { REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import { resolveLocale, t, type Locale } from "../i18n";
import { injectSpaBoot } from "../spa/boot";
import { localizeDocument } from "../worker/document-locale";
import { ADMIN_PAGES } from "../spa/admin/pages";
import { RESERVED_WORKSPACE_SLUGS } from "../spa/routes";
import { createFailureStore } from "../store/failure-store";
import type { DashboardD1 } from "../dashboard/users";
import type { Env } from "../worker/env";
import { isServerFlagKey, listFlags } from "./flags";
import {
  DURATION_REPORT_CAP_MAX_MS,
  DURATION_REPORT_CAP_MIN_MS,
} from "../contracts/duration-report";
import { readReviewDurationReport } from "./duration-report";
import { readBotMultipliers } from "./bot-multipliers";
import {
  findDataUpgrade,
  listDataUpgrades,
  resetDataUpgrade,
  stepDataUpgrade,
  verifyDataUpgrade,
} from "./data-upgrades";
import { operatorLogin, type AdminContext } from "./gate";
import { createRepoLookup } from "./installation-repositories";
import { redactSecrets } from "../pipeline/redact";
import { requestMaintenanceReplay, type MaintenanceReplayOutcome } from "./maintenance-replay";
import { createSupportGrant, revokeSupportGrant } from "./support-grants";
import { listUsers } from "./users";
import { readReviewUsage, reviewUsageMonth } from "../dashboard/review-usage-store";
import { WORKSPACE_SLUG_PATTERN, listWorkspaces, setWorkspacePlan, setWorkspaceSlug } from "./workspaces";
import {
  createQuotaVersion,
  listPlans,
  listQuotaVersions,
  parseQuotaCandidate,
  parseQuotaImpact,
  parseQuotaNumbers,
  previewQuotaImpact,
} from "./quota-versions";
import { quotaMonth } from "../store/quota-store";

type AdminRoute = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  handler: (c: AdminContext) => Response | Promise<Response>;
};

async function readFlags(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ flags: await listFlags(db) });
}

async function setFlag(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let key: unknown;
  let enabled: unknown;
  try {
    const body = (await c.req.json()) as { key?: unknown; enabled?: unknown };
    key = body.key;
    enabled = body.enabled;
  } catch {
  }
  if (!isServerFlagKey(key) || typeof enabled !== "boolean") {
    return c.json({ error: "body must be { key: <server flag key>, enabled: <boolean> }" }, 400);
  }
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         SELECT ?, ?, 'flag.set', 'flag', ?,
                json_object(
                  'before',
                  json(CASE WHEN COALESCE((SELECT enabled FROM server_flags WHERE key = ?), 1) = 1
                            THEN 'true' ELSE 'false' END),
                  'after',
                  json(?)
                ),
                ?`,
      )
      .bind(crypto.randomUUID(), login, key, key, enabled ? "true" : "false", now),
    db
      .prepare(
        `INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(key, enabled ? 1 : 0, now, login),
  ]);
  return c.json({ key, enabled });
}

type RuntimeQueue = {
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestamp: string | null;
};

type QueueGaugeSource = {
  metrics?: () => Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp?: Date }>;
};

async function readQueueBacklog(queue: QueueGaugeSource | undefined): Promise<RuntimeQueue | null> {
  try {
    const metrics = await queue?.metrics?.();
    if (!metrics) return null;
    return {
      backlogCount: metrics.backlogCount,
      backlogBytes: metrics.backlogBytes,
      oldestMessageTimestamp: metrics.oldestMessageTimestamp?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Apps whose reviews are paused. `review_enabled` is the App-level operational
 * pause; the per-repository pause lives on the target and is a different
 * answer, so it is not folded in here.
 */
const PAUSED_APPS_SQL = `
  SELECT COUNT(*) AS n
    FROM github_apps
   WHERE deleted_at IS NULL AND review_enabled = 0`;

async function readPausedApps(db: DashboardD1): Promise<number | null> {
  try {
    const row = await db.prepare(PAUSED_APPS_SQL).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

/** The Apps list the pause link opens. `/dashboard` alone lands on the
 * repository overview, and the unscoped `/dashboard/apps` is one of the two
 * redirect roots (also the repository overview), so the address needs a
 * workspace segment — the same one sign-in would land this operator on.
 *
 * The link exists so the operator can change review state, so it prefers the
 * first membership whose role can manage Apps (`owner` or `admin`) — an
 * ordinary `member` workspace would open the same page read-only. A
 * sole-workspace deployment (`boot.workspaceRef`) keeps its own answer next,
 * and only when no membership qualifies does the link fall back to
 * `memberships[0]` (the list is ordered by workspace name): an
 * arbitrary-but-stable choice, because this operator page has no workspace
 * context of its own and picking none would hide the link from every
 * multi-workspace operator. The App pause link is a convenience, not a scoped
 * answer — the payload's own facts are all platform-wide.
 */
async function readAppsHref(env: Env, login: string): Promise<string | null> {
  try {
    const boot = await workspaceBoot(env, login);
    const managed = boot.memberships.find((row) => row.role === "owner" || row.role === "admin");
    const ref = managed?.id ?? boot.workspaceRef ?? boot.memberships[0]?.id;
    return ref === undefined ? null : `/dashboard/${ref}/apps`;
  } catch {
    return null;
  }
}

async function readRuntime(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const failures = createFailureStore(db);
  // The maintenance window is read ONCE and handed to the derivation: the
  // card's answer and its `maintenance` block must name the same read, or the
  // answer could say paused-maintenance beside a window shown open.
  const maintenance = await getMaintenanceMode(db);
  const [
    system,
    budgets,
    claim,
    sweep,
    reconcile,
    level,
    recheck,
    attemptCap,
    seats,
    reviews,
    lostReplySettle,
    officialWorkspaceId,
    admissionDrops24h,
    githubRateLimited24h,
    queue,
    pausedApps,
    appsHref,
  ] = await Promise.all([
    getSystemConcurrency(db),
    getCheckBudgets(db),
    getCommentClaimSettings(db),
    getSweepSettings(db),
    getReconcileSettings(db),
    readDefaultReviewLevel(db),
    getRecheckAssignmentMaxBytes(db),
    getReviewAttemptCapSetting(db),
    getReviewSeatSettings(db),
    reviewRunState(db, maintenance),
    getLostReplySettleMs(db),
    readOfficialWorkspaceId(db),
    failures.countAdmissionDrops24h(),
    failures.countGithubRateLimited24h(),
    readQueueBacklog(c.env.REVIEW_QUEUE),
    readPausedApps(db),
    readAppsHref(c.env, login),
  ]);
  return c.json({
    concurrency: system.concurrency,
    min: CONCURRENCY_MIN,
    max: SYSTEM_CONCURRENCY_MAX,
    degraded: system.degraded,
    officialWorkspaceId,
    checkBudgets: {
      terminalizeMs: budgets.terminalizeMs,
      updateMs: budgets.updateMs,
      terminalizeMin: CHECK_TERMINALIZE_MIN,
      terminalizeMax: CHECK_TERMINALIZE_MAX,
      updateMin: CHECK_UPDATE_MIN,
      updateMax: CHECK_UPDATE_MAX,
      degraded: budgets.degraded,
    },
    commentClaim: {
      retryMs: claim.retryMs,
      maxAttempts: claim.maxAttempts,
      outboxCap: claim.outboxCap,
      retryMin: COMMENT_CLAIM_RETRY_MIN,
      retryMax: COMMENT_CLAIM_RETRY_MAX,
      attemptsMin: COMMENT_CLAIM_ATTEMPTS_MIN,
      attemptsMax: COMMENT_CLAIM_ATTEMPTS_MAX,
      outboxMin: COMMENT_CLAIM_OUTBOX_MIN,
      outboxMax: COMMENT_CLAIM_OUTBOX_MAX,
      degraded: claim.degraded,
    },
    reconcile: { values: reconcile.values, limits: RECONCILE_LIMITS, degraded: reconcile.issue !== null },
    sweep: {
      values: sweep.values,
      limits: SWEEP_LIMITS,
      degraded: sweep.issue !== null,
      invalid: sweep.issue?.kind === "invalid_rows" ? sweep.issue.fields : [],
    },
    reviewLevel: { value: level.value, levels: REVIEW_LEVELS, degraded: level.degraded },
    recheckAssignment: {
      maxBytes: recheck.maxBytes,
      min: RECHECK_ASSIGNMENT_MIN,
      max: RECHECK_ASSIGNMENT_MAX,
      degraded: recheck.degraded,
    },
    attemptCap: {
      capMs: attemptCap.capMs,
      saved: attemptCap.saved,
      min: REVIEW_ATTEMPT_CAP_MIN_MS,
      max: REVIEW_ATTEMPT_CAP_MAX_MS,
      degraded: attemptCap.degraded,
    },
    // Effective values plus their bounds; PATCH `seatSettings` owns the writes.
    seatSettings: {
      smallDiffMaxLines: seats.smallDiffMaxLines,
      smallDiffSeats: seats.smallDiffSeats,
      linesMin: SEATS_SMALL_DIFF_LINES_MIN,
      linesMax: SEATS_SMALL_DIFF_LINES_MAX,
      seatsMin: SEATS_SMALL_DIFF_SEATS_MIN,
      seatsMax: SEATS_SMALL_DIFF_SEATS_MAX,
      degraded: seats.degraded,
    },
    routeWorkflow: reviews.gate,
    lostReplySettle: {
      settleMs: lostReplySettle.settleMs,
      min: LOST_REPLY_SETTLE_MIN_MS,
      max: LOST_REPLY_SETTLE_MAX_MS,
      degraded: lostReplySettle.degraded,
    },
    admissionDrops24h,
    githubRateLimited24h,
    queue,
    reviewsRunning: {
      // The shared derivation verbatim — `paused-maintenance` included — so
      // the card can never name a cause the queue did not act on.
      // `unreadableSource` rides along so an `unreadable-state` sentence names
      // WHICH read failed instead of blaming the gate beside its own `on`.
      answer: reviews.state,
      platform: reviews.platform,
      unreadableSource: reviews.unreadableSource ?? null,
      pausedApps,
      appsHref,
    },
    maintenance,
  });
}

async function readDurationReport(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const rawCap = c.req.query("capMs");
  let capMs: number | null = null;
  if (rawCap !== undefined) {
    const parsed = Number(rawCap);
    if (!Number.isInteger(parsed) || parsed < DURATION_REPORT_CAP_MIN_MS || parsed > DURATION_REPORT_CAP_MAX_MS) {
      return c.json(
        {
          error: `capMs must be an integer in ${DURATION_REPORT_CAP_MIN_MS}..${DURATION_REPORT_CAP_MAX_MS}`,
        },
        400,
      );
    }
    capMs = parsed;
  }
  return c.json(await readReviewDurationReport(db, { nowMs: Date.now(), capMs }));
}

function commentClaimBody(value: unknown): CommentClaimValues | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { retryMs, maxAttempts, outboxCap } = value as {
    retryMs?: unknown;
    maxAttempts?: unknown;
    outboxCap?: unknown;
  };
  return typeof retryMs === "number" && typeof maxAttempts === "number" && typeof outboxCap === "number"
    ? { retryMs, maxAttempts, outboxCap }
    : null;
}

function reviewLevelValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { value: level } = value as { value?: unknown };
  return typeof level === "string" ? level : null;
}
function checkBudgetsBody(value: unknown): CheckBudgetValues | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { terminalizeMs, updateMs } = value as { terminalizeMs?: unknown; updateMs?: unknown };
  return typeof terminalizeMs === "number" && typeof updateMs === "number"
    ? { terminalizeMs, updateMs }
    : null;
}

function maintenanceBody(value: unknown): { enabled: boolean; reason?: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { enabled, reason } = value as { enabled?: unknown; reason?: unknown };
  if (typeof enabled !== "boolean") return null;
  if (reason !== undefined && reason !== null && typeof reason !== "string") return null;
  return { enabled, reason };
}

async function setRuntime(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let concurrency: unknown;
  let rawBudgets: unknown;
  let rawClaim: unknown;
  let rawSweep: unknown;
  let rawReconcile: unknown;
  let rawLevel: unknown;
  let rawRecheck: unknown;
  let rawAttemptCap: unknown;
  let rawLostReply: unknown;
  let rawMaintenance: unknown;
  let rawRouteWorkflow: unknown;
  let rawSeatSettings: unknown;
  try {
    const body = (await c.req.json()) as {
      concurrency?: unknown;
      checkBudgets?: unknown;
      commentClaim?: unknown;
      sweep?: unknown;
      reconcile?: unknown;
      reviewLevel?: unknown;
      recheckAssignment?: unknown;
      attemptCap?: unknown;
      lostReplySettle?: unknown;
      maintenance?: unknown;
      routeWorkflow?: unknown;
      seatSettings?: unknown;
    };
    concurrency = body.concurrency;
    rawBudgets = body.checkBudgets;
    rawClaim = body.commentClaim;
    rawSweep = body.sweep;
    rawReconcile = body.reconcile;
    rawLevel = body.reviewLevel;
    rawRecheck = body.recheckAssignment;
    rawAttemptCap = body.attemptCap;
    rawLostReply = body.lostReplySettle;
    rawMaintenance = body.maintenance;
    rawRouteWorkflow = body.routeWorkflow;
    rawSeatSettings = body.seatSettings;
  } catch {
  }
  // `routeWorkflow` is gone from this surface: name the removed capability
  // instead of falling through to the concurrency validator, which would tell a
  // stale client the wrong field is wrong.
  if (rawRouteWorkflow !== undefined) {
    return c.json(
      {
        error:
          "routeWorkflow is no longer writable here: the review routing gate is owned by the deploy pipeline and opens after a successful deploy",
      },
      400,
    );
  }
  if (
    [
      concurrency,
      rawBudgets,
      rawClaim,
      rawSweep,
      rawReconcile,
      rawLevel,
      rawRecheck,
      rawAttemptCap,
      rawLostReply,
      rawMaintenance,
      rawSeatSettings,
    ].filter((value) => value !== undefined).length > 1
  ) {
    return c.json(
      {
        error:
          "body must carry exactly one of concurrency | checkBudgets | commentClaim | sweep | reconcile | reviewLevel | recheckAssignment | attemptCap | lostReplySettle | maintenance | seatSettings",
      },
      400,
    );
  }
  if (rawMaintenance !== undefined) {
    const mode = maintenanceBody(rawMaintenance);
    if (mode === null) {
      return c.json({ error: "body must be { maintenance: { enabled, reason? } }" }, 400);
    }
    const now = new Date().toISOString();
    await setMaintenanceMode(db, { ...mode, actor: login }, now);
    return c.json({ maintenance: await getMaintenanceMode(db) });
  }
  if (rawClaim !== undefined) {
    const trio = commentClaimBody(rawClaim);
    if (trio === null) {
      return c.json(
        { error: "body must be { commentClaim: { retryMs, maxAttempts, outboxCap } }" },
        400,
      );
    }
    try {
      return c.json({ commentClaim: await setCommentClaimSettings(db, trio, login) });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawReconcile !== undefined) {
    try {
      return c.json({ reconcile: await setReconcileSettings(db, rawReconcile, login) });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawSweep !== undefined) {
    try {
      return c.json({ sweep: await setSweepSettings(db, rawSweep, login) });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawRecheck !== undefined) {
    const maxBytes =
      typeof rawRecheck === "object" && rawRecheck !== null && "maxBytes" in rawRecheck
        ? rawRecheck.maxBytes
        : undefined;
    if (typeof maxBytes !== "number") {
      return c.json({ error: "body must be { recheckAssignment: { maxBytes } }" }, 400);
    }
    try {
      return c.json({
        recheckAssignment: {
          maxBytes: await setRecheckAssignmentMaxBytes(db, maxBytes, login),
        },
      });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawAttemptCap !== undefined) {
    const capMs =
      typeof rawAttemptCap === "object" && rawAttemptCap !== null && "capMs" in rawAttemptCap
        ? rawAttemptCap.capMs
        : undefined;
    if (typeof capMs !== "number") {
      return c.json({ error: "body must be { attemptCap: { capMs } }" }, 400);
    }
    try {
      return c.json({ attemptCap: { capMs: await setReviewAttemptCap(db, capMs, login) } });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawLostReply !== undefined) {
    const settleMs =
      typeof rawLostReply === "object" && rawLostReply !== null && "settleMs" in rawLostReply
        ? rawLostReply.settleMs
        : undefined;
    if (typeof settleMs !== "number") {
      return c.json({ error: "body must be { lostReplySettle: { settleMs } }" }, 400);
    }
    try {
      return c.json({ lostReplySettle: { settleMs: await setLostReplySettleMs(db, settleMs, login) } });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawLevel !== undefined) {
    const level = reviewLevelValue(rawLevel);
    if (level === null) {
      return c.json({ error: "body must be { reviewLevel: { value } }" }, 400);
    }
    try {
      return c.json({
        reviewLevel: { value: await setDefaultReviewLevel(db, level as ReviewLevel, login) },
      });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawSeatSettings !== undefined) {
    const pair =
      typeof rawSeatSettings === "object" && rawSeatSettings !== null
        ? (rawSeatSettings as { smallDiffMaxLines?: unknown; smallDiffSeats?: unknown })
        : {};
    if (typeof pair.smallDiffMaxLines !== "number" || typeof pair.smallDiffSeats !== "number") {
      return c.json(
        { error: "body must be { seatSettings: { smallDiffMaxLines, smallDiffSeats } }" },
        400,
      );
    }
    try {
      return c.json({
        seatSettings: await setReviewSeatSettings(
          db,
          { smallDiffMaxLines: pair.smallDiffMaxLines, smallDiffSeats: pair.smallDiffSeats },
          login,
        ),
      });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (rawBudgets !== undefined) {
    const pair = checkBudgetsBody(rawBudgets);
    if (pair === null) {
      return c.json({ error: "body must be { checkBudgets: { terminalizeMs, updateMs } }" }, 400);
    }
    try {
      return c.json({ checkBudgets: await setCheckBudgets(db, pair, login) });
    } catch (error) {
      if (error instanceof RuntimeConfigError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }
  if (!isConcurrencyValue(concurrency, SYSTEM_CONCURRENCY_MAX)) {
    return c.json(
      { error: `body must be { concurrency: <integer in ${CONCURRENCY_MIN}..${SYSTEM_CONCURRENCY_MAX}> }` },
      400,
    );
  }
  return c.json({ concurrency: await setSystemConcurrency(db, concurrency, login) });
}

async function assignOfficialWorkspace(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let value: unknown;
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (typeof body === "object" && body !== null && "workspaceId" in body) {
      value = body.workspaceId;
    }
  } catch {
  }
  if (!(value === null || (typeof value === "string" && value.length > 0))) {
    return c.json({ error: "body must be { workspaceId: <id> | null }" }, 400);
  }
  try {
    return c.json({
      workspaceId: await setOfficialWorkspace(db, {
        workspaceId: value,
        actor: login,
        now: new Date().toISOString(),
      }),
    });
  } catch (error) {
    if (error instanceof UnknownWorkspaceError) return c.json({ error: "workspace not found" }, 400);
    throw error;
  }
}

/**
 * The shared console scope-switch handler. `kind` picks the entity and the
 * column: the APP route (`/api/bots/:botId/scope`, kept at its pre-split
 * path) writes `github_apps.scope` audited as `runtime.app_scope.set`; the
 * BOT route (`/api/review-bots/:botId/scope`, distinct) writes
 * `review_bots.scope` audited as `runtime.bot_scope.set`.
 */
function assignScopeSwitch(kind: "app" | "bot") {
  return async function assignScope(c: AdminContext): Promise<Response> {
    const login = await operatorLogin(c);
    if (!login) return c.notFound();
    const db = c.env.DB;
    if (!db) return c.notFound();
    let scope: unknown;
    let confirm: unknown;
    try {
      const body = (await c.req.json()) as { scope?: unknown; confirm?: unknown };
      scope = body.scope;
      confirm = body.confirm;
    } catch {
    }
    if (scope !== "owned" && scope !== "shared") {
      return c.json({ error: 'body must be { scope: "owned" | "shared" }' }, 400);
    }
    const botId = c.req.param("botId");
    if (!botId) return c.notFound();
    const args = {
      scope: scope as BotScope,
      confirm: confirm === true,
      actor: login,
      now: new Date().toISOString(),
    };
    // F12: the bot write re-checks ownership at the store boundary, so the
    // console passes the bot's own workspace as the authorizing authority —
    // the operator console is not a tenant caller.
    const ownerWorkspace =
      kind === "app" ? null : await readBotOwnerWorkspace(db, botId);
    const outcome =
      kind === "app"
        ? await setAppScope(db, { appId: botId, ...args })
        : await setReviewBotScope(db, {
            botId,
            ...args,
            authority: { workspaceId: ownerWorkspace ?? "", role: "owner" },
          });
    const noun = kind === "app" ? "app" : "bot";
    if (outcome.outcome === "bot_not_found") return c.json({ error: `${noun} not found` }, 404);
    if (outcome.outcome === "forbidden") return c.json({ error: "forbidden" }, 403);
    if (outcome.outcome === "archived") {
      return c.json({ error: `${noun} is archived — restore it before changing its scope` }, 409);
    }
    if (outcome.outcome === "outside_official_workspace") {
      return c.json({ error: `${noun} is outside the official workspace` }, 409);
    }
    if (outcome.outcome === "confirm_required") {
      return c.json({ error: "unsharing requires confirm: true" }, 400);
    }
    return c.json({ botId, scope: outcome.scope, sharedAt: outcome.sharedAt });
  };
}

const assignAppScope = assignScopeSwitch("app");
const assignReviewBotScope = assignScopeSwitch("bot");

async function readBots(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const rows = await listBotScopes(db);
  return c.json({
    bots: rows.map((row) => ({
      botId: row.id,
      name: row.name,
      githubAppId: row.github_app_id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      isOfficial: Boolean(row.is_official),
      scope: row.scope,
      sharedAt: row.shared_at,
      botScope: row.bot_scope,
      botSharedAt: row.bot_shared_at,
      installationCount: row.installation_count,
      liveTargetCount: row.live_target_count,
      deletedAt: row.deleted_at,
    })),
  });
}

async function readWorkspaces(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ workspaces: await listWorkspaces(db, new Date().toISOString()) });
}

async function readUsage(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const window = reviewUsageMonth(new Date());
  return c.json({ month: window.month, workspaces: await readReviewUsage(db, window, null) });
}

async function readUsers(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const users = await listUsers(db, new Date().toISOString());
  return c.json({
    users: users.map((user) => ({ ...user, isOperator: isPlatformOperator(c.env, user.login) })),
  });
}

async function assignPlan(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let planId: unknown;
  try {
    const body = (await c.req.json()) as { planId?: unknown };
    planId = body.planId;
  } catch {
  }
  if (typeof planId !== "string" || planId.length === 0) {
    return c.json({ error: "body must be { planId: <id from the plans catalogue> }" }, 400);
  }
  const workspaceId = c.req.param("id");
  if (!workspaceId) return c.notFound();
  const outcome = await setWorkspacePlan(db, {
    workspaceId,
    planId,
    actorLogin: login,
    now: new Date().toISOString(),
  });
  if (outcome.kind === "unknown_plan") {
    return c.json(
      { error: `unknown planId ${JSON.stringify(planId)}: the plans catalogue has no such row` },
      400,
    );
  }
  if (outcome.kind === "unknown_workspace") {
    return c.json({ error: "workspace not found" }, 404);
  }
  return c.json({ workspaceId, planId: outcome.planId });
}

async function setSlug(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let slug: unknown;
  try {
    const body = (await c.req.json()) as { slug?: unknown };
    slug = body.slug;
  } catch {
  }
  if (typeof slug !== "string" || !WORKSPACE_SLUG_PATTERN.test(slug)) {
    return c.json(
      { error: "body must be { slug: 2-39 lowercase letters, digits or hyphens, starting with a letter or digit }" },
      400,
    );
  }
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) {
    return c.json({ error: `slug ${JSON.stringify(slug)} is reserved by the dashboard` }, 409);
  }
  const workspaceId = c.req.param("id");
  if (!workspaceId) return c.notFound();
  const outcome = await setWorkspaceSlug(db, {
    workspaceId,
    slug,
    actorLogin: login,
    now: new Date().toISOString(),
  });
  if (outcome.kind === "slug_taken") {
    return c.json({ error: `another workspace already uses the slug ${JSON.stringify(slug)}` }, 409);
  }
  if (outcome.kind === "slug_is_workspace_id") {
    return c.json({ error: `slug ${JSON.stringify(slug)} is another workspace's id` }, 409);
  }
  if (outcome.kind === "unknown_workspace") {
    return c.json({ error: "workspace not found" }, 404);
  }
  return c.json({ workspaceId, slug: outcome.slug });
}

async function readQuotaVersions(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json(await listQuotaVersions(db, new Date()));
}

async function previewQuotaVersion(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let parsed: unknown = {};
  try {
    parsed = await c.req.json();
  } catch {
  }
  const plans = await listPlans(db);
  const candidate = parseQuotaCandidate(
    parsed,
    plans.map((plan) => plan.id),
  );
  if (!candidate.ok) return c.json({ error: candidate.error }, 400);
  return c.json(await previewQuotaImpact(db, candidate.value, new Date()));
}

async function publishQuotaVersion(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let parsed: unknown = {};
  try {
    parsed = await c.req.json();
  } catch {
  }
  const plans = await listPlans(db);
  const candidate = parseQuotaCandidate(
    parsed,
    plans.map((plan) => plan.id),
  );
  if (!candidate.ok) return c.json({ error: candidate.error }, 400);
  const numbers = parseQuotaNumbers(parsed);
  if (!numbers.ok) return c.json({ error: numbers.error }, 400);
  const now = new Date();
  const month = quotaMonth(now);
  if (candidate.value.effectiveFrom <= month.startIso) {
    return c.json(
      {
        error: `effectiveFrom must be after ${month.startIso.slice(0, 10)}: the month in progress keeps the version that covered its 1st`,
      },
      400,
    );
  }
  const impact = parseQuotaImpact(parsed);
  if (impact === null) {
    return c.json(
      {
        error:
          "body must carry the impact you previewed: POST /api/quota-versions/preview first, then publish with its { count, total, startsOn }",
      },
      400,
    );
  }
  const fresh = await previewQuotaImpact(db, candidate.value, now);
  if (fresh.count !== impact.count || fresh.total !== impact.total || fresh.startsOn !== impact.startsOn) {
    return c.json(
      {
        error: `the impact moved since it was previewed (it is ${fresh.count} of ${fresh.total} now); preview these numbers again before publishing`,
      },
      409,
    );
  }
  const outcome = await createQuotaVersion(db, { ...candidate.value, ...numbers.value }, now.toISOString(), login);
  if (outcome.kind === "effective_from_taken") {
    return c.json({ error: `another quota version already starts at ${candidate.value.effectiveFrom}` }, 409);
  }
  return c.json({ version: outcome.version, startsOn: fresh.startsOn }, 201);
}

async function readSupportGrants(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ grants: await listAllActiveSupportGrants(db, new Date().toISOString()) });
}

type GrantBody = {
  workspaceId?: unknown;
  operatorLogin?: unknown;
  reason?: unknown;
  ttlHours?: unknown;
};

async function createGrant(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let parsed: unknown = {};
  try {
    parsed = await c.req.json();
  } catch {
  }
  const invalid = (detail: string) => c.json({ error: `invalid support grant: ${detail}` }, 400);
  if (parsed === null || typeof parsed !== "object") return invalid("body must be a JSON object");
  const { workspaceId, operatorLogin: targetLogin, reason, ttlHours } = parsed as GrantBody;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return invalid("workspaceId must be a non-empty workspace id");
  }
  if (typeof targetLogin !== "string" || targetLogin.length === 0) {
    return invalid("operatorLogin must be a non-empty GitHub login");
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return invalid("reason must be non-empty");
  }
  const now = new Date();
  const expires =
    typeof ttlHours === "number" && Number.isFinite(ttlHours) && ttlHours > 0
      ? new Date(now.getTime() + ttlHours * 3_600_000)
      : null;
  if (expires === null || Number.isNaN(expires.getTime())) {
    return invalid("ttlHours must be a positive number of hours");
  }
  const outcome = await createSupportGrant(db, {
    workspaceId,
    operatorLogin: targetLogin,
    reason,
    grantedBy: login,
    now: now.toISOString(),
    expiresAt: expires.toISOString(),
  });
  if (outcome.kind === "unknown_workspace") {
    return invalid(`workspaceId ${JSON.stringify(workspaceId)} is not a live workspace`);
  }
  return c.json({ grant: outcome.grant }, 201);
}

async function revokeGrant(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const id = c.req.param("id");
  if (!id) return c.notFound();
  const outcome = await revokeSupportGrant(db, {
    id,
    actorLogin: login,
    now: new Date().toISOString(),
  });
  if (outcome.kind === "not_found") {
    return c.json({ error: `no support grant with id ${JSON.stringify(id)}` }, 404);
  }
  return c.json({ id, workspaceId: outcome.workspaceId });
}

async function readDataUpgrades(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ upgrades: await listDataUpgrades(db) });
}

async function dataUpgradeAction(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const id = c.req.param("id");
  const action = c.req.param("action");
  const item = id === undefined ? null : findDataUpgrade(id);
  if (item === null) return c.json({ error: `no data upgrade with id ${JSON.stringify(id)}` }, 404);
  const now = new Date().toISOString();
  if (action === "preflight") {
    return c.json({ id: item.id, preflight: await item.preflight(db) });
  }
  if (action === "step") {
    const outcome = await stepDataUpgrade(db, item, login, now, {
      repoLookup: createRepoLookup(db, c.env.DASHBOARD_ENCRYPTION_KEY),
    });
    return outcome.kind === "refused"
      ? c.json({ error: outcome.reason, state: outcome.state }, 409)
      : c.json({ state: outcome.state, batch: outcome.batch });
  }
  if (action === "verify") {
    const outcome = await verifyDataUpgrade(db, item, login, now);
    return outcome.kind === "refused"
      ? c.json({ error: outcome.reason, state: outcome.state }, 409)
      : c.json({ state: outcome.state, checks: outcome.checks });
  }
  if (action === "reset") {
    const outcome = await resetDataUpgrade(db, item, login, now);
    return outcome.kind === "refused"
      ? c.json({ error: outcome.reason, state: outcome.state }, 409)
      : c.json({ state: outcome.state });
  }
  return c.notFound();
}

async function replayMaintenanceDeferred(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const failureId = c.req.param("failureId");
  if (failureId === undefined) return c.notFound();
  let outcome: MaintenanceReplayOutcome;
  try {
    outcome = await requestMaintenanceReplay(db, c.env.REVIEW_QUEUE, {
      failureId,
      actor: login,
      now: new Date().toISOString(),
    });
  } catch {
    return c.json({ error: "replay_request_failed" }, 500);
  }
  if (outcome.kind === "refused") return c.json({ error: outcome.error }, outcome.status);
  if (outcome.kind === "repeat") return c.json({ failureId, state: outcome.state }, 200);
  return c.json({ failureId, state: outcome.state }, 202);
}

async function serveDocument(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const document = await c.env.ASSETS?.fetch(new URL("/admin.html", c.req.url));
  if (!document?.ok) return c.notFound();
  const locale = resolveLocale(c.req.raw);
  const html = localizeDocument(
    injectSpaBoot(await document.text(), {
      locale,
      login,
      name: null,
    }),
    locale,
    t(locale, "admin.documentTitle"),
  );
  return c.html(html, 200, { "cache-control": "private, no-store" });
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { method: "get", path: "/api/flags", handler: readFlags },
  { method: "patch", path: "/api/flags", handler: setFlag },
  { method: "get", path: "/api/runtime", handler: readRuntime },
  { method: "get", path: "/api/runtime/duration-report", handler: readDurationReport },
  { method: "get", path: "/api/runtime/bot-multipliers", handler: readBotMultipliers },
  { method: "patch", path: "/api/runtime", handler: setRuntime },
  { method: "get", path: "/api/workspaces", handler: readWorkspaces },
  { method: "get", path: "/api/users", handler: readUsers },
  { method: "get", path: "/api/usage", handler: readUsage },
  { method: "get", path: "/api/quota-versions", handler: readQuotaVersions },
  { method: "post", path: "/api/quota-versions/preview", handler: previewQuotaVersion },
  { method: "post", path: "/api/quota-versions", handler: publishQuotaVersion },
  { method: "patch", path: "/api/workspaces/:id/plan", handler: assignPlan },
  { method: "patch", path: "/api/workspaces/:id/slug", handler: setSlug },
  { method: "patch", path: "/api/official-workspace", handler: assignOfficialWorkspace },
  { method: "patch", path: "/api/bots/:botId/scope", handler: assignAppScope },
  { method: "patch", path: "/api/review-bots/:botId/scope", handler: assignReviewBotScope },
  { method: "get", path: "/api/bots", handler: readBots },
  { method: "get", path: "/api/support-grants", handler: readSupportGrants },
  { method: "post", path: "/api/support-grants", handler: createGrant },
  { method: "delete", path: "/api/support-grants/:id", handler: revokeGrant },
  { method: "get", path: "/api/data-upgrades", handler: readDataUpgrades },
  { method: "post", path: "/api/data-upgrades/:id/:action", handler: dataUpgradeAction },
  { method: "post", path: "/api/maintenance-deferred/:failureId/replay", handler: replayMaintenanceDeferred },
  { method: "get", path: "/", handler: serveDocument },
  ...ADMIN_PAGES.map((page) => ({ method: "get" as const, path: `/${page.id}`, handler: serveDocument })),
];

/** The admin sub-app. Exported as a mountable Hono instance for `src/worker/index.ts`. */
export const adminApp = new Hono<{ Bindings: Env }>();
for (const route of ADMIN_ROUTES) {
  if (route.method === "get") adminApp.get(route.path, route.handler);
  else if (route.method === "post") adminApp.post(route.path, route.handler);
  else if (route.method === "patch") adminApp.patch(route.path, route.handler);
  else adminApp.delete(route.path, route.handler);
}

/**
 * A failed console read must say what broke: this surface is where a
 * deployment gets diagnosed, so a 500 answers with the error's own sentence
 * instead of Hono's bare "Internal Server Error" text. The sentence goes
 * through the canonical scrubber because a provider or GitHub error can carry
 * a token verbatim, and the body is read by a human.
 */
adminApp.onError((error, c) => {
  const detail = redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  console.error(JSON.stringify({ event: "admin_route_failed", path: new URL(c.req.url).pathname, detail }));
  return c.json({ error: "internal_error", detail }, 500);
});
