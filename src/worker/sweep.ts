
import type { Queue } from "@cloudflare/workers-types";
import type { ReviewJobPayload } from "../contracts/review-job";
import {
  readCommentClaimSettings,
  type CommentClaimSettingsLogFields,
} from "../pipeline/comment-claim-settings-reader";
import type { ConsumerLog } from "../pipeline/consumer";
import { redactExactSecrets, redactSecrets } from "../pipeline/redact";
import { createReviewBotsStore } from "../dashboard/apps-store";
import { expireLapsedInvites } from "../dashboard/invite-store";
import { getMaintenanceMode, getSweepSettings, maintenanceClosed, reviewRunState } from "../dashboard/runtime-config-store";
import { retryMaintenanceReplay } from "../admin/maintenance-replay";
import {
  MAINTENANCE_DEFERRED_STAGE,
  PAGING_EXCLUDED_STAGES,
  sqlStageList,
} from "../store/failure-store";
import { QUOTA_STAGE } from "../contracts/failure-stages";
import { REVIEW_HALT_CODES } from "../contracts/failure-codes";
import type { D1Like } from "../store/types";
import type { WebhookStageWarnLog } from "./handlers";

/**
 * The comment-claim outbox scan (migration 0048). Exported so the index/plan
 * test asserts THIS statement — projection, the `attempts` predicate and the
 * operator `LIMIT` included — instead of a copy that can drift away from it.
 * Binds: `maxAttempts`, `nowMs - retryMs`, `outboxCap`.
 */
export const COMMENT_CLAIM_OUTBOX_SQL = `SELECT installation_id, owner, repo, pr_number, comment_id, payload_json
             FROM comment_trigger_claims
            WHERE state = 'queued' AND attempts < ? AND queued_ms <= ?
            ORDER BY queued_ms
            LIMIT ?`;

/**
 * The maintenance-replay outbox scan: rows an operator requested whose send
 * never resolved. `limit` is the sweep's REMAINING shared budget, and every row
 * it returns spends one unit — so one pass touches at most that many rows.
 *
 * The ordering is a ROTATION, not oldest-request-first: a row that keeps failing
 * (or whose target is gone) stays pending, so ordering by request time alone
 * would hand it the whole cap on every open sweep and later requests would never
 * be attempted. `maintenance_replay_last_attempt_at` is stamped on every attempt,
 * dead target included, so a never-tried row (`COALESCE(..., '')` sorts before
 * any ISO-8601 stamp) and then the least-recently-tried go first; request time
 * and id only break ties. A dead backlog therefore costs at most one attempt per
 * sweep per free slot instead of being walked in full before the alert lanes.
 *
 * That ORDER BY is served by `idx_review_failures_maintenance_replay_rotation`
 * (migration 0073): same predicate, same key order, so `LIMIT` stops the scan
 * instead of the backlog being read and sorted on every selection.
 *
 * Binds: `tried` (JSON array of ids), `limit`.
 */
export const MAINTENANCE_REPLAY_OUTBOX_SQL = `SELECT id FROM review_failures
            WHERE stage = '${MAINTENANCE_DEFERRED_STAGE}'
              AND maintenance_replay_requested_at IS NOT NULL
              AND maintenance_replay_sent_at IS NULL
              AND id NOT IN (SELECT value FROM json_each(?))
            ORDER BY COALESCE(maintenance_replay_last_attempt_at, '') ASC,
                     maintenance_replay_requested_at ASC,
                     id ASC
            LIMIT ?`;

const MAINTENANCE_REPLAY_PENDING_SQL = `SELECT 1 AS pending FROM review_failures
            WHERE stage = '${MAINTENANCE_DEFERRED_STAGE}'
              AND maintenance_replay_requested_at IS NOT NULL
              AND maintenance_replay_sent_at IS NULL
            LIMIT 1`;

/** Cap on the webhook-failure `detail` log field — a warn line stays single-line. */
export const SWEEP_LOG_DETAIL_MAX = 500;

