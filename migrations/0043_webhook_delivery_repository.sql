-- 0043_webhook_delivery_repository.sql — the delivery's source repository.
--
-- The diagnostics face ("which repo did this delivery come from?") could not
-- be answered from a `webhook_deliveries` row: the payload's `repository` was
-- parsed for classification and then discarded, so every delivery looked
-- repo-less. This column carries the one fact that survives:
-- `owner/name` (`repository.full_name`, or the owner/name pair when the
-- payload states only those).
--
-- Nullable by design: rows written before this migration have no source to
-- backfill from, and a payload without a `repository` block (an install
-- event, a bypass event) genuinely has none. NULL therefore means "unknown
-- source", never "the store lost it".
--
-- Forward-only `ALTER TABLE … ADD COLUMN`: append-only in spirit (no table
-- rewrite, no backfill, existing rows keep reading NULL). SQLite has no down.

ALTER TABLE webhook_deliveries ADD COLUMN repository_full_name TEXT;
