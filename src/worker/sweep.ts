/**
 * Ops failure sweep (architect verdict AL-6) — the cron handler's scan: read
 * `review_failures` ONCE over the configured trailing window grouped by stage (parse +
 * runner/sandbox/pipeline are the infra-failure rows that make this table the
 * sufficient failure signal, closing the "DLQ-bound failure leaves zero D1
 * trace" blind spot), sum the group counts, and alert when that total breaches
 * the threshold. The same ordered rows are the payload's `stages`.
 *
 * The paging-excluded stages (PAGING_EXCLUDED_STAGES) are EXCLUDED from that
 * count: the attribution stages are degraded-but-successful attribution
 * written for a review that continued (`recheck` marks a budget skip, a dead
 * seat or one invalid document; `usage` marks a `usage_events` insert that
 * failed while the review went on; `rate-limit` marks a degraded-comment sweep
 * GitHub throttled while the review itself stood), and `quota` marks one
 * tenant's exhausted month. Counting them would page ops for reviews that
 * published normally, or for a commercial ceiling that is not an incident.
 * They stay in `review_failures` — only the paging signal ignores them, and
 * the dashboard still counts `quota` as a failure.
 *
 * `quota` is excluded on a premise — ONE tenant's month — and the premise is
 * checked: when the same window refuses deliveries in more than one workspace,
 * the ceiling itself is wrong at the platform level (a published profile with
 * no allowance stops every shared-bot delivery) and those rows RE-ENTER the
 * total through their own predicate term. The readmission is derived from the
 * same window as everything else, so one tenant's spent month never pages and
 * a platform-wide refusal always does.
 *
 * The same query returns the per-stage breakdown (`stages`) that travels in
 * the alert payload: one grouped read, so the total and its parts always
 * describe the same instant.
 *
 * The alert posts AT MOST ONCE PER SWEEP WINDOW, and the de-bounce is an AUDIT
 * WINDOW rather than stored state: before posting, the sweep reads the most
 * recent `platform_audit_events` row for the lane's own action —
 * `alert.failure_paging` (compass D17) for infrastructure, and
 * `alert.maintenance_deferred` for the maintenance signal — and posts nothing
 * while that stamp is inside the configured window; a 2xx POST appends the row.
 * Two actions, so neither lane can silence the other. Nothing is ever latched,
 * so a breaching window with no recent alert always pages — a missed alert is
 * structurally impossible, and the price is that two sweeps overlapping inside
 * one window may each post once. A failed read or an unparseable stamp is "no
 * recent alert" (the post it might suppress is the one that matters); a failed
 * append is logged and leaves the POST result alone.
 *
 * Verdict-pinned boundaries (AL-6, do not widen without a new verdict):
 * - DLQ depth is NOT read: there is no CF API token surface,
 *   so every alert payload carries `dlq_check: "skipped"` — the failure
 *   table IS the signal, the DLQ is only its overflow destination.
 * - Guard-leak cleanup stays OUT of the sweep: the KV guard TTL is the leak
 *   upper bound (a wrong delete of a live guard is worse than a TTL leak).
 * - Bounded janitor writes ride along (webhook_deliveries retention, the
 *   invite lapse flip) beside one optional webhook POST; the rest is reads and
 *   logs. The queue writes are the two recovery outboxes, sharing ONE
 *   per-sweep cap taken from `review.comment_claim.outbox_cap`: the
 *   comment-claim outbox (migration 0048), where a `queued` claim older than
 *   the retry window has its stored payload re-sent — what makes "claim before
 *   send" survive an isolate dying between the two — and the maintenance-replay
 *   outbox (migration 0071), which retries an operator's requested-but-unsent
 *   replay while the maintenance window is readable and open. It NEVER mutates
 *   KV keys.
 *
 * Threshold semantics: PER-ATTEMPT rows — a DLQ'd message leaves up to
 * QUEUE_MAX_ATTEMPTS rows (one per delivery: 1 initial + the queue's
 * max_retries). The threshold defaults to QUEUE_MAX_ATTEMPTS + 1 unless the
 * operator overrides it in the platform runtime settings.
 */

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
import { getMaintenanceMode, getSweepSettings, maintenanceClosed } from "../dashboard/runtime-config-store";
import { retryMaintenanceReplay } from "../admin/maintenance-replay";
import {
  MAINTENANCE_DEFERRED_STAGE,
  PAGING_EXCLUDED_STAGES,
  sqlStageList,
} from "../store/failure-store";
import { QUOTA_STAGE } from "../contracts/failure-stages";
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