/**
 * The structured breach event — a JSON line on the consumer-derived log
 * channel (SweepLog below), also POSTed verbatim to the webhook.
 * `dlq_check` is always "skipped" (AL-6: no CF API token surface);
 * `thresholds` echoes the pinned constants so an alert is
 * self-describing when the constants later move. `stages` is the same
 * grouped read that produced `failures_24h`, stage-ordered: the parts of the
 * total an operator can act on, never a second snapshot.
 */
export type SweepAlertFields = {
  event: "ops_sweep_alert";
  failures_24h: number;
  dlq_check: "skipped";
  thresholds: { failures_24h: number; window_hours: number };
  stages: Array<{ stage: string; count: number }>;
  maintenance_deferred?: { count: number };
  due: Array<"infrastructure" | "maintenance">;
};

/**
 * Warn fields for the sweep's non-alert paths — derived from the worker's
 * shared warn vocabulary (WebhookStageWarnLog minus `reason`: the sweep's
 * warns are not stage-labelled) with `event` narrowed to the sweep's three
 * warn events, so this shape cannot drift from the shared warn contract.
 */
export type SweepWarnFields = Omit<WebhookStageWarnLog, "event" | "reason"> & {
  event:
    | "ops_sweep_alert_webhook_failed"
    | "ops_sweep_settings_unreadable"
    | "ops_sweep_alert_window_unreadable"
    | "ops_sweep_alert_audit_failed"
    | "ops_sweep_failed"
    | "ops_sweep_db_unbound"
    | "ops_lifecycle_reconcile_failed"
    | "ops_check_reconcile_failed"
    | "ops_route_reconcile_failed"
    | "maintenance_skip";
};

/**
 * Retention log fields (PR #10): the best-effort webhook_deliveries sweep.
 * `retention_swept` carries the deleted count; a failure degrades to a warn
 * and never breaks the failure-sweep path.
 */
export type SweepRetentionFields =
  | { event: "retention_swept"; deleted: number }
  | { event: "retention_swept_failed"; detail: string };

/**
 * PR-ledger retention log fields (migration 0039): the second best-effort
 * janitor in the sweep. Only a run that actually deleted rows logs — a quiet
 * sweep says nothing, and the count is what tells an operator the ledger is
 * draining.
 */
export type SweepLedgerRetentionFields =
  | { event: "pull_request_retention_swept"; deleted: number }
  | { event: "pull_request_retention_swept_failed"; detail: string };

/**
 * Invite-lapse log fields (I-000096): the bulk flip that moved off the
 * members-page read. Only the failure is logged — a quiet sweep says nothing.
 */
export type SweepInviteLapseFields = { event: "invite_lapse_swept_failed"; detail: string };

/**
 * Comment-claim outbox fields (migration 0048): one line per sweep that did
 * something — resent claims, claims expired at the cap, failed re-sends. A
 * sweep with nothing to recover says nothing.
 */
export type SweepCommentClaimFields =
  | { event: "comment_claim_outbox"; resent: number; expired: number; failed: number }
  | { event: "comment_claim_outbox_failed"; detail: string };

/**
 * Maintenance replay outbox fields (migration 0071): the sweep retrying a
 * pending operator request while the window is open. A row that never finds a
 * live target stays pending forever (no attempt cap drops an operator's
 * recovery), so its count rides every sweep that sees one.
 */
export type SweepMaintenanceReplayFields =
  | { event: "maintenance_replay_outbox"; sent: number; failed: number; target_unavailable: number }
  | { event: "maintenance_replay_outbox_send_failed"; failure_id: string; detail: string }
  | { event: "maintenance_replay_outbox_failed"; detail: string }
  | { event: "maintenance_replay_pending_unreadable"; detail: string };

/**
 * The sweep only ever warns: a quiet system logs nothing. A warn-only view
 * of the consumer log channel — the `msg` parameter type is derived from
 * `ConsumerLog["warn"]` so the call shape cannot drift; the field union is
 * narrowed to the sweep's payloads (ops events carry no PR identity, so
 * they cannot ride ConsumerLogFields itself).
 */
