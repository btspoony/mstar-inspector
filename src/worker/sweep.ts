/**
 * Ops failure sweep (plan 19 Task 1, architect verdict AL-6) — the cron
 * handler's read-only scan: count `review_failures` rows over the trailing
 * 24h across ALL stages (parse + runner/sandbox/pipeline — plan 18 T2's
 * infra-failure rows make this table the sufficient failure signal, closing
 * the "DLQ-bound failure leaves zero D1 trace" blind spot) and alert when
 * the count breaches the threshold.
 *
 * Verdict-pinned boundaries (AL-6, do not widen without a new verdict):
 * - DLQ depth is NOT read: there is no CF API token surface this iteration,
 *   so every alert payload carries `dlq_check: "skipped"` — the failure
 *   table IS the signal, the DLQ is only its overflow destination.
 * - Guard-leak cleanup stays OUT of the sweep: the KV guard TTL is the leak
 *   upper bound (a wrong delete of a live guard is worse than a TTL leak).
 * - Read-only: the sweep queries D1 and emits logs / one optional webhook
 *   POST. It NEVER mutates queue messages, KV keys, or D1 rows.
 *
 * Threshold semantics: PER-ATTEMPT rows — a DLQ'd message leaves up to 3
 * rows (one per attempt), so `> 5` trips at roughly 2 fully-failed messages
 * inside the window. The constants below are the single source (unit-test
 * pinned); making them env-configurable is a future explicit decision.
 */

import type { D1Like } from "../store/types";

/** Breach when `failures_24h > SWEEP_FAILURE_THRESHOLD` (AL-6). */
export const SWEEP_FAILURE_THRESHOLD = 5;

/** Trailing count window in hours (AL-6): `datetime('now', '-24 hours')`. */
export const SWEEP_WINDOW_HOURS = 24;

/** Webhook POST timeout — a hung alert sink must never stall the cron. */
export const SWEEP_WEBHOOK_TIMEOUT_MS = 3000;

/**
 * The structured breach event (ConsumerLog-style JSON line) — also POSTed
 * verbatim to the webhook. `dlq_check` is always "skipped" (AL-6: no CF API
 * token surface); `thresholds` echoes the pinned constants so an alert is
 * self-describing when the constants later move.
 */
export type SweepAlertFields = {
  event: "ops_sweep_alert";
  failures_24h: number;
  dlq_check: "skipped";
  thresholds: { failures_24h: number; window_hours: number };
};

/** Warn fields for the sweep's non-alert paths (WebhookStageWarnLog style). */
export type SweepWarnFields = {
  event: "ops_sweep_alert_webhook_failed" | "ops_sweep_failed" | "ops_sweep_db_unbound";
  detail: string;
};

/** The sweep only ever warns: a quiet system logs nothing. */
export type SweepLog = {
  warn: (fields: SweepAlertFields | SweepWarnFields, msg?: string) => void;
};

/** Default sink: structured JSON lines on stderr. No secrets are logged. */
export const defaultSweepLog: SweepLog = {
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

export type SweepDeps = {
  /** Alert webhook URL (env `ALERT_WEBHOOK_URL`); absent/empty = log-only. */
  alertUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to structured JSON lines. */
  log?: SweepLog;
};

export type SweepResult = {
  failures24h: number;
  thresholdBreached: boolean;
  /** Webhook disposition: absent (unset), posted, failed (warn-logged), or not_attempted (no breach). */
  webhook: "absent" | "posted" | "failed" | "not_attempted";
};

/**
 * Run one sweep: count the trailing-24h failure rows, and on breach emit the
 * `ops_sweep_alert` structured event + optionally POST it to `alertUrl`
 * (JSON body, SWEEP_WEBHOOK_TIMEOUT_MS timeout). A webhook failure degrades
 * to a warn log — it NEVER throws (the alert must not take down the cron
 * that produced it). D1 errors DO propagate to the caller (the `scheduled`
 * handler wraps the whole sweep in try/catch).
 */
export async function runSweep(db: D1Like, deps: SweepDeps = {}): Promise<SweepResult> {
  const log = deps.log ?? defaultSweepLog;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM review_failures WHERE created_at > datetime('now', '-24 hours')`)
    .first<{ n: number }>();
  const failures24h = row?.n ?? 0;
  const thresholdBreached = failures24h > SWEEP_FAILURE_THRESHOLD;
  if (!thresholdBreached) {
    return { failures24h, thresholdBreached, webhook: "not_attempted" };
  }

  const alert: SweepAlertFields = {
    event: "ops_sweep_alert",
    failures_24h: failures24h,
    dlq_check: "skipped",
    thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: SWEEP_WINDOW_HOURS },
  };
  log.warn(alert, "review failure threshold breached");
  if (!deps.alertUrl) {
    return { failures24h, thresholdBreached, webhook: "absent" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    await fetchImpl(deps.alertUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(SWEEP_WEBHOOK_TIMEOUT_MS),
    });
    return { failures24h, thresholdBreached, webhook: "posted" };
  } catch (error) {
    log.warn(
      { event: "ops_sweep_alert_webhook_failed", detail: error instanceof Error ? error.message : String(error) },
      "alert webhook POST failed — log-only alert stands",
    );
    return { failures24h, thresholdBreached, webhook: "failed" };
  }
}
