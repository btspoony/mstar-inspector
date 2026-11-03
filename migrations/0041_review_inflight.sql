-- 0041_review_inflight.sql — per-PR review lock and capacity reservation.
--
-- One row per REVIEW IN FLIGHT. The row is BOTH the per-PR mutex and the
-- capacity reservation (iteration spec review-concurrency §1.2): acquisition
-- is one conditional INSERT, so D1's single-writer serialization makes the
-- "no row for this PR, under both caps" check and the write atomic. There is
-- no separate counter table and no read-then-write window.
--
-- PRIMARY KEY (installation_id, owner, repo, pr_number) is the per-PR lock
-- (spec §1.1: never configurable). It is keyed WITHOUT head_sha on purpose —
-- a comment-mention job carries no sha and must still serialize against the
-- same PR.
--
-- `workspace_id` is the tenant the message resolves to (the App's workspace),
-- so the workspace cap counts rows without a join.
--
-- `attempt_id` is the release fence (spec §1.4): an attempt deletes only its
-- own row, so a later attempt that reclaimed an expired row can never have it
-- deleted by the previous one. The pair (`acquired_at`, `expires_at`) is the
-- TTL (spec §1.5): expired rows are not counted toward the caps and are
-- replaced in place by the next acquire.
--
-- Timestamp contract: `acquired_at` / `expires_at` are TEXT in the ISO-8601
-- UTC millisecond form written by `new Date(ms).toISOString()`
-- (`YYYY-MM-DDTHH:MM:SS.sssZ`) — the ONE form the `expires_at > ?` comparisons
-- order correctly as text. A producer writing any other form (epoch, second
-- precision, local offset) silently corrupts both cap counts.
--
-- Retention: there is none yet. A row is deleted only by its own attempt's
-- release, so an attempt that dies without releasing (hard timeout, eviction)
-- leaves one expired row behind per distinct reviewed PR, and those rows
-- accumulate indefinitely. The sweep is read-only by design (it never mutates
-- this table), so reclaiming them needs a future writer — a cron prune or an
-- opportunistic `DELETE ... WHERE expires_at <= ?` on the acquire path. Until
-- then the growth is storage only: both counts filter on `expires_at > now`
-- and the expiry index serves that range scan.
--
-- Indexes: `review_inflight_workspace` serves the workspace-cap count (and any
-- future diagnostics read); `review_inflight_expiry` serves the system-cap
-- count and any expiry prune. Both counts filter on `expires_at > now`.
--
-- Append-only on the production DB: creates one table and two indexes, touches
-- no existing table. Forward-only (SQLite has no down).

CREATE TABLE review_inflight (
  installation_id INTEGER NOT NULL,
  owner           TEXT    NOT NULL,
  repo            TEXT    NOT NULL,
  pr_number       INTEGER NOT NULL,
  workspace_id    TEXT    NOT NULL,
  attempt_id      TEXT    NOT NULL,
  acquired_at     TEXT    NOT NULL,
  expires_at      TEXT    NOT NULL,
  PRIMARY KEY (installation_id, owner, repo, pr_number)
);

CREATE INDEX review_inflight_workspace ON review_inflight(workspace_id, expires_at);
CREATE INDEX review_inflight_expiry ON review_inflight(expires_at);