/**
 * Is ANY replay request pending and unsent? The comment lane asks this before it
 * spends the shared budget, so it can leave the replay lane one slot. Served by
 * the pending partial index; one row is all the answer needs.
 */
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
  /**
   * Maintenance-deferred rows in the same trailing window — the platform's own
   * existence signal, beside (never inside) the infrastructure total above.
   * The frozen contract key is nested (`{count}`), and it appears only when
   * THIS post owes the maintenance lane: a deferral already announced inside
   * the window is not an active alert.
   */
  maintenance_deferred?: { count: number };
  /**
   * The lanes that justified THIS post. One shared body cannot otherwise say
   * whether a breaching `failures_24h` is the alert or a de-bounced snapshot;
   * a lane missing here was already recorded inside the window.
   */
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
    // The audit-window de-bounce (`alert.failure_paging` in
    // `platform_audit_events`): an unreadable window read, and the append that
    // records a delivered alert. Both degrade to a warn — neither may suppress
    // or alter the post the sweep owes.
    | "ops_sweep_alert_window_unreadable"
    | "ops_sweep_alert_audit_failed"
    | "ops_sweep_failed"
    | "ops_sweep_db_unbound"
    // §7.11: the scheduled composition's independent catch for the
    // M8 reconciler (type-only addition — the sweep's own behavior is
    // untouched and the reconciler is throw-proof, so this line is a
    // belt-and-braces fence, not a path).
    | "ops_lifecycle_reconcile_failed"
    // §7.11.2: the composition's THIRD independent catch, for the M7
    // Check reconciler — same shape and the same type-only rationale as the
    // M8 line above.
    | "ops_check_reconcile_failed"
    // D20: the invocation found the platform closed and returned before any
    // lane ran — a queue batch or a cron expression, named in `detail`.
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
  warn: (
    fields:
      | SweepAlertFields
      | SweepWarnFields
      | SweepRetentionFields
      | SweepLedgerRetentionFields
      | SweepInviteLapseFields
      | SweepCommentClaimFields
      | SweepMaintenanceReplayFields
      // The comment-claim settings reader owns its own degraded warn shape.
      | CommentClaimSettingsLogFields,
    msg?: Parameters<ConsumerLog["warn"]>[1],
  ) => void;
};

/**
 * One warn `detail`: redact BEFORE truncate (repo convention — a secret
 * straddling the cut would leak a partial token), then cap the line. The
 * configured alert URL is exact-string-replaced because a URL-shaped value
 * evades the shape patterns (SEC-02).
 */
function warnDetail(error: unknown, alertUrl?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = redactExactSecrets(redactSecrets(raw), alertUrl ? [alertUrl] : []);
  return detail.length <= SWEEP_LOG_DETAIL_MAX ? detail : `${detail.slice(0, SWEEP_LOG_DETAIL_MAX - 1)}…`;
}