export type SweepLog = {
  /** The durable-replay lane's accounting line (optional: only passes that replay emit one). */
  info?: (fields: Record<string, unknown>, msg: string) => void;
  warn: (
    fields:
      | SweepAlertFields
      | SweepWarnFields
      | SweepRetentionFields
      | SweepLedgerRetentionFields
      | SweepInviteLapseFields
      | SweepCommentClaimFields
      | SweepMaintenanceReplayFields
      | CommentClaimSettingsLogFields,
    msg?: Parameters<ConsumerLog["warn"]>[1],
  ) => void;
};

function warnDetail(error: unknown, alertUrl?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = redactExactSecrets(redactSecrets(raw), alertUrl ? [alertUrl] : []);
  return detail.length <= SWEEP_LOG_DETAIL_MAX ? detail : `${detail.slice(0, SWEEP_LOG_DETAIL_MAX - 1)}…`;
}

/** Default sink: structured JSON lines on stderr. No secrets are logged. */
export const defaultSweepLog: SweepLog = {
  info: (fields, msg) => console.info(JSON.stringify({ ...fields, msg: msg ?? "" })),
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

const QUOTA_SPREAD_SQL = `(SELECT COUNT(DISTINCT t.workspace_id)
              FROM review_failures q
              JOIN review_targets t ON t.id = q.target_id
             WHERE q.stage = '${QUOTA_STAGE}'
               AND q.created_at > datetime('now', ?1)) > 1`;

const FAILURE_PAGING_WHERE_SQL = `created_at > datetime('now', ?1)
         AND (stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
              OR (stage = '${QUOTA_STAGE}' AND ${QUOTA_SPREAD_SQL}))
         AND stage <> '${MAINTENANCE_DEFERRED_STAGE}'
         AND COALESCE(error_code, '') NOT IN (${sqlStageList(REVIEW_HALT_CODES)})`;

const MAINTENANCE_DEFERRED_COUNT_SQL = `SELECT COUNT(*) AS count FROM review_failures
       WHERE stage = '${MAINTENANCE_DEFERRED_STAGE}'
         AND created_at > datetime('now', ?1)`;

/**
 * The audit-window de-bounce is ONE read plus ONE append against
 * `platform_audit_events` (compass D17), per lane: `alert.failure_paging` rows
 * record delivered infrastructure alerts and `alert.maintenance_deferred` rows
 * record the maintenance signal, and the newest stamp for that action inside
 * the configured window suppresses the POST. There is no stored latch and no
 * generation — a due window with no recent alert always alerts, and two
 * concurrent sweeps may each post once. The ledger
 * (migrations/0033_platform_admin.sql) is append-only and platform-scoped,
 * which is exactly the shape a "was it already announced" question needs. The
 * writer is the sweep itself, so the actor is `sweep`.
 */
export type SweepDeps = {
  alertUrl?: string;
  fetchImpl?: typeof fetch;
  log?: SweepLog;
  queue?: Queue<ReviewJobPayload>;
};

export type SweepResult = {
  failures24h: number;
  thresholdBreached: boolean;
  invitesExpired: number | null;
  webhook: "absent" | "posted" | "failed" | "not_attempted";
};

/** The audit action that records a delivered paging alert (compass D17). */
export const ALERT_PAGING_AUDIT_ACTION = "alert.failure_paging";

/**
 * The audit action that records a delivered maintenance alert. Its own action,
 * so each lane's window is independent: a paging alert never suppresses the
 * maintenance alert and vice versa.
 */
export const ALERT_MAINTENANCE_AUDIT_ACTION = "alert.maintenance_deferred";

async function readLastAlertAt(
  db: D1Like,
  action: string,
  log: SweepLog,
  alertUrl?: string,
): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT MAX(created_at) AS at FROM platform_audit_events WHERE action = ?`)
      .bind(action)
      .first<{ at: string | null }>();
    if (row?.at == null) return null;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) {
      log.warn(
        { event: "ops_sweep_alert_window_unreadable", detail: "unparseable alert stamp" },
        "paging alert window unreadable — treating the alert as unannounced",
      );
      return null;
    }
    return at;
  } catch (error) {
    log.warn(
      { event: "ops_sweep_alert_window_unreadable", detail: warnDetail(error, alertUrl) },
      "paging alert window unreadable — treating the alert as unannounced",
    );
    return null;
  }
}

async function appendAlertAudit(
  db: D1Like,
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
  log: SweepLog,
  alertUrl?: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         VALUES (?, 'sweep', ?, 'sweep', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), action, targetId, JSON.stringify(detail), new Date().toISOString())
      .run();
  } catch (error) {
    log.warn(
      { event: "ops_sweep_alert_audit_failed", detail: warnDetail(error, alertUrl) },
      "alert audit row not written — the next sweep may alert again",
    );
  }
}

/**
 * Run one sweep: read the trailing-window failure rows grouped by stage, and when
 * that total breaches the threshold AND no alert is recorded inside the sweep
 * window, emit the `ops_sweep_alert` structured event + optionally POST it to
 * `alertUrl` (JSON body, bounded by the configured timeout). A webhook failure
 * (network/timeout throw OR a non-2xx response) degrades to a warn log — it
 * NEVER throws (the alert must not take down the cron that produced it). D1
 * errors DO propagate to the caller (the `scheduled` handler wraps the whole
 * sweep in try/catch).
 *
 * The infrastructure decision and the maintenance-signal decision each set a
 * due flag from their OWN audit window; the body is composed and delivered once
 * for whichever lanes are due, and the function returns once, at the bottom. A
 * healthy infrastructure total never short-circuits the maintenance lane, and a
 * deferral never joins `failures_24h`.
 */
export async function runSweep(db: D1Like, deps: SweepDeps = {}): Promise<SweepResult> {
  const log = deps.log ?? defaultSweepLog;
  const { values: settings, issue } = await getSweepSettings(db);
  if (issue) {
    const reason = issue.kind === "read_failed" ? "D1 settings read failed" : "Invalid settings rows";
    log.warn(
      {
        event: "ops_sweep_settings_unreadable",
        detail: issue.kind === "read_failed"
          ? warnDetail(issue.error, deps.alertUrl)
          : issue.keys.join(", "),
      },
      `${reason}; webhook and pull-request retention skipped — check the admin runtime sweep settings`,
    );
  } else {
    try {
      const retention = await db
        .prepare(
          `DELETE FROM webhook_deliveries WHERE id IN (
             SELECT id FROM webhook_deliveries WHERE created_at < datetime('now', ?) LIMIT ?
           )`,
        )
        .bind(`-${settings.retentionDays} days`, settings.retentionCap)
        .run();
      if (retention.meta.changes > 0) {
        log.warn({ event: "retention_swept", deleted: retention.meta.changes }, "webhook_deliveries retention sweep");
      }
    } catch (error) {
      log.warn(
        { event: "retention_swept_failed", detail: warnDetail(error, deps.alertUrl) },
        "webhook_deliveries retention sweep failed — continuing",
      );
    }
    try {
      const deleted = await createReviewBotsStore(db).sweepTerminalPullRequests({
        days: settings.pullRequestRetentionDays,
        cap: settings.pullRequestRetentionCap,
      });
      if (deleted > 0) {
        log.warn({ event: "pull_request_retention_swept", deleted }, "pull_requests retention sweep");
      }
    } catch (error) {
      log.warn(
        { event: "pull_request_retention_swept_failed", detail: warnDetail(error, deps.alertUrl) },
        "pull_requests retention sweep failed — continuing",
      );
    }
  }
  let invitesExpired: number | null = null;
  try {
    invitesExpired = await expireLapsedInvites(db, new Date().toISOString(), settings.inviteLapseCap);
  } catch (error) {
    log.warn(
      { event: "invite_lapse_swept_failed", detail: warnDetail(error, deps.alertUrl) },
      "workspace invite lapse sweep failed — continuing",
    );
  }
  if (deps.queue !== undefined) {
    const queue = deps.queue;
    const settings = await readCommentClaimSettings(db, log);
    const replayOpen = !maintenanceClosed(await getMaintenanceMode(db));
    let replayWaiting = false;
    if (replayOpen) {
      try {
        replayWaiting = (await db.prepare(MAINTENANCE_REPLAY_PENDING_SQL).first()) !== null;
      } catch (error) {
        log.warn(
          { event: "maintenance_replay_pending_unreadable", detail: warnDetail(error, deps.alertUrl) },
          "maintenance replay outbox unreadable — comment lane keeps the full cap",
        );
      }
    }
    let outboxRemaining = settings.outboxCap;
    const commentBudget = replayWaiting ? settings.outboxCap - 1 : settings.outboxCap;
    try {
      const nowMs = Date.now();
      const expired = await db
        .prepare(
          `UPDATE comment_trigger_claims SET state = 'expired', payload_json = NULL
            WHERE state = 'queued' AND attempts >= ? AND queued_ms <= ?`,
        )
        .bind(settings.maxAttempts, nowMs - settings.retryMs)
        .run();
      const stale = await db
        .prepare(COMMENT_CLAIM_OUTBOX_SQL)
        .bind(settings.maxAttempts, nowMs - settings.retryMs, commentBudget)
        .all<{
          installation_id: number;
          owner: string;
          repo: string;
          pr_number: number;
          comment_id: number;
          payload_json: string;
        }>();
      let resent = 0;
      let resendFailed = 0;
      for (const claim of stale.results) {
        outboxRemaining -= 1;
        let delivered = false;
        try {
          await queue.send(JSON.parse(claim.payload_json) as ReviewJobPayload);
          delivered = true;
          resent += 1;
        } catch {
          resendFailed += 1;
        }
        await db
          .prepare(
            `UPDATE comment_trigger_claims SET attempts = attempts + 1, queued_ms = ?
              WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?
                AND state = 'queued'`,
          )
          .bind(nowMs, claim.installation_id, claim.owner, claim.repo, claim.pr_number, claim.comment_id)
          .run();
      }
      if (resent > 0 || expired.meta.changes > 0 || resendFailed > 0) {
        log.warn(
          { event: "comment_claim_outbox", resent, expired: expired.meta.changes, failed: resendFailed },
          "comment trigger outbox recovery",
        );
      }
    } catch (error) {
      log.warn(
        { event: "comment_claim_outbox_failed", detail: warnDetail(error, deps.alertUrl) },
        "comment trigger outbox sweep failed — continuing",
      );
    }
    // The replay outbox is the ONE lane a deferred row can leave by, and it
    // only runs while reviews can actually run: a send while the platform is
    // paused or the route gate closed would be acked by `settleHaltedBatch`
    // and stamped `sent` without ever reviewing. Unreadability keeps the lane
    // closed too — the queue's own halt branch does the same.
    const reviewsRunning = replayOpen && (await reviewRunState(db)).state === "running";
    if (outboxRemaining > 0 && replayOpen && reviewsRunning) {
      try {
        const now = new Date().toISOString();
        const tried: string[] = [];
        let sent = 0;
        let failed = 0;
        let unavailable = 0;
        while (outboxRemaining > 0) {
          const row = await db
            .prepare(MAINTENANCE_REPLAY_OUTBOX_SQL)
            .bind(JSON.stringify(tried), outboxRemaining)
            .first<{ id: string }>();
          if (row === null) break;
          tried.push(row.id);
          outboxRemaining -= 1;
          try {
            const outcome = await retryMaintenanceReplay(db, queue, row.id, now);
            if (outcome === "sent") sent += 1;
            else unavailable += 1;
          } catch (error) {
            failed += 1;
            log.warn(
              {
                event: "maintenance_replay_outbox_send_failed",
                failure_id: row.id,
                detail: warnDetail(error, deps.alertUrl),
              },
              "maintenance replay send failed — row stays pending",
            );
          }
        }
        if (sent > 0 || failed > 0 || unavailable > 0) {
          log.warn(
            { event: "maintenance_replay_outbox", sent, failed, target_unavailable: unavailable },
            "maintenance replay outbox recovery",
          );
        }
      } catch (error) {
        log.warn(
          { event: "maintenance_replay_outbox_failed", detail: warnDetail(error, deps.alertUrl) },
          "maintenance replay outbox sweep failed — continuing",
        );
      }
    }
  }
  const windowModifier = `-${settings.windowHours} hours`;
  const { results: stageRows } = await db
    .prepare(
      `SELECT stage, COUNT(*) AS count FROM review_failures
       WHERE ${FAILURE_PAGING_WHERE_SQL}
       GROUP BY stage ORDER BY stage`,
    )
    .bind(windowModifier)
    .all<{ stage: string; count: number }>();
  const stages = stageRows.map((row) => ({ stage: row.stage, count: row.count }));
  const failures24h = stages.reduce((sum, row) => sum + row.count, 0);
  const thresholdBreached = failures24h > settings.failureThreshold;
  const maintenanceRow = await db
    .prepare(MAINTENANCE_DEFERRED_COUNT_SQL)
    .bind(windowModifier)
    .first<{ count: number }>();
  const maintenanceDeferred = maintenanceRow?.count ?? 0;
  let webhook: SweepResult["webhook"] = "not_attempted";
  const nowMs = Date.now();
  const windowMs = settings.windowHours * 3_600_000;
  let pagingDue = false;
  if (thresholdBreached) {
    const lastAlertAt = await readLastAlertAt(db, ALERT_PAGING_AUDIT_ACTION, log, deps.alertUrl);
    pagingDue = lastAlertAt === null || lastAlertAt >= nowMs || nowMs - lastAlertAt >= windowMs;
  }
  let maintenanceDue = false;
  if (maintenanceDeferred > 0) {
    const lastAlertAt = await readLastAlertAt(db, ALERT_MAINTENANCE_AUDIT_ACTION, log, deps.alertUrl);
    maintenanceDue = lastAlertAt === null || lastAlertAt >= nowMs || nowMs - lastAlertAt >= windowMs;
  }
  if (pagingDue || maintenanceDue) {
    const due: SweepAlertFields["due"] = [
      ...(pagingDue ? (["infrastructure"] as const) : []),
      ...(maintenanceDue ? (["maintenance"] as const) : []),
    ];
    const alert: SweepAlertFields = {
      event: "ops_sweep_alert",
      failures_24h: failures24h,
      dlq_check: "skipped",
      thresholds: { failures_24h: settings.failureThreshold, window_hours: settings.windowHours },
      stages,
      ...(maintenanceDue ? { maintenance_deferred: { count: maintenanceDeferred } } : {}),
      due,
    };
    log.warn(alert, pagingDue ? "review failure threshold breached" : "maintenance deferrals in window");
    if (!deps.alertUrl) {
      webhook = "absent";
    } else {
      const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
      try {
        const response = await fetchImpl(deps.alertUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(settings.webhookTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`alert webhook POST returned HTTP ${response.status}`);
        }
        webhook = "posted";
        if (pagingDue) {
          await appendAlertAudit(
            db,
            ALERT_PAGING_AUDIT_ACTION,
            "failure_paging",
            { failures_24h: alert.failures_24h, stages: alert.stages },
            log,
            deps.alertUrl,
          );
        }
        if (maintenanceDue) {
          await appendAlertAudit(
            db,
            ALERT_MAINTENANCE_AUDIT_ACTION,
            "maintenance_deferred",
            { maintenance_deferred: { count: maintenanceDeferred } },
            log,
            deps.alertUrl,
          );
        }
      } catch (error) {
        log.warn(
          {
            event: "ops_sweep_alert_webhook_failed",
            detail: warnDetail(error, deps.alertUrl),
          },
          "alert webhook POST failed — log-only alert stands",
        );
        webhook = "failed";
      }
    }
  }

  return { failures24h, thresholdBreached, invitesExpired, webhook };
}
