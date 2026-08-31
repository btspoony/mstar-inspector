-- 0011_webhook_deliveries.sql — per-App webhook delivery log (plan 20 Task 1,
-- architect verdict AL-20-1, iteration spec v0.8-platform-insights §4).
--
-- webhook_deliveries: one row per VERIFIED per-App webhook delivery — the
-- R2 diagnostics face ("断线看得见"). Written best-effort at the per-App
-- webhook face immediately after classifyWebhook returns (before the reject
-- return), so EVERY classified outcome lands: ok / paused / ignored /
-- rejected. The legacy /webhook face deliberately records NOTHING
-- (AL-20-1: legacy 不落行 — it is the fallback path with no dashboard
-- consumer, and app_id is NOT NULL FK).
--
-- outcome vocabulary is enforced PRODUCER-side
-- (src/dashboard/apps-store.ts DELIVERY_OUTCOMES, 0010 FAILURE_STAGES
-- precedent) — no CHECK constraint.
--
-- event_name is NULLable: the x-github-event header may be absent.
-- status_code is NULLable: only the rejected outcome carries the
-- classifier's status (400|401|500); ok/paused/ignored are 2xx by
-- construction and store NULL.
--
-- Append-only: creates a new table + index only, touches no existing table.
-- Forward-only (SQLite has no down). idx_webhook_deliveries_app_created
-- serves the dashboard's per-App recent/summary reads (AL-20-1: no
-- deliverable_hint column).

CREATE TABLE webhook_deliveries (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  event_name  TEXT,
  outcome     TEXT NOT NULL,
  status_code INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhook_deliveries_app_created ON webhook_deliveries (app_id, created_at);
