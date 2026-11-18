/**
 * Ops failure sweep (architect verdict AL-6) — the cron handler's scan: read
 * `review_failures` ONCE over the trailing 24h grouped by stage (parse +
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
 * The same query returns the per-stage breakdown (`stages`) that travels in
 * the alert payload: one grouped read, so the total and its parts always
 * describe the same instant.
 *
 * The alert posts AT MOST ONCE PER SWEEP WINDOW, and the de-bounce is an AUDIT
 * WINDOW rather than stored state: before posting, the sweep reads the most
 * recent `platform_audit_events` row with action `alert.failure_paging`
 * (compass D17) and posts nothing while that stamp is inside
 * `SWEEP_WINDOW_HOURS`; a 2xx POST appends the row. Nothing is ever latched, so
 * a breaching window with no recent alert always pages — a missed alert is
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
 *   logs. The ONE queue write is the comment-claim outbox (migration 0048): a
 *   `queued` claim older than the retry window has its stored payload re-sent,
 *   which is what makes "claim before send" survive an isolate dying between
 *   the two. It NEVER mutates KV keys.
 *
 * Threshold semantics: PER-ATTEMPT rows — a DLQ'd message leaves up to
 * QUEUE_MAX_ATTEMPTS rows (one per delivery: 1 initial + the queue's
 * max_retries), so the threshold is DERIVED from that number instead of being a
 * second literal: `SWEEP_FAILURE_THRESHOLD = QUEUE_MAX_ATTEMPTS + 1` makes one
 * fully-failed message insufficient to trip the sweep, and the next message's
 * first attempts do — the same "roughly two messages" signal the constant had
 * when the queue retried three times. Add a guard rung (or raise
 * max_retries) and this moves with it. The constants below are the single
 * source (unit-test pinned); making them env-configurable is a future explicit
 * decision.
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
import {
  MAINTENANCE_DEFERRED_STAGE,
  PAGING_EXCLUDED_STAGES,
  QUEUE_MAX_ATTEMPTS,
  sqlStageList,
} from "../store/failure-store";
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
 * Breach when `failures_24h > SWEEP_FAILURE_THRESHOLD` (AL-6): one row above a
 * single fully-failed message, so one DLQ'd job never alerts and the second
 * does (see the header).
 */
export const SWEEP_FAILURE_THRESHOLD = QUEUE_MAX_ATTEMPTS + 1;

/** Trailing count window in hours (AL-6): `datetime('now', '-24 hours')`. */
export const SWEEP_WINDOW_HOURS = 24;

/** Webhook POST timeout — a hung alert sink must never stall the cron. */
export const SWEEP_WEBHOOK_TIMEOUT_MS = 3000;

/** Cap on the webhook-failure `detail` log field — a warn line stays single-line. */
export const SWEEP_LOG_DETAIL_MAX = 500;

/** Retention window in days (PR #10): webhook_deliveries rows older than this are swept. */
export const SWEEP_RETENTION_DAYS = 30;

/** Retention row cap per run (PR #10): bounded work per 15-min sweep. */
export const SWEEP_RETENTION_CAP = 500;

/** Invite-lapse row cap per run (I-000096): same bounded-work rule as retention. */
export const SWEEP_INVITE_LAPSE_CAP = 500;

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
 * page. The window modifier comes from SWEEP_WINDOW_HOURS (the constant is the
 * single source) so the SQL cannot drift from the pinned threshold table, and
 * the composed text stays byte-identical to the pre-constant form
 * (`datetime('now', '-24 hours')`), keeping the pinned SQL test green.
 * `stage NOT IN (<paging stages>)` is the paging exclusion: attribution rows
 * are reviews that continued, and `quota` is one tenant's spent month (see the
 * header). The list comes from the contract's written partition, never a local
 * literal. Maintenance is the platform's own existence signal, owned by its
 * separate lane (377) and never part of the infrastructure total — so it is
 * excluded here too, by its constant. ONE predicate, so the grouped read and
 * the window decision below can never disagree about what a breach is.
 */
const FAILURE_PAGING_WHERE_SQL = `created_at > datetime('now', '-${SWEEP_WINDOW_HOURS} hours')
         AND stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
         AND stage <> '${MAINTENANCE_DEFERRED_STAGE}'`;

