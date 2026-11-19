-- 0076_sweep_query_indexes.sql — index the webhook retention and alert lookups.
--
-- The delivery sweep filters by time across all bots; the alert sweep finds
-- the newest timestamp for a single action.
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries (created_at);
CREATE INDEX platform_audit_events_action_created ON platform_audit_events (action, created_at);