/** Default sink: structured JSON lines on stderr. No secrets are logged. */
export const defaultSweepLog: SweepLog = {
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

/**
 * The trailing-window predicate identifying the infrastructure failures that
 * page. Both the outer scan and the quota subquery use the same bound window.
 * `stage NOT IN (<paging stages>)` is the paging exclusion: attribution rows
 * are reviews that continued, and `quota` is one tenant's spent month (see the
 * header). The list comes from the contract's written partition, never a local
 * literal. `quota` re-enters when the SAME window shows it in more than one
 * workspace — the premise "one tenant" is what the exclusion rests on, so a
 * platform-wide ceiling fault must page. Maintenance is the platform's own
 * existence signal, owned by its separate lane and never part of the
 * infrastructure total — so it is excluded here too, by its constant. ONE
 * predicate, so the grouped read and the window decision below can never
 * disagree about what a breach is.
 */
const QUOTA_SPREAD_SQL = `(SELECT COUNT(DISTINCT t.workspace_id)
              FROM review_failures q
              JOIN review_targets t ON t.id = q.target_id
             WHERE q.stage = '${QUOTA_STAGE}'
               AND q.created_at > datetime('now', ?1)) > 1`;

const FAILURE_PAGING_WHERE_SQL = `created_at > datetime('now', ?1)
         AND (stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
              OR (stage = '${QUOTA_STAGE}' AND ${QUOTA_SPREAD_SQL}))
         AND stage <> '${MAINTENANCE_DEFERRED_STAGE}'`;

/**
 * The maintenance-deferred existence signal: rows the platform deferred in the
 * same trailing window. Its own count, never a `stages` group — maintenance is
 * not an infrastructure failure, so it stays out of `failures_24h`.
 */
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
  /** Alert webhook URL (env `ALERT_WEBHOOK_URL`); absent/empty = log-only. */
  alertUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to structured JSON lines. */
  log?: SweepLog;
  /**
   * Comment-claim outbox sink (migration 0048): the one queue write this sweep
   * performs. Absent = the outbox lane is skipped (a suite exercising only the
   * failure sweep needs no queue double).
   */
  queue?: Queue<ReviewJobPayload>;
};