/**
 * The audit-window de-bounce is ONE read plus ONE append against
 * `platform_audit_events` (compass D17): `alert.failure_paging` rows record
 * delivered alerts, and the newest stamp inside `SWEEP_WINDOW_HOURS` suppresses
 * the POST. There is no stored latch and no generation — a breaching window
 * with no recent alert always pages, and two concurrent sweeps may each post
 * once. The ledger (migrations/0033_platform_admin.sql) is append-only and
 * platform-scoped, which is exactly the shape a "was it already announced"
 * question needs. The writer is the sweep itself, so the actor is `sweep`.
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
   * warn-logged), or not_attempted (no breach, or an alert already recorded
   * inside the sweep window — at most one post per window).
   */
  webhook: "absent" | "posted" | "failed" | "not_attempted";
};

/** The audit action that records a delivered paging alert (compass D17). */
export const ALERT_PAGING_AUDIT_ACTION = "alert.failure_paging";

/**
 * The newest recorded paging alert, as epoch milliseconds, or `null` when the
 * ledger holds none. A read that throws or a stamp `Date.parse` cannot read is
 * "no recent alert": the post it might suppress is the one that matters, so the
 * caller logs and pages. Never throws.
 */
async function readLastAlertAt(db: D1Like, log: SweepLog, alertUrl?: string): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT MAX(created_at) AS at FROM platform_audit_events WHERE action = ?`)
      .bind(ALERT_PAGING_AUDIT_ACTION)
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
 * here only means the next breaching sweep may post once more: it is logged and
 * never changes the POST outcome. The detail carries the same numbers the
 * payload did, which is what makes the ledger row a usable record on its own.
 */
async function appendAlertAudit(
  db: D1Like,
  alert: SweepAlertFields,
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
      .bind(
        crypto.randomUUID(),
        ALERT_PAGING_AUDIT_ACTION,
        "failure_paging",
        JSON.stringify({ failures_24h: alert.failures_24h, stages: alert.stages }),
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    log.warn(
      { event: "ops_sweep_alert_audit_failed", detail: warnDetail(error, alertUrl) },
      "paging alert audit row not written — the next sweep may alert again",
    );
  }
}

/**
 * Run one sweep: read the trailing-24h failure rows grouped by stage, and when
 * that total breaches the threshold AND no alert is recorded inside the sweep
 * window, emit the `ops_sweep_alert` structured event + optionally POST it to
 * `alertUrl` (JSON body, SWEEP_WEBHOOK_TIMEOUT_MS timeout). A webhook failure
 * (network/timeout throw OR a non-2xx response) degrades to a warn log — it
 * NEVER throws (the alert must not take down the cron that produced it). D1
 * errors DO propagate to the caller (the `scheduled` handler wraps the whole
 * sweep in try/catch).
 *
 * The infrastructure decision composes the alert body and sets the webhook
 * disposition; the body is delivered and the function returns once, at the
 * bottom. A separate lane whose signal must not be skipped by a healthy
 * infrastructure total (the maintenance-window existence signal) joins between
 * those two points, so this function never returns early after the read.
 */
export async function runSweep(db: D1Like, deps: SweepDeps = {}): Promise<SweepResult> {
  const log = deps.log ?? defaultSweepLog;
  // Best-effort retention (PR #10): sweep webhook_deliveries rows older
  // than SWEEP_RETENTION_DAYS, capped at SWEEP_RETENTION_CAP rows per run.
  // simplify: bounded work per 15-min sweep — a full table drains over
  // successive runs; raise the cap or move to a dedicated janitor cron if
  // the drain rate ever matters. A failure degrades to a warn and NEVER
  // breaks the failure-sweep path below.
  try {
    const retention = await db
      .prepare(
        `DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < datetime('now', '-${SWEEP_RETENTION_DAYS} days') LIMIT ${SWEEP_RETENTION_CAP})`,
      )
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
  // The statement is global and bounded at SWEEP_INVITE_LAPSE_CAP rows per run,
  // so a larger backlog drains over successive runs instead of stalling one
  // sweep. Like retention, a failure degrades to a warn and NEVER breaks the
  // failure-sweep path below.
  let invitesExpired: number | null = null;
  try {
    invitesExpired = await expireLapsedInvites(db, new Date().toISOString(), SWEEP_INVITE_LAPSE_CAP);
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
    try {
      // The three budgets are operator settings on the global runtime-config
      // surface (`review.comment_claim.*`, AGENTS.md 「Configuration surfaces」):
      // read once per sweep. A degraded read answers the documented defaults
      // with one structured warn and never throws, so a broken settings row
      // cannot stop claim recovery.
      const settings = await readCommentClaimSettings(db, log);
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
        .bind(settings.maxAttempts, nowMs - settings.retryMs, settings.outboxCap)
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
        // starve the rest of the batch, which is ordered oldest-first.
        let delivered = false;
        try {
          await deps.queue.send(JSON.parse(claim.payload_json) as ReviewJobPayload);
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
  }
  // ONE grouped read supplies both the total and its breakdown, so a payload
  // can never describe a different instant than its own count.
  const { results: stageRows } = await db
    .prepare(
      `SELECT stage, COUNT(*) AS count FROM review_failures
       WHERE ${FAILURE_PAGING_WHERE_SQL}
       GROUP BY stage ORDER BY stage`,
    )
    .all<{ stage: string; count: number }>();
  const stages = stageRows.map((row) => ({ stage: row.stage, count: row.count }));
  const failures24h = stages.reduce((sum, row) => sum + row.count, 0);
  const thresholdBreached = failures24h > SWEEP_FAILURE_THRESHOLD;
  // The infrastructure decision only SETS the disposition and, when it owes a
  // page, composes the alert body; delivery and the single exit are below.
  let webhook: SweepResult["webhook"] = "not_attempted";
  // At most one page per sweep window (compass D17). `let` because the
  // maintenance lane below may merge its key into the same body.
  let alert: SweepAlertFields | null = null;
  if (thresholdBreached) {
    // Read the window BEFORE the POST: the newest recorded alert suppresses
    // this one. Nothing is latched, so a window with no recent row always
    // pages; the cost of overlapping sweeps is one bounded duplicate.
    // Both sides bounded: the stamp must be in the past and inside the trailing
    // window. A clock-ahead row is not evidence of a delivered alert, so it never
    // suppresses the page.
    const lastAlertAt = await readLastAlertAt(db, log, deps.alertUrl);
    const nowMs = Date.now();
    const windowMs = SWEEP_WINDOW_HOURS * 3_600_000;
    const announced =
      lastAlertAt !== null && lastAlertAt <= nowMs && nowMs - lastAlertAt < windowMs;
    if (!announced) {
      alert = {
        event: "ops_sweep_alert",
        failures_24h: failures24h,
        dlq_check: "skipped",
        thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: SWEEP_WINDOW_HOURS },
        stages,
      };
    }
  }
  // 377's maintenance existence signal joins HERE: it reads its own count and
  // decides on its own, and when it owes a page it extends this same body with
  // its key, so both alerts travel in ONE POST. Neither decision may return
  // above this point — a healthy infrastructure total must not skip that lane.
  if (alert !== null) {
    log.warn(alert, "review failure threshold breached");
    if (!deps.alertUrl) {
      webhook = "absent";
    } else {
      // POST FIRST, append the audit row only for a delivered alert. A row
      // written before the POST would let a terminated invocation suppress the
      // only alert this breach ever sends; one written after a 2xx can at worst
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
          signal: AbortSignal.timeout(SWEEP_WEBHOOK_TIMEOUT_MS),
        });
        if (!response.ok) {
          // Non-2xx = NOT posted: the sink rejected the alert. Throw a synthetic
          // status-only error (never the URL or body) so the shared catch path
          // below emits the warn and the "failed" disposition.
          throw new Error(`alert webhook POST returned HTTP ${response.status}`);
        }
        webhook = "posted";
        // The alert IS delivered; only now is it recorded. The append never
        // changes this disposition.
        await appendAlertAudit(db, alert, log, deps.alertUrl);
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
        // the next breaching sweep retries.
        webhook = "failed";
      }
    }
  }

  return { failures24h, thresholdBreached, invitesExpired, webhook };
}
