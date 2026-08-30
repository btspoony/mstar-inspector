-- 0010_review_failures.sql — review failure event log (plan 18 Task 2,
-- architect verdicts AL-1 + AL-6, iteration spec m3-production-grade §2.2/§4).
--
-- review_failures: one row per FAILED review ATTEMPT — the single failure
-- signal table for the plan-19 ops sweep (AL-6: without it, DLQ-bound infra
-- failures leave zero D1 trace). Two producer paths:
--   * parse-fail degrade (AL-1): stage = "parse", written on the ack path —
--     parseReviewOutput is a pure function of run.stdout, so retry is
--     deterministic waste and the message acks after recording.
--   * infra failures (runner non-zero exit / sandbox errors / pipeline
--     orchestration): stage = "runner" | "sandbox" | "pipeline", written
--     best-effort at the consumer's catch site BEFORE the rethrow — the
--     throw→retry→DLQ semantics are unchanged, so a DLQ'd message leaves up
--     to 3 rows (one per attempt). `error` carries the attempt's structured
--     error detail (the same string the failure log line carries).
--
-- stage vocabulary is enforced PRODUCER-side (src/store/failure-store.ts
-- FAILURE_STAGES, 0009 precedent) — no CHECK constraint.
--
-- head_sha is NOT NULL but may be "": a failure before the checkout's
-- rev-parse (credential/config/sandbox acquisition) has no authoritative sha
-- yet; the row then carries the payload sha or "" ("" = never resolved).
-- Unlike reviews (0001 CHECK head_sha <> ''), a failure row exists precisely
-- for the runs that never produced a reviewable sha.
--
-- Era model (0002) untouched: this is a SEPARATE table — it never writes
-- `reviews`, and `reviews.envelope IS NOT NULL ⇔ v1 row` stays the only era
-- 判代. No FK to reviews: a failure row by definition has no review row.
--
-- Append-only: creates a new table + index only, touches no existing table.
-- Forward-only (SQLite has no down). idx_review_failures_created serves the
-- sweep's "last 24h" window scan (AL-6).

CREATE TABLE review_failures (
  id              TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  stage           TEXT NOT NULL,
  error           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_review_failures_created ON review_failures (created_at);