export type SweepResult = {
  failures24h: number;
  thresholdBreached: boolean;
  /**
   * Lapsed pending invites flipped to `expired` by this run, across every
   * workspace; null when the flip itself failed (warn-logged, and the
   * failure-sweep path below still ran).
   */
  invitesExpired: number | null;
  /**
   * Webhook disposition: absent (unset), posted, failed (throw or non-2xx,
   * warn-logged), or not_attempted (nothing due, or every due lane already
   * recorded inside the sweep window — at most one post per window).
   */
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

/**
 * The newest alert recorded under `action`, as epoch milliseconds, or `null`
 * when the ledger holds none. A read that throws or a stamp `Date.parse` cannot
 * read is "no recent alert": the post it might suppress is the one that
 * matters, so the caller logs and alerts. Never throws.
 */
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

/**
 * Record a delivered alert. The POST already succeeded, so a storage failure
 * here only means the next sweep may post once more: it is logged and never
 * changes the POST outcome. `detail` carries the same numbers the payload sent
 * under that action, which is what makes the ledger row a usable record alone.
 */
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
  const { values: settings, degraded } = await getSweepSettings(db);
  if (degraded) {
    log.warn(
      { event: "ops_sweep_settings_unreadable", detail: "Using defaults for unreadable settings; webhook retention skipped" },
      "Check the admin runtime sweep settings before webhook retention resumes",
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
  }
  // PR-ledger retention (migration 0039): terminal PR rows only — an OPEN PR
  // stays a live review target however stale. Bounded per run like the
  // delivery sweep above, and best-effort in the same way: a failure warns and
  // never breaks the failure-sweep path, so a missing ledger table (an older
  // DB mid-deploy) is not an ops alarm.
  try {
    const deleted = await createReviewBotsStore(db).sweepTerminalPullRequests();
    if (deleted > 0) {
      log.warn({ event: "pull_request_retention_swept", deleted }, "pull_requests retention sweep");
    }
  } catch (error) {
    log.warn(
      { event: "pull_request_retention_swept_failed", detail: warnDetail(error, deps.alertUrl) },
      "pull_requests retention sweep failed — continuing",
    );
  }
  // Invite lapse (I-000096) moved here from the members-page read: a lapsed
  // pending invite already holds no seat and is already unlisted, so the flip
  // only makes the stored status catch up — at most one sweep interval late.
  // The statement is global and bounded by the configured rows per run,
  // so a larger backlog drains over successive runs instead of stalling one
  // sweep. Like retention, a failure degrades to a warn and NEVER breaks the
  // failure-sweep path below.
  let invitesExpired: number | null = null;
  try {
    invitesExpired = await expireLapsedInvites(db, new Date().toISOString(), settings.inviteLapseCap);
  } catch (error) {
    log.warn(
      { event: "invite_lapse_swept_failed", detail: warnDetail(error, deps.alertUrl) },
      "workspace invite lapse sweep failed — continuing",
    );
  }
  // Comment-claim outbox (migration 0048) — the sweep's ONE queue write. The
  // worker inserts a claim row BEFORE its queue send, so a row still `queued`
  // past the retry window is a claim whose send never happened (or whose
  // isolate died between the claim and the send). Re-sending the stored
  // payload is what makes delivery at-least-once, while the pipeline's atomic
  // consume keeps execution at-most-once. Best-effort in the same shape as
  // every janitor above: a failure warns and never breaks the failure sweep.
  if (deps.queue !== undefined) {
    const queue = deps.queue;
    // The three budgets are operator settings on the global runtime-config
    // surface (`review.comment_claim.*`, AGENTS.md 「Configuration surfaces」):
    // read once per sweep, shared by both recovery lanes. A degraded read
    // answers the documented defaults with one structured warn and never
    // throws, so a broken settings row cannot stop recovery.
    const settings = await readCommentClaimSettings(db, log);
    // The maintenance window is read ONCE, before the lanes split the budget:
    // the replay lane's reservation and the lane itself must agree on it. Only
    // an OPEN window may write the queue, so an unreadable window is closed —
    // the same fail-closed predicate as the route.
    const replayOpen = !maintenanceClosed(await getMaintenanceMode(db));
    // The ONE combined recovery budget: two de-bounded lanes, one cap, so
    // neither lane can double the sweep's queue writes. The split is fair by
    // construction: while an operator's replay is pending AND the window is
    // open, the comment lane may claim at most cap-1 and the replay lane keeps
    // the last unit; with nothing waiting (or a closed window) the comment lane
    // keeps the whole cap.
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
      // Rows at the cap have exhausted every re-send: flip them to `expired`
      // FIRST, so the selection below can never pick them again. The payload is
      // dropped in the same statement — a terminal tombstone holds only scope
      // keys, state and timestamps, and is never deleted (it is the dedup
      // proof a late redelivery would otherwise re-open).
      const expired = await db
        .prepare(
          `UPDATE comment_trigger_claims SET state = 'expired', payload_json = NULL
            WHERE state = 'queued' AND attempts >= ?`,
        )
        .bind(settings.maxAttempts)
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
        // Per row: one poisoned claim (a send that keeps failing) must not
        // starve the rest of the batch, which is ordered oldest-first. The
        // budget is spent HERE, before the send: an attempt is what the cap
        // counts, so a send that succeeds and then throws on its own
        // attempts update can never hand the replay lane a budget it already
        // spent.
        outboxRemaining -= 1;
        let delivered = false;
        try {
          await queue.send(JSON.parse(claim.payload_json) as ReviewJobPayload);
          delivered = true;
          resent += 1;
        } catch {
          resendFailed += 1;
        }
        // Every ATTEMPT counts, delivered or not: a claim that can never be
        // sent must reach the cap and expire instead of being retried forever.
        // `queued_ms` restarts the window either way.
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
    // Maintenance-replay outbox (migrations 0071/0072): an operator's request
    // can outlive its send — the isolate died between the request batch and
    // `queue.send`, or the send/its sent-stamp failed. Only an OPEN window may
    // write the queue, so the lane runs under the SAME fail-closed predicate as
    // the route (`replayOpen`, read above): unreadable is closed.
    if (outboxRemaining > 0 && replayOpen) {
      try {
        const now = new Date().toISOString();
        // The ids THIS pass already took: one row is attempted at most once per
        // sweep. It can hold no more than the starting budget.
        const tried: string[] = [];
        let sent = 0;
        let failed = 0;
        let unavailable = 0;
        // Every row this pass TOUCHES spends one unit of the shared budget,
        // including a row whose target is gone — the scan can therefore never
        // outgrow the budget. The per-attempt stamp (written for dead targets
        // too) rotates the rows this pass did not reach to the front of the
        // next one, so a dead backlog costs one attempt per free slot per sweep
        // instead of being walked in full before the alert lanes run.
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
            // A send/stamp failure leaves the row pending: no attempt cap, so
            // the next open sweep retries it — behind the rows this sweep did
            // not reach, because the attempt stamp moved it back.
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
  // ONE grouped read supplies both the total and its breakdown, so a payload
  // can never describe a different instant than its own count.
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
  // The maintenance existence signal: its own trailing-window count, read before
  // the paging decision consumes it, so a healthy infrastructure total still
  // runs this lane and a deferral can never hide a breach or vice versa.
  const maintenanceRow = await db
    .prepare(MAINTENANCE_DEFERRED_COUNT_SQL)
    .bind(windowModifier)
    .first<{ count: number }>();
  const maintenanceDeferred = maintenanceRow?.count ?? 0;
  // The infrastructure decision only SETS the disposition and, when it owes a
  // page, composes the alert body; delivery and the single exit are below.
  let webhook: SweepResult["webhook"] = "not_attempted";
  const nowMs = Date.now();
  const windowMs = settings.windowHours * 3_600_000;
  // Each lane de-bounces on its OWN audit action, so neither can silence the
  // other: a paging alert never suppresses the maintenance alert. A stamp only
  // suppresses when it is in the past and inside the trailing window — a
  // clock-ahead row is not evidence of a delivered alert.
  let pagingDue = false;
  if (thresholdBreached) {
    // Read the window BEFORE the POST: the newest recorded alert suppresses
    // this one. Nothing is latched, so a window with no recent row always
    // pages; the cost of overlapping sweeps is one bounded duplicate.
    const lastAlertAt = await readLastAlertAt(db, ALERT_PAGING_AUDIT_ACTION, log, deps.alertUrl);
    pagingDue = lastAlertAt === null || lastAlertAt >= nowMs || nowMs - lastAlertAt >= windowMs;
  }
  // The maintenance existence signal joins HERE, on its own action and window:
  // a healthy infrastructure total cannot skip it, and it never adds to
  // `failures_24h` or the paging decision.
  let maintenanceDue = false;
  if (maintenanceDeferred > 0) {
    const lastAlertAt = await readLastAlertAt(db, ALERT_MAINTENANCE_AUDIT_ACTION, log, deps.alertUrl);
    maintenanceDue = lastAlertAt === null || lastAlertAt >= nowMs || nowMs - lastAlertAt >= windowMs;
  }
  if (pagingDue || maintenanceDue) {
    // ONE body for both lanes: `due` names which lanes owe it, and each signal
    // key appears only for a lane that is actually due — a lane de-bounced by
    // its own audit window must not read as an active alert.
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
      // POST FIRST, append the audit rows only for a delivered alert. A row
      // written before the POST would let a terminated invocation suppress the
      // only alert this window ever sends; one written after a 2xx can at worst
      // repeat an alert next sweep, which is the permitted duplication.
      // An arrow over a globalThis property call, never the bare `fetch` reference:
      // calling a stored reference loses the global receiver and workerd's native
      // fetch throws `Illegal invocation`. (Same contract as `verifyFetch`.)
      const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
      try {
        const response = await fetchImpl(deps.alertUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(settings.webhookTimeoutMs),
        });
        if (!response.ok) {
          // Non-2xx = NOT posted: the sink rejected the alert. Throw a synthetic
          // status-only error (never the URL or body) so the shared catch path
          // below emits the warn and the "failed" disposition.
          throw new Error(`alert webhook POST returned HTTP ${response.status}`);
        }
        webhook = "posted";
        // The alert IS delivered; only now is each due lane recorded, under its
        // own action. An append never changes this disposition.
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
        // ALERT_WEBHOOK_URL is secret-class and a runtime may interpolate the
        // request URL into the error message; `warnDetail` redacts and caps it.
        log.warn(
          {
            event: "ops_sweep_alert_webhook_failed",
            detail: warnDetail(error, deps.alertUrl),
          },
          "alert webhook POST failed — log-only alert stands",
        );
        // Nothing is recorded, so the window still counts as unannounced and
        // the next sweep retries.
        webhook = "failed";
      }
    }
  }

  return { failures24h, thresholdBreached, invitesExpired, webhook };
}
